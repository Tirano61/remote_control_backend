/**
 * Motivos de rechazo que ve el cliente.
 *
 * Son deliberadamente genericos: un `UNAUTHORIZED` no distingue entre una
 * sesion inexistente, una cerrada y una que pertenece a otro participante, asi
 * que responder un evento no sirve para averiguar nada de sesiones ajenas.
 */
export enum SignalingErrorCode {
  /** El payload no cumple el DTO (falta un campo, tipo incorrecto, demasiado grande). */
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',

  /** El socket no hizo `remote-session:join` sobre esa sesion. */
  NOT_JOINED = 'NOT_JOINED',

  /** Sesion inexistente, cerrada, o que no pertenece a quien la pide. */
  UNAUTHORIZED = 'UNAUTHORIZED',

  /** El namespace de destino todavia no esta disponible en el servidor. */
  UNAVAILABLE = 'UNAVAILABLE',
}

/** Respuesta (ACK) de `remote-session:join`. */
export type JoinRemoteSessionAck =
  | { joined: true; remoteSessionId: string }
  | { joined: false; error: SignalingErrorCode };

/**
 * Respuesta (ACK) de los eventos `webrtc:*`.
 *
 * `delivered: true` significa que el mensaje se entrego al namespace del otro
 * extremo, no que alguien lo haya recibido: si el otro participante todavia no
 * hizo `join`, el mensaje se pierde. Es el mismo criterio que en
 * `DeviceRealtimeService`.
 */
export type SignalingRelayAck =
  | { delivered: true; remoteSessionId: string }
  | { delivered: false; error: SignalingErrorCode };

export const joinRejected = (
  error: SignalingErrorCode,
): JoinRemoteSessionAck => ({ joined: false, error });

export const relayRejected = (
  error: SignalingErrorCode,
): SignalingRelayAck => ({
  delivered: false,
  error,
});
