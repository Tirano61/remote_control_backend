import { Injectable, Logger } from '@nestjs/common';
import { SignalingParticipant } from '../interfaces/signaling-participant.interface';

/**
 * Cambio efectivo de participacion de un extremo en una sesion.
 *
 * - `ABSENT`: se fue el ULTIMO socket de ese extremo unido a la sesion.
 * - `PRESENT`: el extremo, que estaba ausente (o nunca habia estado), vuelve a
 *   tener al menos un socket unido.
 *
 * Igual que la presencia de dispositivos, solo se avisa en la transicion: un
 * segundo socket que se une, o uno de varios que se va, no cambia nada.
 */
export enum SessionParticipationChange {
  ABSENT = 'ABSENT',
  PRESENT = 'PRESENT',
}

export interface SessionParticipationEvent {
  remoteSessionId: string;
  participant: SignalingParticipant;
  change: SessionParticipationChange;
  /** Episodio de ausencia; crece en cada `ABSENT`. Solo para trazabilidad. */
  episode: number;
  /** `Date.now()` del momento del cambio. */
  at: number;
}

export type SessionParticipationListener = (
  event: SessionParticipationEvent,
) => void;

interface SideState {
  /** Sockets de este extremo unidos AHORA a la sesion. */
  sockets: Set<string>;
  /** Desde cuando no queda ninguno. `null` mientras haya alguno. */
  absentSince: number | null;
  episode: number;
}

type SessionState = Record<SignalingParticipant, SideState>;

const emptySide = (): SideState => ({
  sockets: new Set(),
  absentSince: null,
  episode: 0,
});

/**
 * Quien participa de verdad en cada sesion remota, en esta instancia.
 *
 * "Participar" es tener al menos un socket AUTENTICADO de ese extremo unido a la
 * room de signaling de la sesion mediante un `remote-session:join` VALIDADO
 * (sesion viva y del que la pide). No es:
 *
 * - tener un socket autenticado (la consola del tecnico abierta, o la tablet
 *   ONLINE, no dicen nada de una sesion concreta);
 * - tener WebRTC conectado: el backend solo transporta signaling y no ve el
 *   peer, asi que no lo finge.
 *
 * Lo alimenta exclusivamente `SignalingService` (join, cambio de sesion y
 * desconexion). La identidad y la sesion salen siempre del socket autenticado y
 * del valor que el servidor escribio en el al validar el join, nunca de un
 * payload. Un cliente no tiene forma de declararse "presente" sin pasar por esa
 * validacion.
 *
 * Varias conexiones: se cuentan sockets, no personas. Dos pestanas del tecnico o
 * el socket viejo y el nuevo de una tablet que reconecta son dos entradas; el
 * extremo solo queda ausente cuando se va la ultima. Un socket solo puede
 * borrarse a si mismo (por su id), asi que la desconexion tardia de un socket
 * viejo nunca anula la presencia del nuevo, y como borrarse no "recupera" nada,
 * tampoco puede cancelar la gracia de una sesion.
 *
 * En memoria y por instancia, igual que `DevicePresenceService`: tras reiniciar
 * el proceso esta vacio y la reconciliacion de arranque lo tiene en cuenta.
 *
 * Sin dependencias a proposito: lo usan el signaling y el ciclo de vida de las
 * sesiones sin que ninguno importe al otro.
 */
@Injectable()
export class SessionParticipationService {
  private readonly logger = new Logger(SessionParticipationService.name);

  private readonly sessions = new Map<string, SessionState>();

  private readonly listeners = new Set<SessionParticipationListener>();

  /** Suscripcion a los cambios efectivos. Devuelve como darse de baja. */
  subscribe(listener: SessionParticipationListener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** Un socket de `participant` quedo unido (join validado) a la sesion. */
  join(
    remoteSessionId: string,
    participant: SignalingParticipant,
    socketId: string,
  ): void {
    const side = this.sideOf(remoteSessionId, participant, true);

    const wasEmpty = side.sockets.size === 0;

    side.sockets.add(socketId);

    if (!wasEmpty) return;

    side.absentSince = null;

    this.emit({
      remoteSessionId,
      participant,
      change: SessionParticipationChange.PRESENT,
      episode: side.episode,
      at: Date.now(),
    });
  }

  /**
   * El socket dejo la sesion (se desconecto o se unio a otra).
   *
   * Un socket que no estaba registrado no cambia nada: baja repetida, o sesion
   * ya olvidada porque se cerro.
   */
  leave(
    remoteSessionId: string,
    participant: SignalingParticipant,
    socketId: string,
  ): void {
    const side = this.sideOf(remoteSessionId, participant, false);

    if (!side?.sockets.delete(socketId)) return;

    if (side.sockets.size > 0) return;

    side.absentSince = Date.now();
    side.episode += 1;

    this.emit({
      remoteSessionId,
      participant,
      change: SessionParticipationChange.ABSENT,
      episode: side.episode,
      at: side.absentSince,
    });
  }

  /** Si el extremo tiene ahora al menos un socket unido a la sesion. */
  isPresent(
    remoteSessionId: string,
    participant: SignalingParticipant,
  ): boolean {
    return (
      (this.sideOf(remoteSessionId, participant, false)?.sockets.size ?? 0) > 0
    );
  }

  /**
   * Desde cuando falta el extremo, segun lo observado en ESTE proceso.
   *
   * `null` si esta presente o si nunca se le vio unido desde el arranque: quien
   * consulta decide la referencia en ese caso (arranque o `connectedAt`).
   */
  absentSince(
    remoteSessionId: string,
    participant: SignalingParticipant,
  ): number | null {
    return (
      this.sideOf(remoteSessionId, participant, false)?.absentSince ?? null
    );
  }

  /** Cantidad de sockets unidos. Solo para logs y pruebas. */
  socketCount(
    remoteSessionId: string,
    participant: SignalingParticipant,
  ): number {
    return this.sideOf(remoteSessionId, participant, false)?.sockets.size ?? 0;
  }

  /**
   * Olvida una sesion que ya no esta viva. Los sockets que sigan apuntandola se
   * daran de baja sin efecto: el signaling revalida la sesion en cada mensaje.
   */
  forget(remoteSessionId: string): void {
    this.sessions.delete(remoteSessionId);
  }

  private sideOf(
    remoteSessionId: string,
    participant: SignalingParticipant,
    create: true,
  ): SideState;
  private sideOf(
    remoteSessionId: string,
    participant: SignalingParticipant,
    create: false,
  ): SideState | undefined;
  private sideOf(
    remoteSessionId: string,
    participant: SignalingParticipant,
    create: boolean,
  ): SideState | undefined {
    let session = this.sessions.get(remoteSessionId);

    if (!session && create) {
      session = {
        [SignalingParticipant.DEVICE]: emptySide(),
        [SignalingParticipant.TECHNICIAN]: emptySide(),
      };
      this.sessions.set(remoteSessionId, session);
    }

    return session?.[participant];
  }

  /** Un listener que falla no puede romper el join ni la desconexion. */
  private emit(event: SessionParticipationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          `Participation listener failed for remote session ${event.remoteSessionId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
