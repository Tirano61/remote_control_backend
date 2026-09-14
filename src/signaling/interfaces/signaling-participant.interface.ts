/**
 * Los dos extremos de una sesion remota.
 *
 * No es un rol de usuario ni se acepta del cliente: lo decide el gateway por el
 * que entro el socket, y cada gateway solo puede construirlo con la identidad
 * que salio de su propio token.
 */
export enum SignalingParticipant {
  DEVICE = 'DEVICE',
  TECHNICIAN = 'TECHNICIAN',
}

/**
 * El extremo contrario.
 *
 * Una sesion remota tiene exactamente dos, asi que "el otro" siempre esta
 * definido. Se usa tanto para retransmitir signaling como para consultar la
 * presencia del peer en la room, y tenerlo en un solo sitio evita que cada
 * gateway invente su propia version de la misma regla.
 */
export const peerOf = (
  participant: SignalingParticipant,
): SignalingParticipant =>
  participant === SignalingParticipant.DEVICE
    ? SignalingParticipant.TECHNICIAN
    : SignalingParticipant.DEVICE;

/** Identidad autenticada de un extremo del signaling. */
export interface SignalingIdentity {
  participant: SignalingParticipant;

  /**
   * `deviceId` para una tablet, `userId` para un tecnico.
   *
   * Sale siempre del token validado (`socket.data`), nunca del payload del
   * evento.
   */
  id: string;
}

/** Lo que el signaling guarda en el socket. Lo escribe solo el servidor. */
export interface SignalingSocketData {
  /**
   * Sesion en la que participa el socket.
   *
   * Es la unica fuente valida para comprobar que un `webrtc:*` viene de alguien
   * que hizo `remote-session:join`: conocer el UUID de la sesion no alcanza.
   */
  remoteSessionId?: string | null;
}

/**
 * Lo minimo que el signaling necesita de un socket.
 *
 * Es a proposito una interfaz y no el `Socket` de Socket.IO: `SignalingService`
 * se usa desde dos gateways distintos (`/devices` y `/technicians`) y no tiene
 * por que conocer ninguno de los dos.
 */
export interface SignalingSocket {
  readonly id: string;
  readonly data: SignalingSocketData;
  join(room: string): void | Promise<void>;
  leave(room: string): void | Promise<void>;
}
