import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import {
  bootstrapAdmin,
  readBootstrapAdminCredentials,
} from '../src/auth/bootstrap-admin';
import { User } from '../src/auth/entities/user.entity';
import { resolveDatabaseSsl } from '../src/config/database.config';

/**
 * Crea el primer administrador de la instalacion.
 *
 * Es una operacion LOCAL, de consola. No existe ningun endpoint equivalente:
 * `POST /auth/register` exige rol `admin`, y una ruta publica capaz de crear
 * administradores seria una puerta abierta permanente.
 *
 *   npm run bootstrap:admin
 *
 * Las credenciales salen del entorno (ver `BOOTSTRAP_ADMIN_ENV_KEYS`). Lo que
 * ya este definido en el proceso gana sobre el `.env`, porque `dotenv` no
 * sobreescribe variables existentes: pasarlas en la linea de comandos es
 * suficiente y no deja la contrasena en ningun fichero.
 *
 * La logica esta en `src/auth/bootstrap-admin.ts`, que es lo que se prueba en
 * `src/auth/bootstrap-admin.spec.ts`. Aqui solo hay conexion, mensajes y codigo
 * de salida.
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
    // El esquema lo mantiene la aplicacion al arrancar. Un script de alta no
    // tiene por que poder alterar tablas.
    synchronize: false,
  });
};

const run = async (): Promise<number> => {
  const credentials = readBootstrapAdminCredentials(process.env);
  const dataSource = buildDataSource();

  await dataSource.initialize();

  try {
    const result = await bootstrapAdmin(
      dataSource.getRepository(User),
      credentials,
    );

    switch (result.status) {
      case 'created':
        console.log('Administrator created successfully.');
        console.log(`Email: ${result.email}`);
        return 0;

      // No es un fallo: volver a ejecutarlo simplemente no hace nada.
      case 'admin-already-exists':
        console.log(
          'An administrator already exists. Bootstrap was not executed.',
        );
        return 0;

      case 'email-belongs-to-non-admin':
        console.error(
          `The email ${result.email} already belongs to a user that is not an administrator. ` +
            'Bootstrap was not executed and nothing was modified.',
        );
        console.error(
          'This script never changes the roles of an existing account. Use a different email.',
        );
        return 1;
    }
  } finally {
    // Sin esto el proceso se quedaria colgado con el pool abierto.
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

    console.error(`Bootstrap failed: ${message}`);

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
