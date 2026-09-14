import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { ValidRoles } from './interfaces/valid-roles';
import {
  bootstrapAdmin,
  readBootstrapAdminCredentials,
} from './bootstrap-admin';

/**
 * El bootstrap crea el primer administrador desde consola, sin exponer ningun
 * endpoint. Lo que se prueba aqui es justamente lo que hace peligroso un alta
 * privilegiada: que no se repita, que no promocione cuentas existentes y que la
 * contrasena no viaje en claro a la base ni al resultado.
 */
describe('bootstrapAdmin', () => {
  const credentials = {
    email: 'Admin@Example.com',
    password: 'Abc12345',
    fullName: 'Administrator',
  };

  let userRepository: jest.Mocked<
    Pick<Repository<User>, 'count' | 'findOne' | 'create' | 'save'>
  >;

  const repository = () => userRepository as unknown as Repository<User>;

  beforeEach(() => {
    userRepository = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: Partial<User>) => data as User),
      save: jest.fn((user: User) => Promise.resolve(user)),
    } as unknown as jest.Mocked<
      Pick<Repository<User>, 'count' | 'findOne' | 'create' | 'save'>
    >;
  });

  it('crea un unico administrador activo cuando no existe ninguno', async () => {
    await expect(bootstrapAdmin(repository(), credentials)).resolves.toEqual({
      status: 'created',
      email: 'admin@example.com',
    });

    expect(userRepository.save).toHaveBeenCalledTimes(1);

    const created = userRepository.create.mock.calls[0][0] as Partial<User>;

    expect(created.roles).toEqual([ValidRoles.admin]);
    expect(created.isActive).toBe(true);
    // El email se normaliza igual que en `@BeforeInsert`, para que no dependa
    // de como se haya escrito en la variable de entorno.
    expect(created.email).toBe('admin@example.com');
  });

  it('guarda la contrasena hasheada y nunca en claro', async () => {
    await bootstrapAdmin(repository(), credentials);

    const created = userRepository.create.mock.calls[0][0] as Partial<User>;

    expect(created.password).not.toBe(credentials.password);
    expect(created.password).toMatch(/^\$2[aby]\$/);
    // El hash tiene que validar contra el mecanismo que usa el login.
    expect(bcrypt.compareSync(credentials.password, created.password!)).toBe(
      true,
    );
  });

  it('no devuelve la contrasena en el resultado', async () => {
    const result = await bootstrapAdmin(repository(), credentials);

    expect(JSON.stringify(result)).not.toContain(credentials.password);
  });

  it('no crea un segundo administrador si ya existe uno', async () => {
    userRepository.count.mockResolvedValue(1);

    await expect(bootstrapAdmin(repository(), credentials)).resolves.toEqual({
      status: 'admin-already-exists',
    });

    expect(userRepository.save).not.toHaveBeenCalled();
    // Ni siquiera se mira el email: no hay nada que decidir.
    expect(userRepository.findOne).not.toHaveBeenCalled();
  });

  it('no promociona a un usuario existente que no es administrador', async () => {
    userRepository.findOne.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'admin@example.com',
      roles: [ValidRoles.tecnico],
    } as User);

    await expect(bootstrapAdmin(repository(), credentials)).resolves.toEqual({
      status: 'email-belongs-to-non-admin',
      email: 'admin@example.com',
    });

    expect(userRepository.save).not.toHaveBeenCalled();
  });
});

describe('readBootstrapAdminCredentials', () => {
  const env = {
    BOOTSTRAP_ADMIN_EMAIL: 'Admin@Example.com ',
    BOOTSTRAP_ADMIN_PASSWORD: 'Abc12345',
    BOOTSTRAP_ADMIN_FULL_NAME: ' Administrator ',
  };

  it('normaliza email y nombre', () => {
    expect(readBootstrapAdminCredentials(env)).toEqual({
      email: 'admin@example.com',
      password: 'Abc12345',
      fullName: 'Administrator',
    });
  });

  it('exige las tres variables', () => {
    expect(() =>
      readBootstrapAdminCredentials({ ...env, BOOTSTRAP_ADMIN_PASSWORD: '' }),
    ).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
  });

  it('rechaza una contrasena que no podria iniciar sesion despues', () => {
    // `POST /auth/login` valida el mismo patron que `CreateUserDto`: un
    // administrador con una contrasena debil quedaria creado y bloqueado.
    expect(() =>
      readBootstrapAdminCredentials({
        ...env,
        BOOTSTRAP_ADMIN_PASSWORD: 'abcdefgh',
      }),
    ).toThrow(/password/i);
  });

  it('no incluye la contrasena en el mensaje de error', () => {
    const weakPassword = 'abcdefgh';
    let message: string | null = null;

    try {
      readBootstrapAdminCredentials({
        ...env,
        BOOTSTRAP_ADMIN_PASSWORD: weakPassword,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBeNull();
    expect(message).not.toContain(weakPassword);
  });

  it('rechaza un email invalido', () => {
    expect(() =>
      readBootstrapAdminCredentials({
        ...env,
        BOOTSTRAP_ADMIN_EMAIL: 'no-es-un-email',
      }),
    ).toThrow(/email/i);
  });
});
