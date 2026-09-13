import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import {
  buildTypeOrmOptions,
  DatabaseEnv,
  resolveDatabaseSsl,
} from './database.config';

const NEON_URL =
  'postgresql://neondb_owner:secret@ep-demo-pooler.c-4.us-east-2.aws.neon.tech/remote_control?sslmode=require&channel_binding=require';

/** `autoLoadEntities` lo agrega Nest, no esta en las opciones del driver. */
type PostgresModuleOptions = PostgresConnectionOptions & {
  autoLoadEntities?: boolean;
};

const options = (env: DatabaseEnv): PostgresModuleOptions =>
  buildTypeOrmOptions(env) as PostgresModuleOptions;

/**
 * Contrato de la conexion a PostgreSQL.
 *
 * `DATABASE_URL` es la unica fuente de conexion y el `sslmode` que trae decide
 * el TLS: el driver parsea la cadena despues de las opciones sueltas, asi que
 * una configuracion fija en el codigo quedaria sobreescrita sin avisar.
 */
describe('Configuracion de la base de datos', () => {
  it('consume DATABASE_URL directamente, sin partirla en variables sueltas', () => {
    const { type, url } = options({ DATABASE_URL: NEON_URL });

    expect(type).toBe('postgres');
    expect(url).toBe(NEON_URL);
  });

  it('falla al arrancar si no hay DATABASE_URL', () => {
    expect(() => buildTypeOrmOptions({})).toThrow(/DATABASE_URL/);
    expect(() => buildTypeOrmOptions({ DATABASE_URL: '   ' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rechaza una DATABASE_URL que no sea una URL', () => {
    expect(() =>
      buildTypeOrmOptions({ DATABASE_URL: 'no-es-una-url' }),
    ).toThrow(/URL de conexion valida/);
  });

  it('conecta con Neon cifrado y validando el certificado', () => {
    // Neon exige TLS y su certificado lo firma una CA publica: no hace falta
    // `rejectUnauthorized: false`, que es justo lo que no debe colarse aqui.
    expect(resolveDatabaseSsl(NEON_URL)).toEqual({ rejectUnauthorized: true });
  });

  it.each(['prefer', 'verify-ca', 'verify-full'])(
    'valida el certificado tambien con sslmode=%s',
    (sslmode) => {
      expect(
        resolveDatabaseSsl(
          `postgresql://u:p@host.neon.tech/db?sslmode=${sslmode}`,
        ),
      ).toEqual({ rejectUnauthorized: true });
    },
  );

  it('no cifra contra un PostgreSQL local sin sslmode', () => {
    // El docker-compose del repositorio no sirve TLS: forzarlo dejaria el
    // desarrollo local sin poder conectar.
    expect(
      resolveDatabaseSsl('postgresql://postgres:postgres@localhost:5432/db'),
    ).toBe(false);
    expect(
      resolveDatabaseSsl(
        'postgresql://postgres:postgres@localhost:5432/db?sslmode=disable',
      ),
    ).toBe(false);
  });

  it('solo deja de validar el certificado si la URL lo pide con sslmode=no-verify', () => {
    expect(
      resolveDatabaseSsl('postgresql://u:p@host/db?sslmode=no-verify'),
    ).toEqual({ rejectUnauthorized: false });
  });

  it('registra las entidades de cada modulo y mantiene synchronize en desarrollo', () => {
    const { autoLoadEntities, synchronize } = options({
      DATABASE_URL: NEON_URL,
    });

    expect(autoLoadEntities).toBe(true);
    expect(synchronize).toBe(true);
  });
});
