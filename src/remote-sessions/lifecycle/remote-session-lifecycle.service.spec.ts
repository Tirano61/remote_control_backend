import { Logger } from '@nestjs/common';
import {
  REMOTE_SESSION_EVALUATION_RETRY_MS,
  RemoteSessionLifecycleConfig,
} from '../../config/remote-session-lifecycle.config';
import { SignalingParticipant } from '../../signaling/interfaces/signaling-participant.interface';
import { SessionParticipationService } from '../../signaling/participation/session-participation.service';
import { RemoteSession } from '../entities/remote-session.entity';
import { RemoteSessionEndedBy } from '../enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from '../enums/remote-session-status.enum';
import type {
  RemoteSessionChangeListener,
  RemoteSessionLifecycleSnapshot,
  RemoteSessionsService,
  SystemCloseDecision,
} from '../remote-sessions.service';
import { RemoteSessionLifecycleService } from './remote-session-lifecycle.service';

/**
 * Politica de cierre automatico con reloj falso.
 *
 * El registro de participacion es el real. `RemoteSessionsService` se sustituye
 * por un doble que reproduce lo que importa aqui: la lectura de sesiones vivas,
 * los avisos de cambio y `closeBySystem`, que decide con la fila "bloqueada"
 * (el estado del doble en ese instante) y cierra una sola vez. La transaccion,
 * el lock real y las notificaciones Socket.IO estan cubiertos en
 * `remote-sessions.service.spec.ts` y en las pruebas realtime/PostgreSQL.
 */

const { DEVICE, TECHNICIAN } = SignalingParticipant;

const T0 = new Date('2026-11-17T10:00:00.000Z').getTime();

const GRACE = 60_000;
const TTL = 120_000;

const config = (startupRecoveryMs = 5_000): RemoteSessionLifecycleConfig => ({
  disconnectGraceMs: GRACE,
  connectingTtlMs: TTL,
  startupRecoveryMs,
});

class FakeRemoteSessions {
  rows: RemoteSession[] = [];
  listeners = new Set<RemoteSessionChangeListener>();
  closeAttempts = 0;
  /** Se ejecuta con la fila "bloqueada", justo antes de decidir. */
  beforeDecide: (() => void) | null = null;
  failNextReads = 0;

  onSessionChanged(listener: RemoteSessionChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  findLiveSessions(): Promise<RemoteSessionLifecycleSnapshot[]> {
    if (this.failNextReads > 0) {
      this.failNextReads -= 1;
      return Promise.reject(new Error('PostgreSQL no responde'));
    }

    return Promise.resolve(
      this.rows
        .filter((row) => row.status !== RemoteSessionStatus.CLOSED)
        .map((row) => ({ ...row })),
    );
  }

  findLiveSession(id: string): Promise<RemoteSessionLifecycleSnapshot | null> {
    if (this.failNextReads > 0) {
      this.failNextReads -= 1;
      return Promise.reject(new Error('PostgreSQL no responde'));
    }

    const row = this.rows.find(
      (candidate) =>
        candidate.id === id && candidate.status !== RemoteSessionStatus.CLOSED,
    );

    return Promise.resolve(row ? { ...row } : null);
  }

  async closeBySystem(
    id: string,
    decide: SystemCloseDecision,
  ): Promise<RemoteSession | null> {
    this.closeAttempts += 1;

    // Una vuelta al event loop, como la espera del lock.
    await Promise.resolve();

    this.beforeDecide?.();

    const row = this.rows.find((candidate) => candidate.id === id);

    if (!row || row.status === RemoteSessionStatus.CLOSED) return null;

    if (!decide({ ...row }, new Date())) return null;

    Object.assign(row, {
      status: RemoteSessionStatus.CLOSED,
      endedAt: new Date(),
      endedBy: RemoteSessionEndedBy.SYSTEM,
    });

    this.emit(row);

    return { ...row };
  }

  /** Lo que haria `RemoteSessionsService` al confirmar un cambio. */
  emit(row: RemoteSession): void {
    for (const listener of this.listeners) listener({ ...row });
  }

  create(id: string, createdAt = Date.now()): RemoteSession {
    const row = {
      id,
      supportRequestId: `sr-${id}`,
      deviceId: 'device-1',
      technicianId: 'technician-1',
      status: RemoteSessionStatus.CONNECTING,
      createdAt: new Date(createdAt),
      connectedAt: null,
      endedAt: null,
      endedBy: null,
    } as RemoteSession;

    this.rows.push(row);
    this.emit(row);

    return row;
  }

  activate(id: string): void {
    const row = this.row(id);
    Object.assign(row, {
      status: RemoteSessionStatus.ACTIVE,
      connectedAt: new Date(),
    });
    this.emit(row);
  }

  closeManually(id: string, endedBy: RemoteSessionEndedBy): void {
    const row = this.row(id);
    Object.assign(row, {
      status: RemoteSessionStatus.CLOSED,
      endedAt: new Date(),
      endedBy,
    });
    this.emit(row);
  }

  row(id: string): RemoteSession {
    return this.rows.find((row) => row.id === id) as RemoteSession;
  }
}

describe('RemoteSessionLifecycleService', () => {
  let sessions: FakeRemoteSessions;
  let participation: SessionParticipationService;
  let lifecycle: RemoteSessionLifecycleService;
  let logs: string[];

  const build = (startupRecoveryMs?: number) => {
    lifecycle = new RemoteSessionLifecycleService(
      sessions as unknown as RemoteSessionsService,
      participation,
      config(startupRecoveryMs),
    );
    lifecycle.onModuleInit();
    lifecycle.onApplicationBootstrap();
  };

  const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

  /** Sesion ACTIVE con los dos extremos unidos. */
  const activeSession = async (id = 'session-1'): Promise<RemoteSession> => {
    sessions.create(id);
    participation.join(id, TECHNICIAN, 'tab-1');
    participation.join(id, DEVICE, 'tablet-1');
    sessions.activate(id);
    await advance(0);
    return sessions.row(id);
  };

  beforeEach(async () => {
    jest.useFakeTimers({ now: T0 });
    sessions = new FakeRemoteSessions();
    participation = new SessionParticipationService();
    logs = [];
    for (const method of ['log', 'warn', 'error'] as const)
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((message: unknown) => {
          logs.push(String(message));
        });

    build();
    // Fuera de la ventana de recuperacion: comportamiento normal.
    await advance(5_000);
  });

  afterEach(() => {
    lifecycle.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('desconexion del tecnico', () => {
    it('1. al irse su ultimo socket empieza la gracia, sin cerrar todavia', async () => {
      const session = await activeSession();

      expect(lifecycle.scheduledAt(session.id)).toBeNull();

      participation.leave(session.id, TECHNICIAN, 'tab-1');

      expect(lifecycle.scheduledAt(session.id)).toBe(Date.now() + GRACE);
      expect(logs.some((log) => log.includes('Grace period started'))).toBe(
        true,
      );

      await advance(GRACE - 1);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    });

    it('2. si vuelve a unirse dentro de la gracia, la sesion sigue ACTIVE', async () => {
      const session = await activeSession();

      participation.leave(session.id, TECHNICIAN, 'tab-1');
      await advance(30_000);
      participation.join(session.id, TECHNICIAN, 'tab-1-reconnected');
      await advance(GRACE);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(sessions.closeAttempts).toBe(0);
      expect(logs.some((log) => log.includes('recovered participation'))).toBe(
        true,
      );
      expect(logs.some((log) => log.includes('discarded'))).toBe(true);
    });

    it('3. si no vuelve, la sesion se cierra con SYSTEM al vencer la gracia', async () => {
      const session = await activeSession();

      participation.leave(session.id, TECHNICIAN, 'tab-1');
      await advance(GRACE);

      expect(session).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });
      expect(
        logs.some((log) => log.includes(`closed by SYSTEM: TECHNICIAN_ABSENT`)),
      ).toBe(true);
      expect(lifecycle.scheduledAt(session.id)).toBeNull();
      // La sesion se olvida tambien en el registro de participantes.
      expect(participation.isPresent(session.id, DEVICE)).toBe(false);
    });
  });

  describe('desconexion de la tablet', () => {
    it('4. al irse su ultimo socket empieza la gracia', async () => {
      const session = await activeSession();

      participation.leave(session.id, DEVICE, 'tablet-1');

      expect(lifecycle.scheduledAt(session.id)).toBe(Date.now() + GRACE);
      await advance(GRACE - 1);
      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    });

    it('5. si vuelve a unirse dentro de la gracia, la sesion sigue ACTIVE', async () => {
      const session = await activeSession();

      participation.leave(session.id, DEVICE, 'tablet-1');
      await advance(45_000);
      participation.join(session.id, DEVICE, 'tablet-2');
      await advance(GRACE);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    });

    it('6. si sigue fuera, la sesion se cierra con SYSTEM (DEVICE_ABSENT)', async () => {
      const session = await activeSession();

      participation.leave(session.id, DEVICE, 'tablet-1');
      await advance(GRACE);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
      expect(
        logs.some((log) => log.includes('closed by SYSTEM: DEVICE_ABSENT')),
      ).toBe(true);
    });
  });

  describe('varios sockets', () => {
    it('7. desconexion parcial: queda otra pestana unida y no se programa nada', async () => {
      const session = await activeSession();
      participation.join(session.id, TECHNICIAN, 'tab-2');

      participation.leave(session.id, TECHNICIAN, 'tab-1');
      await advance(TTL * 2);

      expect(lifecycle.scheduledAt(session.id)).toBeNull();
      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(sessions.closeAttempts).toBe(0);
    });

    it('8. la desconexion tardia del socket viejo no abre una gracia ni cierra', async () => {
      const session = await activeSession();

      // Reconexion de la tablet: el socket nuevo ya se unio cuando cae el viejo.
      participation.join(session.id, DEVICE, 'tablet-2');
      participation.leave(session.id, DEVICE, 'tablet-1');
      await advance(TTL * 2);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(sessions.closeAttempts).toBe(0);
    });

    it('un hueco entre el socket viejo y el join del nuevo se recupera sin cerrar', async () => {
      const session = await activeSession();

      participation.leave(session.id, DEVICE, 'tablet-1');
      await advance(2_000);
      participation.join(session.id, DEVICE, 'tablet-2');
      await advance(GRACE);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    });
  });

  describe('TTL de CONNECTING', () => {
    it('9. vence desde createdAt y cierra con SYSTEM (CONNECTING_TTL)', async () => {
      const session = sessions.create('session-1');

      expect(lifecycle.scheduledAt(session.id)).toBe(
        session.createdAt.getTime() + TTL,
      );

      await advance(TTL - 1);
      expect(session.status).toBe(RemoteSessionStatus.CONNECTING);

      await advance(1);

      expect(session).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });
      expect(
        logs.some((log) => log.includes('closed by SYSTEM: CONNECTING_TTL')),
      ).toBe(true);
    });

    it('vence aunque los dos extremos sigan unidos: el signaling no lo renueva', async () => {
      const session = sessions.create('session-1');
      participation.join(session.id, TECHNICIAN, 'tab-1');
      participation.join(session.id, DEVICE, 'tablet-1');

      // Signaling repetido: entradas y salidas de sockets no mueven el TTL.
      for (let i = 0; i < 5; i += 1) {
        await advance(20_000);
        participation.join(session.id, TECHNICIAN, `tab-extra-${i}`);
      }

      await advance(TTL);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    });

    it('10. si pasa a ACTIVE antes, el TTL no la toca', async () => {
      const session = sessions.create('session-1');
      participation.join(session.id, TECHNICIAN, 'tab-1');
      participation.join(session.id, DEVICE, 'tablet-1');

      await advance(30_000);
      sessions.activate(session.id);

      // Los dos presentes: no queda ningun vencimiento.
      expect(lifecycle.scheduledAt(session.id)).toBeNull();

      await advance(TTL * 2);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    });

    it('activate llega con la fila bloqueada: el vencimiento se descarta', async () => {
      const session = sessions.create('session-1');
      participation.join(session.id, TECHNICIAN, 'tab-1');
      participation.join(session.id, DEVICE, 'tablet-1');

      // Gana activate justo antes de que el vencimiento tome el lock.
      sessions.beforeDecide = () => {
        session.status = RemoteSessionStatus.ACTIVE;
        session.connectedAt = new Date();
      };

      await advance(TTL);

      expect(sessions.closeAttempts).toBe(1);
      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(logs.some((log) => log.includes('discarded: state changed'))).toBe(
        true,
      );
    });
  });

  describe('concurrencia e idempotencia', () => {
    it('11. dos evaluaciones simultaneas cierran una sola vez', async () => {
      const session = await activeSession();
      participation.leave(session.id, TECHNICIAN, 'tab-1');
      await advance(GRACE - 10);
      jest.setSystemTime(Date.now() + 10);

      await Promise.all([
        lifecycle.evaluate(session.id),
        lifecycle.evaluate(session.id),
      ]);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
      expect(
        logs.filter((log) => log.includes('closed by SYSTEM')),
      ).toHaveLength(1);
    });

    it('12. si el tecnico cierra antes de vencer, el vencimiento no hace nada', async () => {
      const session = await activeSession();
      participation.leave(session.id, DEVICE, 'tablet-1');

      await advance(GRACE / 2);
      sessions.closeManually(session.id, RemoteSessionEndedBy.TECHNICIAN);

      expect(lifecycle.scheduledAt(session.id)).toBeNull();

      await advance(GRACE);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.TECHNICIAN);
      expect(sessions.closeAttempts).toBe(0);
    });

    it('12b. si el dispositivo cierra mientras el vencimiento espera el lock, gana el dispositivo', async () => {
      const session = await activeSession();
      participation.leave(session.id, TECHNICIAN, 'tab-1');

      sessions.beforeDecide = () => {
        Object.assign(session, {
          status: RemoteSessionStatus.CLOSED,
          endedBy: RemoteSessionEndedBy.DEVICE,
        });
      };

      await advance(GRACE);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.DEVICE);
      expect(logs.some((log) => log.includes('closed by SYSTEM'))).toBe(false);
    });

    it('el participante vuelve justo mientras se toma el lock: no se cierra', async () => {
      const session = await activeSession();
      participation.leave(session.id, TECHNICIAN, 'tab-1');

      sessions.beforeDecide = () =>
        participation.join(session.id, TECHNICIAN, 'tab-1-late');

      await advance(GRACE);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    });

    it('13. una sesion ya CLOSED no se evalua para cerrar', async () => {
      const session = await activeSession();
      sessions.closeManually(session.id, RemoteSessionEndedBy.DEVICE);

      await lifecycle.evaluate(session.id);

      expect(sessions.closeAttempts).toBe(0);
      expect(session.endedBy).toBe(RemoteSessionEndedBy.DEVICE);
    });

    it('14. el timer de una sesion vieja no cierra la sesion nueva', async () => {
      const old = await activeSession('session-old');
      participation.leave(old.id, TECHNICIAN, 'tab-1');

      // La sesion vieja se cierra a mano y el mismo tecnico abre otra.
      sessions.closeManually(old.id, RemoteSessionEndedBy.TECHNICIAN);
      const fresh = await activeSession('session-new');

      // Aunque el timer viejo se disparara, solo evalua su propia sesion.
      await lifecycle.evaluate(old.id);
      await advance(GRACE * 2);

      expect(fresh.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(old.endedBy).toBe(RemoteSessionEndedBy.TECHNICIAN);
    });

    it('un vencimiento de un episodio anterior se reprograma al vigente', async () => {
      const session = await activeSession();

      participation.leave(session.id, TECHNICIAN, 'tab-1');
      await advance(50_000);
      participation.join(session.id, TECHNICIAN, 'tab-2');
      await advance(5_000);
      participation.leave(session.id, TECHNICIAN, 'tab-2');

      // Vence el timer del primer episodio: no corresponde todavia.
      await advance(5_000);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(logs.some((log) => log.includes('is stale'))).toBe(true);

      // El segundo episodio si vence a su hora.
      await advance(GRACE);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    });

    it('si la evaluacion falla, se reintenta sin perder el cierre', async () => {
      const session = await activeSession();
      participation.leave(session.id, TECHNICIAN, 'tab-1');
      sessions.failNextReads = 1;

      await advance(GRACE);

      expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(logs.some((log) => log.includes('retrying'))).toBe(true);

      await advance(REMOTE_SESSION_EVALUATION_RETRY_MS);

      expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    });
  });

  describe('15. reconciliacion tras reinicio', () => {
    const RECOVERY = 90_000;

    const restart = async (): Promise<void> => {
      lifecycle.onModuleDestroy();
      // El proceso nuevo arranca con el registro vacio.
      participation = new SessionParticipationService();
      build(RECOVERY);
      await advance(0);
    };

    it('no cierra nada al arrancar y respeta la ventana de recuperacion', async () => {
      const recovered = await activeSession('active-recovered');
      const abandoned = await activeSession('active-abandoned');
      const stuck = sessions.create('connecting-stuck', T0 - 10 * 60_000);

      await restart();

      expect(
        logs.some((log) => log.includes('Startup reconciliation: 3')),
      ).toBe(true);

      // Los clientes de una sesion vuelven a unirse; los de la otra, no.
      await advance(20_000);
      participation.join(recovered.id, TECHNICIAN, 'tab-new');
      participation.join(recovered.id, DEVICE, 'tablet-new');

      await advance(RECOVERY - 20_000 - 1);

      for (const session of [recovered, abandoned, stuck])
        expect(session.status).not.toBe(RemoteSessionStatus.CLOSED);

      await advance(1);

      expect(recovered.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(abandoned.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
      // El TTL de CONNECTING vencio durante la caida: se cierra al final de la
      // ventana, no en el primer instante.
      expect(stuck.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
      expect(
        logs.some((log) => log.includes('not recovered after backend restart')),
      ).toBe(true);
    });

    it('si PostgreSQL no responde al arrancar, la reconciliacion se reintenta', async () => {
      const abandoned = await activeSession('active-abandoned');
      sessions.failNextReads = 1;

      await restart();

      expect(
        logs.some((log) => log.includes('Startup reconciliation could')),
      ).toBe(true);

      await advance(REMOTE_SESSION_EVALUATION_RETRY_MS + RECOVERY);

      expect(abandoned.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    });
  });

  it('al destruirse no deja timers pendientes ni sigue escuchando', async () => {
    const session = await activeSession();
    participation.leave(session.id, TECHNICIAN, 'tab-1');

    lifecycle.onModuleDestroy();
    await advance(GRACE * 2);

    expect(session.status).toBe(RemoteSessionStatus.ACTIVE);
    expect(jest.getTimerCount()).toBe(0);
  });
});
