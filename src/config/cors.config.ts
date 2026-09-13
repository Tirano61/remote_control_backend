/**
 * Origenes permitidos, para HTTP y para Socket.IO.
 *
 * Se configuran por variables de entorno para no meter dominios reales en el
 * repositorio, y sin recurrir a `origin: '*'`:
 *
 * - `CORS_ORIGINS`: origenes de la API HTTP.
 * - `SOCKET_IO_CORS_ORIGINS`: origenes del servidor de Socket.IO. Si no se
 *   define, se usan los de `CORS_ORIGINS`, que es lo habitual porque la
 *   aplicacion del tecnico consume ambos desde el mismo origen.
 *
 * Formato: lista separada por comas, por ejemplo
 * `https://soporte.example.com,https://admin.example.com`.
 *
 * Sin ninguna de las dos variables se mantienen los origenes de desarrollo que
 * ya usaba el proyecto, de modo que el comportamiento no cambia.
 */
export const DEFAULT_DEV_CORS_ORIGINS: readonly string[] = [
  'http://localhost:49371', // puerto del servidor dev Flutter (ajusta)
  'http://127.0.0.1:59074',
  'http://localhost:8080',
  'http://localhost:5678', // otros origenes que uses
];

/**
 * Fuente de las variables. Se inyecta para poder probar sin tocar el proceso.
 * Compatible con `process.env`.
 */
export type CorsEnv = Record<string, string | undefined>;

const parseOrigins = (raw?: string): string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/** Origenes de la API HTTP. */
export const resolveHttpCorsOrigins = (
  env: CorsEnv = process.env,
): string[] => {
  const configured = parseOrigins(env.CORS_ORIGINS);

  return configured.length > 0 ? configured : [...DEFAULT_DEV_CORS_ORIGINS];
};

/**
 * Origenes del servidor de Socket.IO.
 *
 * Importa sobre todo para el namespace `/technicians`: la aplicacion del tecnico
 * es Flutter Web y puede vivir en un origen distinto al del backend. Las tablets
 * no son un navegador, asi que CORS no las afecta.
 */
export const resolveSocketIoCorsOrigins = (
  env: CorsEnv = process.env,
): string[] => {
  const configured = parseOrigins(env.SOCKET_IO_CORS_ORIGINS);

  return configured.length > 0 ? configured : resolveHttpCorsOrigins(env);
};
