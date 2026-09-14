import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Repository } from 'typeorm';
import { LoginUserDto } from './dto/login_user.dto';
import { User } from './entities/user.entity';
import { ValidRoles } from './interfaces/valid-roles';
import { hashPassword } from './password';

/**
 * Cambio por consola de la contrasena de un administrador YA existente.
 *
 * Es el complemento de `bootstrap-admin`, no un duplicado: aquel crea el primer
 * administrador cuando no hay ninguno, este recupera el acceso a uno que ya
 * existe y cuya contrasena se ha perdido. Las dos operaciones viven fuera de la
 * API por la misma razon: una ruta capaz de reescribir la contrasena de un
 * administrador seria una puerta abierta permanente, por muchas condiciones que
 * se le pusieran encima.
 *
 * Tampoco hay recuperacion por email ni tokens de reset: quien pueda ejecutar
 * este script ya tiene acceso al servidor y a `DATABASE_URL`.
 *
 * El script que envuelve estas funciones es `scripts/reset-admin-password.ts`
 * (`npm run reset:admin-password`).
 */

/**
 * Variables de entorno de las que sale el reset.
 *
 * Deliberadamente NO se reutiliza `BOOTSTRAP_ADMIN_PASSWORD`: el `.env` de un
 * despliegue suele conservar la contrasena con la que se creo el administrador,
 * y compartir la variable haria que un `npm run reset:admin-password` sin
 * argumentos volviera a poner en produccion, en silencio, una contrasena
 * antigua.
 */
export const RESET_ADMIN_PASSWORD_ENV_KEYS = {
  email: 'RESET_ADMIN_EMAIL',
  password: 'RESET_ADMIN_PASSWORD',
} as const;

export interface ResetAdminPasswordCredentials {
  email: string;
  password: string;
}

/**
 * Resultado de una ejecucion. Como en el bootstrap, se devuelve en vez de
 * imprimir aqui para que el script decida el texto y el codigo de salida, y
 * para poder probarlo sin capturar la consola.
 *
 * `isActive` viaja en `updated` porque el reset no toca ese campo: la contrasena
 * queda cambiada, pero si la cuenta esta desactivada el login seguira
 * rechazandola y hay que decirlo.
 */
export type ResetAdminPasswordResult =
  | { status: 'updated'; email: string; isActive: boolean }
  | { status: 'user-not-found'; email: string }
  | { status: 'user-is-not-admin'; email: string };

/** Misma normalizacion que hace `User` en `@BeforeInsert`. */
const normalizeEmail = (email: string): string =>
  email.toLocaleLowerCase().trim();

/**
 * Lee y valida las credenciales del entorno.
 *
 * La validacion se delega en `LoginUserDto`, que es exactamente la puerta por la
 * que tendra que pasar despues la contrasena nueva: `POST /auth/login` valida
 * ese DTO antes de comprobar nada contra la base, asi que una contrasena que no
 * lo cumpla dejaria al administrador con el acceso igual de perdido que antes.
 * Sus reglas son las mismas que las de `CreateUserDto` (6-50 caracteres, con
 * mayuscula, minuscula y numero o simbolo) y aqui no se copia ninguna regex.
 *
 * Lanza `Error` con los problemas encontrados. Los mensajes son los de
 * class-validator, que describen la regla incumplida y nunca incluyen el valor,
 * asi que la contrasena no puede acabar en pantalla.
 */
export const readResetAdminPasswordCredentials = (
  env: Record<string, string | undefined> = process.env,
): ResetAdminPasswordCredentials => {
  const missing = Object.values(RESET_ADMIN_PASSWORD_ENV_KEYS).filter(
    (key) => !env[key]?.trim(),
  );

  if (missing.length > 0)
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}. ` +
        'They must be provided for this run.',
    );

  const credentials: ResetAdminPasswordCredentials = {
    email: normalizeEmail(env[RESET_ADMIN_PASSWORD_ENV_KEYS.email] as string),
    password: env[RESET_ADMIN_PASSWORD_ENV_KEYS.password] as string,
  };

  const errors = validateSync(plainToInstance(LoginUserDto, credentials), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  if (errors.length > 0) {
    const reasons = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );

    throw new Error(
      `Invalid administrator credentials: ${reasons.join('; ')}.`,
    );
  }

  return credentials;
};

/**
 * Cambia la contrasena de un administrador existente.
 *
 * Tres cosas que no hace a proposito:
 *
 * - no crea la cuenta si el email no existe. Un reset que da de alta seria un
 *   alta de administrador disfrazada, y eso ya lo cubre el bootstrap;
 * - no promociona a administrador a quien no lo sea. Si el email existe pero es
 *   de un tecnico o de un usuario, no se toca nada: cambiar roles es una
 *   operacion administrativa distinta;
 * - no reactiva la cuenta. `isActive` es una decision administrativa y no puede
 *   colarse como efecto secundario de recuperar una contrasena; se informa en el
 *   resultado y ya.
 *
 * El `UPDATE` lleva unicamente la columna `password`, asi que `email`, `roles`,
 * `fullName`, `isActive` y las marcas de tiempo quedan como estaban.
 */
export const resetAdminPassword = async (
  userRepository: Repository<User>,
  credentials: ResetAdminPasswordCredentials,
): Promise<ResetAdminPasswordResult> => {
  const email = normalizeEmail(credentials.email);

  // El hash actual no se pide: no hace falta para nada y asi no llega siquiera
  // a memoria. `password` esta marcada `select: false`, pero al enumerar las
  // columnas queda explicito.
  const user = await userRepository.findOne({
    where: { email },
    select: { id: true, email: true, roles: true, isActive: true },
  });

  if (!user) return { status: 'user-not-found', email };

  if (!user.roles?.includes(ValidRoles.admin))
    return { status: 'user-is-not-admin', email };

  await userRepository.update(
    { id: user.id },
    { password: hashPassword(credentials.password) },
  );

  return { status: 'updated', email: user.email, isActive: user.isActive };
};
