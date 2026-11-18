/**
 * Zona horaria del proceso para `npm run test:db`.
 *
 * Las columnas de fecha son `timestamp without time zone` y `pg` convierte los
 * `Date` en hora LOCAL del proceso al escribir y al leer. Un defecto de mezcla
 * de relojes (unas columnas escritas por PostgreSQL, otras por Node) es
 * invisible si el proceso corre en UTC, que es justo la zona de la sesion de
 * PostgreSQL. Por eso la suite fija una zona distinta de UTC por defecto, y se
 * puede repetir en otras con `TEST_DB_TZ`:
 *
 * ```text
 * TEST_DB_TZ=Asia/Tokyo npm run test:db
 * TEST_DB_TZ=UTC        npm run test:db
 * ```
 *
 * Tiene que ser `globalSetup`: corre en el proceso principal antes de cargar
 * ninguna prueba (la suite va con `--runInBand`), y es el unico punto donde
 * asignar `process.env.TZ` cambia de verdad la zona de Node. Dentro de un
 * fichero de prueba Jest expone una copia de `process.env` y la asignacion no
 * tendria efecto.
 */
export const DEFAULT_TEST_DB_TZ = 'America/Argentina/Buenos_Aires';

export default function setup(): void {
  process.env.TZ = process.env.TEST_DB_TZ?.trim() || DEFAULT_TEST_DB_TZ;
}
