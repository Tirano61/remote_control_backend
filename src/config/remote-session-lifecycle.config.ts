/**
 * Tiempos del cierre automatico de sesiones remotas.
 *
 * Todos se leen de variables de entorno, se validan al arrancar y tienen un
 * valor por defecto documentado. Ningun otro fichero debe escribir estos
 * numeros: el resto del codigo recibe `RemoteSessionLifecycleConfig`.
 *
 * ```text
 * REMOTE_SESSION_DISCONNECT_GRACE_MS   60000
 * REMOTE_SESSION_CONNECTING_TTL_MS     120000
 * REMOTE_SESSION_STARTUP_RECOVERY_MS   90000
 * ```
 *
 * Por que esos valores (ver tambien docs/REALTIME.md):
 *
 * - GRACIA 60 s. El servidor detecta una conexion muerta sin cierre limpio con
 *   el heartbeat de Engine.IO (`socket-io-heartbeat.config.ts`: `pingInterval`
 *   10 s + `pingTimeout` 10 s por defecto), es decir, hasta ~20 s DESPUES de que
 *   se cayo la red; la gracia empieza a contar ahi y no depende del heartbeat:
 *   acortarlo adelanta la deteccion, no la acorta. Los clientes reintentan con
 *   `reconnectionDelayMax` de 10 s (web) y 20 s (tablet), asi que 60 s cubren
 *   varios intentos de reconexion y el `remote-session:join` posterior, que ambos
 *   clientes envian solos al reconectar.
 * - TTL CONNECTING 120 s desde `createdAt`. Incluye que la tablet reciba
 *   `remote-session:created`, que su usuario acepte el dialogo de captura de
 *   pantalla de Android, la negociacion SDP/ICE y el `/activate` del tecnico.
 *   Una negociacion sana dura segundos; dos minutos sin `ACTIVE` es un fallo.
 * - RECUPERACION TRAS ARRANQUE 90 s. Tras reiniciar NestJS el registro de
 *   participantes esta vacio. Es la gracia mas un margen para que los clientes,
 *   que llevan un rato reintentando con su retardo maximo, vuelvan a conectar y a
 *   unirse. Hasta que vence no se cierra ninguna sesion.
 */
export interface RemoteSessionLifecycleConfig {
  /** Tiempo que un participante puede faltar de una sesion ACTIVE. */
  disconnectGraceMs: number;

  /** Vida maxima de una sesion CONNECTING, contada desde `createdAt`. */
  connectingTtlMs: number;

  /** Ventana tras el arranque durante la que no se cierra nada. */
  startupRecoveryMs: number;
}

/** Fuente de las variables. Compatible con `process.env`. */
export type RemoteSessionLifecycleEnv = Record<string, string | undefined>;

export const REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV =
  'REMOTE_SESSION_DISCONNECT_GRACE_MS';
export const REMOTE_SESSION_CONNECTING_TTL_MS_ENV =
  'REMOTE_SESSION_CONNECTING_TTL_MS';
export const REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV =
  'REMOTE_SESSION_STARTUP_RECOVERY_MS';

export const DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG: Readonly<RemoteSessionLifecycleConfig> =
  {
    disconnectGraceMs: 60_000,
    connectingTtlMs: 120_000,
    startupRecoveryMs: 90_000,
  };

/**
 * Limites aceptados. Fuera de ellos la aplicacion no arranca: un valor de
 * pocos milisegundos cerraria sesiones sanas por un parpadeo de red, y uno
 * enorme equivale a no tener cierre automatico.
 */
export const REMOTE_SESSION_LIFECYCLE_MIN_MS = 5_000;
export const REMOTE_SESSION_LIFECYCLE_MAX_MS = 3_600_000;

/**
 * Espera antes de reintentar una evaluacion que fallo (por ejemplo, PostgreSQL
 * no respondio). No es configurable: es un detalle interno del reintento, no
 * una politica de cierre.
 */
export const REMOTE_SESSION_EVALUATION_RETRY_MS = 15_000;

/** Token de inyeccion de la configuracion ya validada. */
export const REMOTE_SESSION_LIFECYCLE_CONFIG = Symbol(
  'REMOTE_SESSION_LIFECYCLE_CONFIG',
);

const readMs = (
  env: RemoteSessionLifecycleEnv,
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

  if (
    value < REMOTE_SESSION_LIFECYCLE_MIN_MS ||
    value > REMOTE_SESSION_LIFECYCLE_MAX_MS
  )
    throw new Error(
      `${name} debe estar entre ${REMOTE_SESSION_LIFECYCLE_MIN_MS} y ${REMOTE_SESSION_LIFECYCLE_MAX_MS} ms (recibido: ${value})`,
    );

  return value;
};

/**
 * Configuracion validada. Lanza un error con el nombre de la variable cuando un
 * valor no es valido: es mejor no arrancar que cerrar sesiones con un tiempo
 * que nadie eligio.
 */
export const resolveRemoteSessionLifecycleConfig = (
  env: RemoteSessionLifecycleEnv = process.env,
): RemoteSessionLifecycleConfig => ({
  disconnectGraceMs: readMs(
    env,
    REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV,
    DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG.disconnectGraceMs,
  ),
  connectingTtlMs: readMs(
    env,
    REMOTE_SESSION_CONNECTING_TTL_MS_ENV,
    DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG.connectingTtlMs,
  ),
  startupRecoveryMs: readMs(
    env,
    REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV,
    DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG.startupRecoveryMs,
  ),
});
