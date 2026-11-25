/**
 * Heartbeat de Engine.IO (ping/pong) del servidor de Socket.IO.
 *
 * Se lee de variables de entorno UNA vez al arrancar (`main.ts`), se valida y
 * se entrega al `SocketIoAdapter`, que lo aplica al unico servidor Engine.IO que
 * comparten `/devices` y `/technicians`. Ningun gateway debe repetir estos
 * valores en su decorador.
 *
 * ```text
 * SOCKET_IO_PING_INTERVAL_MS   10000
 * SOCKET_IO_PING_TIMEOUT_MS    10000
 * ```
 *
 * Como detecta el servidor una conexion medio abierta (la red dejo de entregar
 * paquetes pero ningun extremo recibio FIN/RST):
 *
 * - Cada `pingInterval` el servidor envia un PING y espera el PONG durante
 *   `pingTimeout`. Si no llega, cierra el socket con motivo `ping timeout`.
 * - Peor caso: el corte ocurre justo despues de un PONG; el siguiente PING sale
 *   a los `pingInterval` y se da por perdido `pingTimeout` despues, es decir
 *   `pingInterval + pingTimeout` (20 s con 10/10; 45 s con los valores por
 *   defecto de Socket.IO, 25/20). Mejor caso: el corte ocurre justo antes de un
 *   PING, unos `pingTimeout`.
 * - Los dos valores viajan en el handshake de Engine.IO; los clientes (Socket.IO
 *   JS y `socket_io_client` de Flutter) los adoptan y se dan por desconectados
 *   si no reciben un PING en `pingInterval + pingTimeout`.
 *
 * La gracia del cierre SYSTEM (`REMOTE_SESSION_DISCONNECT_GRACE_MS`) empieza a
 * contar cuando el servidor detecta la desconexion: acortar el heartbeat
 * adelanta ese momento, pero no cambia la gracia ni ningun otro plazo.
 */
export interface SocketIoHeartbeatConfig {
  /** Cada cuanto el servidor envia un PING a cada conexion. */
  pingIntervalMs: number;

  /** Cuanto espera el PONG antes de cerrar con `ping timeout`. */
  pingTimeoutMs: number;
}

/** Fuente de las variables. Compatible con `process.env`. */
export type SocketIoHeartbeatEnv = Record<string, string | undefined>;

export const SOCKET_IO_PING_INTERVAL_MS_ENV = 'SOCKET_IO_PING_INTERVAL_MS';
export const SOCKET_IO_PING_TIMEOUT_MS_ENV = 'SOCKET_IO_PING_TIMEOUT_MS';

export const DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG: Readonly<SocketIoHeartbeatConfig> =
  {
    pingIntervalMs: 10_000,
    pingTimeoutMs: 10_000,
  };

/**
 * Limites aceptados por variable de entorno, iguales para los dos valores. Fuera
 * de ellos la aplicacion no arranca:
 *
 * - Minimo 5 s: un `pingTimeout` mas corto desconecta tablets sanas en redes
 *   moviles con latencias de pocos segundos, y cada desconexion abre una gracia
 *   de sesion. Un `pingInterval` mas corto multiplica el trafico sin ganar nada
 *   que compense ese riesgo.
 * - Maximo 60 s: mas alla, una conexion muerta puede pasar hasta dos minutos
 *   como viva (presencia ONLINE falsa y gracia que no empieza). Incluye los
 *   valores por defecto de Socket.IO (25/20) por si hubiera que volver a ellos.
 *
 * No hay forma de saltarse estos limites por entorno. Las pruebas que necesitan
 * tiempos de milisegundos construyen el adaptador con una configuracion propia,
 * sin pasar por este fichero.
 */
export const SOCKET_IO_HEARTBEAT_MIN_MS = 5_000;
export const SOCKET_IO_HEARTBEAT_MAX_MS = 60_000;

const readMs = (
  env: SocketIoHeartbeatEnv,
  name: string,
  fallback: number,
): number => {
  const raw = env[name]?.trim();

  if (!raw) return fallback;

  if (!/^\d+$/.test(raw))
    throw new Error(
      `${name} debe ser un numero entero de milisegundos (recibido: "${raw}")`,
    );

  const value = Number(raw);

  if (value < SOCKET_IO_HEARTBEAT_MIN_MS || value > SOCKET_IO_HEARTBEAT_MAX_MS)
    throw new Error(
      `${name} debe estar entre ${SOCKET_IO_HEARTBEAT_MIN_MS} y ${SOCKET_IO_HEARTBEAT_MAX_MS} ms (recibido: ${value})`,
    );

  return value;
};

/**
 * Configuracion validada. Una variable ausente o vacia toma su valor por
 * defecto; una presente e invalida lanza un error con su nombre, y la
 * aplicacion no arranca.
 */
export const resolveSocketIoHeartbeatConfig = (
  env: SocketIoHeartbeatEnv = process.env,
): SocketIoHeartbeatConfig => ({
  pingIntervalMs: readMs(
    env,
    SOCKET_IO_PING_INTERVAL_MS_ENV,
    DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG.pingIntervalMs,
  ),
  pingTimeoutMs: readMs(
    env,
    SOCKET_IO_PING_TIMEOUT_MS_ENV,
    DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG.pingTimeoutMs,
  ),
});
