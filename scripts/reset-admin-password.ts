import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { User } from '../src/auth/entities/user.entity';
import {
  readResetAdminPasswordCredentials,
  resetAdminPassword,
} from '../src/auth/reset-admin-password';
import { resolveDatabaseSsl } from '../src/config/database.config';

/**
 * Cambia la contrasena de un administrador existente.
 *
 * Es una operacion LOCAL, de consola, igual que `npm run bootstrap:admin`. No
 * existe ningun endpoint equivalente ni lo habra: recuperar el acceso de un
 * administrador desde la propia API seria una via de escalada permanente.
 *
 *   $env:RESET_ADMIN_EMAIL="admin@example.com"
 *   $env:RESET_ADMIN_PASSWORD="<nueva-password>"
 *   npm run reset:admin-password
 *
 * Las credenciales salen del entorno (ver `RESET_ADMIN_PASSWORD_ENV_KEYS`). Lo
 * que ya este definido en el proceso gana sobre el `.env`, porque `dotenv` no
 * sobreescribe variables existentes: pasarlas en la linea de comandos es
 * suficiente y no deja la contrasena en ningun fichero.
 *
 * La logica esta en `src/auth/reset-admin-password.ts`, que es lo que se prueba
 * en `src/auth/reset-admin-password.spec.ts`. Aqui solo hay conexion, mensajes y
 * codigo de salida.
 */

// Igual que `ConfigModule.forRoot()` en la aplicacion: el `.env` del proyecto
// tambien vale aqui. No sobreescribe nada que ya venga del proceso, asi que las
// variables pasadas en la linea de comandos mandan sobre el fichero.
loadDotEnv();

/** `undefined_table`: el esquema todavia no se ha creado. */
const UNDEFINED_TABLE = '42P01';

const buildDataSource = (): DataSource => {
  const url = process.env.DATABASE_URL?.trim();

  if (!url)
    throw new Error(
      'DATABASE_URL is not defined: it is the only source of the PostgreSQL connection.',
    );

  return new DataSource({
    type: 'postgres',
    url,
    // Mismo criterio de TLS que usa la aplicacion: lo decide el `sslmode` de la
    // propia URL, asi que contra Neon conecta cifrado y validando certificado.
    ssl: resolveDatabaseSsl(url),
    entities: [User],
    // El esquema lo mantiene la aplicacion al arrancar. Un script que cambia una
    // contrasena no tiene por que poder alterar tablas.
    synchronize: false,
  });
};

const run = async (): Promise<number> => {
  const credentials = readResetAdminPasswordCredentials(process.env);
  const dataSource = buildDataSource();

  await dataSource.initialize();

  try {
    const result = await resetAdminPassword(
      dataSource.getRepository(User),
      credentials,
    );

    switch (result.status) {
      case 'updated':
        console.log('Administrator password updated successfully.');
        console.log(`Email: ${result.email}`);

        // La cuenta sigue desactivada: este script no toca `isActive`, asi que
        // el login la seguira rechazando y conviene decirlo en vez de dejar al
        // operador buscando por que su contrasena "nueva" no funciona.
        if (!result.isActive) {
          console.warn('Password updated, but the administrator is inactive.');
          console.warn(
            'POST /auth/login will keep answering 401 until the account is activated again. This script never changes isActive.',
          );
        }

        return 0;

      case 'user-not-found':
        console.error('Administrator not found.');
        console.error(
          `No user is registered with the email ${result.email}. Nothing was created and nothing was modified.`,
        );
        console.error(
          'This script never creates accounts. Use npm run bootstrap:admin for the first administrator.',
        );
        return 1;

      case 'user-is-not-admin':
        console.error('User exists but is not an administrator.');
        console.error(
          `The email ${result.email} belongs to an account without the admin role. Its password was not modified.`,
        );
        console.error(
          'This script never changes the roles of an existing account.',
        );
        return 1;
    }
  } finally {
    // Sin esto el proceso se quedaria colgado con el pool abierto. Se cierra
    // tanto si el reset ha ido bien como si ha fallado.
    await dataSource.destroy();
  }
};

// Solo se imprime el mensaje del error, nunca el error completo ni el entorno:
// ni la contrasena ni DATABASE_URL deben acabar en la consola.
run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`Administrator password reset failed: ${message}`);

    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === UNDEFINED_TABLE
    )
      console.error(
        'The users table does not exist yet. Start the backend once (npm run start:dev) so TypeORM creates the schema, then run this script again.',
      );

    process.exitCode = 1;
  });
