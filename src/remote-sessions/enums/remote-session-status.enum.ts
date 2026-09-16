/**
 * Estados de una sesion remota.
 *
 * Fuente de verdad unica: ningun estado debe escribirse como string suelto.
 */
export enum RemoteSessionStatus {
  /**
   * La sesion existe y las partes pueden empezar a establecer la conexion
   * remota. Es el estado con el que nace toda sesion.
   */
  CONNECTING = 'CONNECTING',

  /**
   * La conexion remota quedo establecida.
   *
   * Lo escribe unicamente `POST /remote-sessions/:id/activate`, cuando el
   * tecnico informa de que su `RTCPeerConnection` esta conectada y el
   * DataChannel de control abierto: el backend no participa en WebRTC y no
   * puede deducirlo por si mismo. El signaling NO cambia el estado de la
   * sesion.
   */
  ACTIVE = 'ACTIVE',

  /** La sesion termino. Terminal. */
  CLOSED = 'CLOSED',
}

/**
 * Estados vivos de una sesion.
 *
 * Un dispositivo no puede tener dos sesiones a la vez en ninguno de ellos: lo
 * garantiza el indice unico parcial de `RemoteSession`. Una sesion `CLOSED` no
 * bloquea nada.
 */
export const ACTIVE_REMOTE_SESSION_STATUSES: readonly RemoteSessionStatus[] = [
  RemoteSessionStatus.CONNECTING,
  RemoteSessionStatus.ACTIVE,
];
