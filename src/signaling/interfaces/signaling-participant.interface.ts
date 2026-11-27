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

  /**
   * Vuelve a comprobar CONTRA POSTGRESQL que la identidad del socket sigue
   * autorizada: dispositivo activo con la MISMA credencial con la que se
   * autentico el socket, o usuario activo con un rol de tecnico.
   *
   * `false` es un rechazo confirmado (y quien construye la identidad ya se ocupo
   * de retirar el acceso). Si PostgreSQL no responde, LANZA: no poder comprobar
   * no es lo mismo que estar revocado.
   */
  revalidate(): Promise<boolean>;

  /**
   * Comprobacion sincrona, sin I/O: el socket sigue conectado y su identidad no
   * fue revocada desde que se autentico (`IdentityRevocationService`).
   *
   * Es lo ULTIMO que se mira antes de un efecto (entrar en la room, registrar la
   * participacion, retransmitir), sin ningun `await` entre la comprobacion y el
   * efecto: asi un resultado que llega despues de una revocacion no concede
   * nada aunque la lectura de PostgreSQL fuera anterior a ella.
   */
  isCurrent(): boolean;
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
  /**
   * `true` si el socket ya se desconecto. Opcional para los dobles de prueba:
   * ausente se interpreta como conectado.
   */
  readonly disconnected?: boolean;
  join(room: string): void | Promise<void>;
  leave(room: string): void | Promise<void>;
}
