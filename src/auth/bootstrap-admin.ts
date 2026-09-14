import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ArrayContains, Repository } from 'typeorm';
import { CreateUserDto } from './dto/create_user.dto';
import { User } from './entities/user.entity';
import { ValidRoles } from './interfaces/valid-roles';
import { hashPassword } from './password';

/**
 * Alta por consola del primer administrador.
 *
 * `POST /auth/register` exige rol `admin`, asi que en una base recien creada no
 * hay forma de entrar: no existe todavia ningun usuario que pueda crear
 * usuarios. Esto lo resuelve, a proposito, FUERA de la API. No hay ningun
 * endpoint de bootstrap ni ningun alta automatica al arrancar Nest: un endpoint
 * publico capaz de crear un administrador seria una puerta permanente aunque se
 * "cerrara" en cuanto existiera el primero.
 *
 * El script que envuelve estas funciones es `scripts/bootstrap-admin.ts`
 * (`npm run bootstrap:admin`).
 */

/** Variables de entorno de las que sale el administrador a crear. */
export const BOOTSTRAP_ADMIN_ENV_KEYS = {
  email: 'BOOTSTRAP_ADMIN_EMAIL',
  password: 'BOOTSTRAP_ADMIN_PASSWORD',
  fullName: 'BOOTSTRAP_ADMIN_FULL_NAME',
} as const;

export interface BootstrapAdminCredentials {
  email: string;
  password: string;
  fullName: string;
}

/**
 * Resultado de una ejecucion. Se devuelve en vez de imprimir aqui para que el
 * script decida el texto y el codigo de salida, y para poder probarlo sin
 * capturar la consola.
 */
export type BootstrapAdminResult =
  | { status: 'created'; email: string }
  | { status: 'admin-already-exists' }
  | { status: 'email-belongs-to-non-admin'; email: string };

/** Misma normalizacion que hace `User` en `@BeforeInsert`. */
const normalizeEmail = (email: string): string =>
  email.toLocaleLowerCase().trim();

/**
 * Lee y valida las credenciales del entorno.
 *
 * La validacion es la del propio `CreateUserDto`, no una copia: si la
 * contrasena no cumpliera el patron del DTO se crearia un administrador que
 * despues no podria iniciar sesion, porque `POST /auth/login` valida el mismo
 * patron antes de comprobar credenciales.
 *
 * Lanza `Error` con los problemas encontrados. Los mensajes son los de
 * class-validator, que describen la regla incumplida y nunca incluyen el valor,
 * asi que la contrasena no puede acabar en pantalla.
 */
export const readBootstrapAdminCredentials = (
  env: Record<string, string | undefined> = process.env,
): BootstrapAdminCredentials => {
  const missing = Object.values(BOOTSTRAP_ADMIN_ENV_KEYS).filter(
    (key) => !env[key]?.trim(),
  );

  if (missing.length > 0)
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}. ` +
        'They must be provided for this run.',
    );

  const credentials: BootstrapAdminCredentials = {
    email: normalizeEmail(env[BOOTSTRAP_ADMIN_ENV_KEYS.email] as string),
    password: env[BOOTSTRAP_ADMIN_ENV_KEYS.password] as string,
    fullName: (env[BOOTSTRAP_ADMIN_ENV_KEYS.fullName] as string).trim(),
  };

  const errors = validateSync(
    plainToInstance(CreateUserDto, {
      ...credentials,
      roles: [ValidRoles.admin],
    }),
    { whitelist: true, forbidNonWhitelisted: true },
  );

  if (errors.length > 0) {
    const reasons = errors.flatMap((error) =>
      Object.values(error.constraints ?? {}),
    );

    throw new Error(
      `The administrator data is not valid: ${reasons.join('; ')}.`,
    );
  }

  return credentials;
};

/**
 * Crea el primer administrador si, y solo si, todavia no hay ninguno.
 *
 * Dos cosas que no hace a proposito:
 *
 * - no crea un segundo administrador "por si acaso": a partir del primero, las
 *   altas son responsabilidad de `POST /auth/register`;
 * - no promociona a un usuario existente. Cambiar los roles de una cuenta ya
 *   creada es una operacion administrativa explicita, y no puede quedar al
 *   alcance de quien pueda ejecutar un script con un email concreto.
 */
export const bootstrapAdmin = async (
  userRepository: Repository<User>,
  credentials: BootstrapAdminCredentials,
): Promise<BootstrapAdminResult> => {
  const email = normalizeEmail(credentials.email);

  const admins = await userRepository.count({
    where: { roles: ArrayContains([ValidRoles.admin]) },
  });

  if (admins > 0) return { status: 'admin-already-exists' };

  // Si ya hay una cuenta con ese email no puede ser administrador: acabamos de
  // comprobar que no existe ninguno.
  const existingUser = await userRepository.findOne({ where: { email } });

  if (existingUser) return { status: 'email-belongs-to-non-admin', email };

  const admin = userRepository.create({
    email,
    password: hashPassword(credentials.password),
    fullName: credentials.fullName,
    roles: [ValidRoles.admin],
    isActive: true,
  });

  await userRepository.save(admin);

  return { status: 'created', email };
};
