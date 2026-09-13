/**
 * Estados de una solicitud de asistencia.
 *
 * Es la unica fuente de verdad: ningun estado debe escribirse como string
 * suelto en el resto del codigo.
 */
export enum SupportRequestStatus {
  /** La tablet pidio asistencia y ningun tecnico la tomo todavia. */
  WAITING = 'WAITING',

  /** Un tecnico la tomo; el usuario del dispositivo aun no respondio. */
  ASSIGNED = 'ASSIGNED',

  /**
   * El usuario del dispositivo autorizo a ese tecnico a continuar.
   * NO implica todavia que exista una sesion remota.
   */
  ACCEPTED = 'ACCEPTED',

  /** El usuario rechazo al tecnico. Terminal. */
  REJECTED = 'REJECTED',

  /** El usuario cancelo la solicitud. Terminal. */
  CANCELLED = 'CANCELLED',

  /**
   * La asistencia autorizada llego a una sesion remota y esa sesion se cerro.
   * Terminal.
   *
   * Ningun cliente puede pedir esta transicion: la escribe unicamente el cierre
   * de una `RemoteSession`, en la misma transaccion que la cierra.
   */
  COMPLETED = 'COMPLETED',
}

/**
 * Estados activos: mientras la solicitud este en alguno de ellos, el
 * dispositivo no puede abrir otra.
 */
export const ACTIVE_SUPPORT_REQUEST_STATUSES: readonly SupportRequestStatus[] =
  [
    SupportRequestStatus.WAITING,
    SupportRequestStatus.ASSIGNED,
    SupportRequestStatus.ACCEPTED,
  ];

/** Estados terminales: la solicitud ya no puede volver a cambiar. */
export const TERMINAL_SUPPORT_REQUEST_STATUSES: readonly SupportRequestStatus[] =
  [
    SupportRequestStatus.REJECTED,
    SupportRequestStatus.CANCELLED,
    SupportRequestStatus.COMPLETED,
  ];
