import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { ValidRoles } from './interfaces/valid-roles';
import {
  readResetAdminPasswordCredentials,
  resetAdminPassword,
} from './reset-admin-password';

/**
 * El reset cambia por consola la contrasena de un administrador existente. Lo
 * que se prueba aqui es lo que lo hace peligroso si se hace mal: que no de de
 * alta cuentas, que no promocione a nadie, que no arrastre ningun otro campo del
 * usuario y que la contrasena no viaje en claro ni a la base ni a los mensajes.
 */
describe('resetAdminPassword', () => {
  const credentials = {
    email: 'Admin@Example.com',
    password: 'NuevaClave1',
  };

  const admin = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'admin@example.com',
    roles: [ValidRoles.admin, ValidRoles.tecnico],
    isActive: true,
  } as User;

  let userRepository: jest.Mocked<
    Pick<Repository<User>, 'findOne' | 'update' | 'save' | 'create'>
  >;

  const repository = () => userRepository as unknown as Repository<User>;

  /** Columnas que lleva el `UPDATE` ejecutado, si ha habido alguno. */
  const updatedColumns = (): string[] =>
    Object.keys(userRepository.update.mock.calls[0][1] as object);

  const updatedPassword = (): string =>
    (userRepository.update.mock.calls[0][1] as Partial<User>)
      .password as string;

  beforeEach(() => {
    userRepository = {
      findOne: jest.fn().mockResolvedValue(admin),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(),
      create: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<Repository<User>, 'findOne' | 'update' | 'save' | 'create'>
    >;
  });

  it('cambia la contrasena de un administrador existente', async () => {
    await expect(
      resetAdminPassword(repository(), credentials),
    ).resolves.toEqual({
      status: 'updated',
      email: 'admin@example.com',
      isActive: true,
    });

    expect(userRepository.update).toHaveBeenCalledTimes(1);
    // Se busca por el email normalizado, igual que lo guarda `@BeforeInsert`, y
    // se actualiza por id.
    expect(userRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'admin@example.com' } }),
    );
    expect(userRepository.update.mock.calls[0][0]).toEqual({ id: admin.id });
  });

  it('guarda la contrasena hasheada y nunca en claro', async () => {
    await resetAdminPassword(repository(), credentials);

    expect(updatedPassword()).not.toBe(credentials.password);
    expect(updatedPassword()).toMatch(/^\$2[aby]\$/);
    // El hash tiene que validar contra el mecanismo que usa el login.
    expect(bcrypt.compareSync(credentials.password, updatedPassword())).toBe(
      true,
    );
  });

  it('no modifica ningun campo aparte de la contrasena', async () => {
    await resetAdminPassword(repository(), credentials);

    expect(updatedColumns()).toEqual(['password']);
    // Nada de `save()` con la entidad entera: un `UPDATE` con una sola columna
    // no puede arrastrar roles, email, fullName ni isActive.
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('cambia la contrasena de un administrador inactivo pero lo informa', async () => {
    userRepository.findOne.mockResolvedValue({
      ...admin,
      isActive: false,
    } as User);

    await expect(
      resetAdminPassword(repository(), credentials),
    ).resolves.toEqual({
      status: 'updated',
      email: 'admin@example.com',
      isActive: false,
    });

    // Cambiar la contrasena de una cuenta desactivada no da acceso: el login
    // sigue rechazandola. Reactivarla es una decision administrativa aparte.
    expect(updatedColumns()).toEqual(['password']);
  });

  it('no crea nada si el email no existe', async () => {
    userRepository.findOne.mockResolvedValue(null);

    await expect(
      resetAdminPassword(repository(), credentials),
    ).resolves.toEqual({
      status: 'user-not-found',
      email: 'admin@example.com',
    });

    expect(userRepository.update).not.toHaveBeenCalled();
    expect(userRepository.save).not.toHaveBeenCalled();
    expect(userRepository.create).not.toHaveBeenCalled();
  });

  it('no toca la contrasena de un usuario que no es administrador', async () => {
    userRepository.findOne.mockResolvedValue({
      ...admin,
      roles: [ValidRoles.tecnico, ValidRoles.user],
    } as User);

    await expect(
      resetAdminPassword(repository(), credentials),
    ).resolves.toEqual({
      status: 'user-is-not-admin',
      email: 'admin@example.com',
    });

    expect(userRepository.update).not.toHaveBeenCalled();
    expect(userRepository.save).not.toHaveBeenCalled();
  });

  it('no devuelve la contrasena en el resultado', async () => {
    const result = await resetAdminPassword(repository(), credentials);

    expect(JSON.stringify(result)).not.toContain(credentials.password);
  });
});

describe('readResetAdminPasswordCredentials', () => {
  const env = {
    RESET_ADMIN_EMAIL: 'Admin@Example.com ',
    RESET_ADMIN_PASSWORD: 'NuevaClave1',
  };

  /** Mensaje del error lanzado, o `null` si no ha lanzado. */
  const errorMessageFor = (
    overrides: Record<string, string | undefined>,
  ): string | null => {
    try {
      readResetAdminPasswordCredentials({ ...env, ...overrides });
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('normaliza el email', () => {
    expect(readResetAdminPasswordCredentials(env)).toEqual({
      email: 'admin@example.com',
      password: 'NuevaClave1',
    });
  });

  it('exige las dos variables', () => {
    expect(errorMessageFor({ RESET_ADMIN_PASSWORD: '' })).toMatch(
      /RESET_ADMIN_PASSWORD/,
    );
    expect(errorMessageFor({ RESET_ADMIN_EMAIL: undefined })).toMatch(
      /RESET_ADMIN_EMAIL/,
    );
  });

  it('rechaza una contrasena que no podria iniciar sesion despues', () => {
    // `POST /auth/login` valida el mismo patron: dejar puesta una contrasena
    // debil devolveria al administrador al punto de partida.
    expect(errorMessageFor({ RESET_ADMIN_PASSWORD: 'abcdefgh' })).toMatch(
      /password/i,
    );
    expect(errorMessageFor({ RESET_ADMIN_PASSWORD: 'Ab1' })).toMatch(
      /password/i,
    );
  });

  it('no incluye la contrasena en el mensaje de error', () => {
    const weakPassword = 'abcdefgh';

    expect(
      errorMessageFor({ RESET_ADMIN_PASSWORD: weakPassword }),
    ).not.toContain(weakPassword);
  });

  it('rechaza un email invalido', () => {
    expect(errorMessageFor({ RESET_ADMIN_EMAIL: 'no-es-un-email' })).toMatch(
      /email/i,
    );
  });
});
