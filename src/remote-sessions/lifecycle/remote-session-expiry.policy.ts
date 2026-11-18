import { RemoteSessionLifecycleConfig } from '../../config/remote-session-lifecycle.config';
import { SignalingParticipant } from '../../signaling/interfaces/signaling-participant.interface';
import { RemoteSessionStatus } from '../enums/remote-session-status.enum';
import type { RemoteSessionLifecycleSnapshot } from '../remote-sessions.service';

/** Por que el sistema cierra (o cerraria) una sesion. Solo para logs. */
export enum SystemCloseReason {
  /** CONNECTING durante mas de `connectingTtlMs` desde `createdAt`. */
  CONNECTING_TTL = 'CONNECTING_TTL',

  /** ACTIVE sin ningun socket del tecnico unido durante la gracia. */
  TECHNICIAN_ABSENT = 'TECHNICIAN_ABSENT',

  /** ACTIVE sin ningun socket de la tablet unido durante la gracia. */
  DEVICE_ABSENT = 'DEVICE_ABSENT',
}

/** Lo que la politica necesita saber de la participacion. */
export interface ParticipationView {
  isPresent(
    remoteSessionId: string,
    participant: SignalingParticipant,
  ): boolean;
  absentSince(
    remoteSessionId: string,
    participant: SignalingParticipant,
  ): number | null;
}

export interface ExpiryDeadline {
  /** `Date.now()` a partir del cual corresponde cerrar. */
  at: number;
  reason: SystemCloseReason;
  /**
   * `true` cuando el vencimiento lo fija la ventana de recuperacion tras el
   * arranque y no el TTL o la gracia normales.
   */
  afterStartup: boolean;
}

const ABSENCE_REASONS: ReadonlyArray<
  [SignalingParticipant, SystemCloseReason]
> = [
  [SignalingParticipant.TECHNICIAN, SystemCloseReason.TECHNICIAN_ABSENT],
  [SignalingParticipant.DEVICE, SystemCloseReason.DEVICE_ABSENT],
];

/**
 * Proximo vencimiento de una sesion, o `null` si hoy no tiene ninguno.
 *
 * Funcion pura: el mismo calculo sirve para programar el vencimiento y para
 * confirmarlo despues CON LA FILA BLOQUEADA, de modo que la decision final se
 * toma siempre sobre el estado real de ese instante.
 *
 * Politica:
 *
 * - `CONNECTING`: vence en `createdAt + connectingTtlMs`. Es absoluto: ningun
 *   mensaje de signaling lo renueva.
 * - `ACTIVE`: cada extremo (tecnico y tablet) tiene que tener al menos un socket
 *   unido a la sesion. Un extremo ausente vence `disconnectGraceMs` despues de
 *   irse su ultimo socket. Si en este proceso nunca se le vio unido, la
 *   referencia es el arranque o `connectedAt`, lo que sea posterior.
 * - `CLOSED`: nunca.
 *
 * Ningun vencimiento cae antes de `startedAt + startupRecoveryMs`: tras un
 * reinicio el registro de participantes esta vacio y hay que dar tiempo a los
 * clientes para reconectar y volver a unirse.
 */
export const nextExpiry = (
  session: RemoteSessionLifecycleSnapshot,
  participation: ParticipationView,
  config: RemoteSessionLifecycleConfig,
  startedAt: number,
): ExpiryDeadline | null => {
  const startupFloor = startedAt + config.startupRecoveryMs;

  const withFloor = (
    at: number,
    reason: SystemCloseReason,
  ): ExpiryDeadline => ({
    at: Math.max(at, startupFloor),
    reason,
    afterStartup: startupFloor > at,
  });

  if (session.status === RemoteSessionStatus.CONNECTING)
    return withFloor(
      session.createdAt.getTime() + config.connectingTtlMs,
      SystemCloseReason.CONNECTING_TTL,
    );

  if (session.status !== RemoteSessionStatus.ACTIVE) return null;

  let earliest: ExpiryDeadline | null = null;

  for (const [participant, reason] of ABSENCE_REASONS) {
    if (participation.isPresent(session.id, participant)) continue;

    const since =
      participation.absentSince(session.id, participant) ??
      Math.max(startedAt, (session.connectedAt ?? session.createdAt).getTime());

    const deadline = withFloor(since + config.disconnectGraceMs, reason);

    if (!earliest || deadline.at < earliest.at) earliest = deadline;
  }

  return earliest;
};
