import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Fuente de las variables. Se inyecta para poder probar sin tocar el proceso.
 * Compatible con `process.env`, igual que en `cors.config.ts`.
 */
export type DatabaseEnv = Record<string, string | undefined>;

/**
 * Configuracion TLS que se le pasa al driver.
 *
 * `false` es sin cifrar; el objeto activa TLS y decide si se valida el
 * certificado del servidor.
 */
export type DatabaseSslOptions = boolean | { rejectUnauthorized: boolean };

/** Modo SSL declarado en la URL, o `null` si la URL no lo declara. */
const readSslMode = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('sslmode');
  } catch {
    throw new Error(
      'DATABASE_URL no es una URL de conexion valida (se espera postgresql://usuario:password@host/base)',
    );
  }
};

/**
 * TLS derivado del `sslmode` de la URL.
 *
 * La URL manda y no se contradice desde el codigo: `pg` parsea la cadena de
 * conexion DESPUES de leer las opciones sueltas y lo que salga de ella
 * sobreescribe a `ssl`, asi que una configuracion fija aqui seria una mentira
 * silenciosa en cuanto la URL dijera otra cosa. Esta funcion reproduce el mismo
 * criterio de forma explicita y verificable.
 *
 * Neon exige TLS y su certificado lo firma una CA publica, por lo que el
 * `sslmode=require` de su URL conecta cifrado y validando el certificado, sin
 * necesidad de `rejectUnauthorized: false` ni de un `sslrootcert` propio.
 *
 * Sin `sslmode` se conecta sin cifrar: es el comportamiento por defecto de
 * `pg` y el que necesita un PostgreSQL local (el `docker-compose` del
 * repositorio no sirve TLS).
 */
export const resolveDatabaseSsl = (url: string): DatabaseSslOptions => {
  const sslmode = readSslMode(url);

  switch (sslmode) {
    // Sin declarar y `disable`: conexion en claro.
    case null:
    case 'disable':
      return false;

    // Extension de `pg`: cifra pero no valida el certificado. Solo tiene
    // sentido contra un servidor con certificado autofirmado.
    case 'no-verify':
      return { rejectUnauthorized: false };

    // `require`, `prefer`, `verify-ca`, `verify-full`: cifrado y con el
    // certificado validado, que es lo que corresponde a un host publico.
    default:
      return { rejectUnauthorized: true };
  }
};

/**
 * Opciones del `TypeOrmModule` para esta aplicacion.
 *
 * `DATABASE_URL` es la unica fuente de conexion: host, puerto, usuario,
 * contrasena, base de datos y modo SSL viajan en la propia URL, que es lo que
 * entrega Neon. A proposito NO se parte en variables sueltas
 * (`DB_HOST`, `POSTGRES_USER`, ...): serian el mismo dato repetido en siete
 * sitios y siete cosas mas que pueden quedar desalineadas.
 *
 * ```text
 * DATABASE_URL=postgresql://user:password@host.neon.tech/base?sslmode=require
 * ```
 */
export const buildTypeOrmOptions = (
  env: DatabaseEnv = process.env,
): TypeOrmModuleOptions => {
  const url = env.DATABASE_URL?.trim();

  // Sin URL no hay conexion posible: mejor fallar al arrancar con un mensaje
  // claro que intentar conectar a un host `undefined`.
  if (!url)
    throw new Error(
      'DATABASE_URL no está definido en la configuración: es la única fuente de conexión a PostgreSQL',
    );

  return {
    type: 'postgres',
    url,
    ssl: resolveDatabaseSsl(url),

    // Las entidades las registra cada modulo con `TypeOrmModule.forFeature`:
    // no hay que mantener una lista aparte aqui.
    autoLoadEntities: true,

    // TEMPORAL, solo mientras el esquema esta en desarrollo: TypeORM crea y
    // ajusta tablas e indices al arrancar. Antes de tener datos reales hay que
    // pasar a migraciones; `synchronize` compara nombre, columnas y unicidad de
    // los indices pero NO su condicion, asi que un cambio en un indice parcial
    // ya creado no se aplicaria solo.
    synchronize: true,
  };
};
