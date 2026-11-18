import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  REMOTE_SESSION_EVALUATION_RETRY_MS,
  REMOTE_SESSION_LIFECYCLE_CONFIG,
  type RemoteSessionLifecycleConfig,
} from '../../config/remote-session-lifecycle.config';
import {
  SessionParticipationChange,
  SessionParticipationEvent,
  SessionParticipationService,
} from '../../signaling/participation/session-participation.service';
import { RemoteSessionStatus } from '../enums/remote-session-status.enum';
import {
  RemoteSessionLifecycleSnapshot,
  RemoteSessionsService,
} from '../remote-sessions.service';
import { ExpiryDeadline, nextExpiry } from './remote-session-expiry.policy';

interface ScheduledCheck {
  at: number;
  handle: ReturnType<typeof setTimeout>;
}

const iso = (at: number): string => new Date(at).toISOString();

/**
 * Cierre automatico de sesiones remotas abandonadas (`endedBy = SYSTEM`).
 *
 * PostgreSQL es la autoridad: los timers de aqui solo deciden CUANDO volver a
 * mirar. Cada vencimiento relee la sesion, recalcula con `nextExpiry` y, si
 * corresponde, cierra con `RemoteSessionsService.closeBySystem`, que vuelve a
 * decidir con la fila bloqueada. Un timer obsoleto, por tanto, como mucho hace
 * una lectura de mas: nunca cierra una sesion que ya no cumple la condicion, ni
 * una sesion distinta (todo va por id).
 *
 * De donde salen los vencimientos (sin sondeo periodico de la base de datos):
 *
 * - al arrancar: una consulta de las sesiones vivas, que quedan programadas
 *   para despues de la ventana de recuperacion;
 * - al crear una sesion: su TTL de CONNECTING;
 * - al activarla o cerrarla: se recalcula o se olvida;
 * - cuando el ULTIMO socket de un extremo deja la sesion: su gracia;
 * - si una evaluacion falla (por ejemplo, PostgreSQL no responde): reintento.
 *
 * Todas las sesiones nacen en `RemoteSessionsService.create`, asi que no hay
 * ninguna que quede sin vencimiento programado. No se sondea la base de datos
 * con un intervalo fijo a proposito: con Neon, una consulta periodica
 * mantendria el computo despierto todo el tiempo sin aportar nada.
 *
 * Los timers se pierden al reiniciar el proceso, y eso esta contemplado: la
 * reconciliacion de arranque los reconstruye desde PostgreSQL.
 */
@Injectable()
export class RemoteSessionLifecycleService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RemoteSessionLifecycleService.name);

  /** Desde cuando cuenta la ventana de recuperacion. */
  private startedAt = Date.now();

  private readonly checks = new Map<string, ScheduledCheck>();

  private readonly unsubscribers: Array<() => void> = [];

  private destroyed = false;

  /** Reintento pendiente de la reconciliacion de arranque. */
  private retryHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly remoteSessionsService: RemoteSessionsService,
    private readonly sessionParticipationService: SessionParticipationService,
    @Inject(REMOTE_SESSION_LIFECYCLE_CONFIG)
    private readonly config: RemoteSessionLifecycleConfig,
  ) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.sessionParticipationService.subscribe((event) =>
        this.onParticipationChanged(event),
      ),
      this.remoteSessionsService.onSessionChanged((session) =>
        this.onSessionChanged(session),
      ),
    );
  }

  /**
   * La ventana de recuperacion empieza aqui, lo mas cerca posible de que el
   * servidor acepte conexiones. La reconciliacion no bloquea el arranque.
   */
  onApplicationBootstrap(): void {
    this.startedAt = Date.now();

    void this.reconcileAtStartup();
  }

  onModuleDestroy(): void {
    this.destroyed = true;

    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();

    for (const check of this.checks.values()) clearTimeout(check.handle);

    this.checks.clear();

    if (this.retryHandle) clearTimeout(this.retryHandle);

    this.retryHandle = null;
  }

  /**
   * Programa la revision de todas las sesiones vivas que encontro PostgreSQL.
   *
   * No cierra nada en el momento: nadie ha tenido todavia ocasion de volver a
   * unirse. Las sesiones quedan programadas para despues de
   * `startupRecoveryMs`; las CONNECTING cuyo TTL vencio durante la caida,
   * tambien (como pronto al final de la ventana).
   */
  async reconcileAtStartup(): Promise<void> {
    let sessions: RemoteSessionLifecycleSnapshot[];

    try {
      sessions = await this.remoteSessionsService.findLiveSessions();
    } catch (error) {
      this.logger.error(
        `Startup reconciliation could not read live remote sessions; retrying in ${REMOTE_SESSION_EVALUATION_RETRY_MS} ms`,
        error instanceof Error ? error.stack : undefined,
      );

      this.retryLater(() => void this.reconcileAtStartup());

      return;
    }

    const connecting = sessions.filter(
      (session) => session.status === RemoteSessionStatus.CONNECTING,
    ).length;

    this.logger.log(
      `Startup reconciliation: ${sessions.length} live remote session(s) (${connecting} CONNECTING, ${sessions.length - connecting} ACTIVE); recovery window until ${iso(this.startedAt + this.config.startupRecoveryMs)}`,
    );

    for (const session of sessions) this.scheduleFrom(session);
  }

  /**
   * Revisa una sesion y la cierra si su vencimiento llego.
   *
   * Publico para poder probarlo; en produccion lo llaman solo los timers.
   */
  async evaluate(remoteSessionId: string): Promise<void> {
    try {
      const session =
        await this.remoteSessionsService.findLiveSession(remoteSessionId);

      if (!session) {
        this.forget(remoteSessionId);
        return;
      }

      const due = this.expiryOf(session);

      if (!due) {
        this.logger.log(
          `Expiry check discarded for remote session ${remoteSessionId}: every participant is present`,
        );
        return;
      }

      if (due.at > Date.now()) {
        // El vencimiento que disparo este timer quedo obsoleto: el participante
        // volvio y se fue de nuevo (otro episodio), o la sesion se activo. Se
        // reprograma al vencimiento vigente.
        this.logger.log(
          `Expiry check of remote session ${remoteSessionId} is stale; next check at ${iso(due.at)} (${due.reason})`,
        );
        this.schedule(remoteSessionId, due.at);
        return;
      }

      // La decision definitiva se toma con la fila bloqueada.
      const decision: { deadline: ExpiryDeadline | null } = { deadline: null };

      const closed = await this.remoteSessionsService.closeBySystem(
        remoteSessionId,
        (locked, now) => {
          const current = this.expiryOf(locked);

          if (!current || current.at > now.getTime()) return false;

          decision.deadline = current;

          return true;
        },
      );

      if (closed) {
        const reason = decision.deadline ?? due;

        this.logger.warn(
          `Remote session ${remoteSessionId} closed by SYSTEM: ${reason.reason}${reason.afterStartup ? ' (not recovered after backend restart)' : ''}; device ${closed.deviceId}, technician ${closed.technicianId}`,
        );

        this.forget(remoteSessionId);
        return;
      }

      // Con la fila bloqueada ya no correspondia: se activo, se cerro por otra
      // via o un participante volvio en el ultimo instante.
      this.logger.log(
        `Expiry of remote session ${remoteSessionId} (${due.reason}) discarded: state changed before closing`,
      );

      const after =
        await this.remoteSessionsService.findLiveSession(remoteSessionId);

      if (after) this.scheduleFrom(after);
      else this.forget(remoteSessionId);
    } catch (error) {
      this.logger.error(
        `Expiry check of remote session ${remoteSessionId} failed; retrying in ${REMOTE_SESSION_EVALUATION_RETRY_MS} ms`,
        error instanceof Error ? error.stack : undefined,
      );

      this.schedule(
        remoteSessionId,
        Date.now() + REMOTE_SESSION_EVALUATION_RETRY_MS,
      );
    }
  }

  /** Momento programado para revisar la sesion. Solo para pruebas y logs. */
  scheduledAt(remoteSessionId: string): number | null {
    return this.checks.get(remoteSessionId)?.at ?? null;
  }

  // ---------------------------------------------------------------------------

  private onParticipationChanged(event: SessionParticipationEvent): void {
    const { remoteSessionId, participant, episode } = event;

    if (event.change === SessionParticipationChange.ABSENT) {
      const at = Math.max(
        event.at + this.config.disconnectGraceMs,
        this.startedAt + this.config.startupRecoveryMs,
      );

      this.logger.log(
        `Grace period started: ${participant} has no socket joined to remote session ${remoteSessionId} (episode ${episode}); re-checked at ${iso(at)}`,
      );

      this.schedule(remoteSessionId, at);
      return;
    }

    if (episode > 0)
      this.logger.log(
        `${participant} recovered participation in remote session ${remoteSessionId} (episode ${episode})`,
      );
  }

  private onSessionChanged(session: RemoteSessionLifecycleSnapshot): void {
    if (session.status === RemoteSessionStatus.CLOSED) {
      this.forget(session.id);
      return;
    }

    this.scheduleFrom(session);
  }

  private expiryOf(
    session: RemoteSessionLifecycleSnapshot,
  ): ExpiryDeadline | null {
    return nextExpiry(
      session,
      this.sessionParticipationService,
      this.config,
      this.startedAt,
    );
  }

  /** Programa (o descarta) la revision segun el estado conocido. */
  private scheduleFrom(session: RemoteSessionLifecycleSnapshot): void {
    const due = this.expiryOf(session);

    if (due) this.schedule(session.id, due.at);
    else this.clear(session.id);
  }

  /**
   * Una sola revision pendiente por sesion: la mas temprana. Una posterior no
   * reemplaza a una anterior, porque al dispararse esta se recalcula todo y se
   * reprograma lo que haga falta.
   */
  private schedule(remoteSessionId: string, at: number): void {
    if (this.destroyed) return;

    const existing = this.checks.get(remoteSessionId);

    if (existing && existing.at <= at) return;

    if (existing) clearTimeout(existing.handle);

    const handle = setTimeout(
      () => {
        this.checks.delete(remoteSessionId);
        void this.evaluate(remoteSessionId);
      },
      Math.max(0, at - Date.now()),
    );

    // Un vencimiento pendiente no debe mantener vivo el proceso.
    handle.unref?.();

    this.checks.set(remoteSessionId, { at, handle });
  }

  private clear(remoteSessionId: string): void {
    const existing = this.checks.get(remoteSessionId);

    if (!existing) return;

    clearTimeout(existing.handle);
    this.checks.delete(remoteSessionId);
  }

  /** La sesion ya no esta viva: ni revision pendiente ni participantes. */
  private forget(remoteSessionId: string): void {
    this.clear(remoteSessionId);
    this.sessionParticipationService.forget(remoteSessionId);
  }

  private retryLater(run: () => void): void {
    if (this.destroyed) return;

    if (this.retryHandle) clearTimeout(this.retryHandle);

    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      run();
    }, REMOTE_SESSION_EVALUATION_RETRY_MS);

    this.retryHandle.unref?.();
  }
}
