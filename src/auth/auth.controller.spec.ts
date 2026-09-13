import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import * as request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { User } from './entities/user.entity';
import { ValidRoles } from './interfaces/valid-roles';

/**
 * Contrato HTTP del modulo auth.
 *
 * Lo que se comprueba aqui es quien puede dar de alta usuarios, como se validan
 * los roles del alta y con que status responde el login. El JWT real se
 * sustituye por un guard de prueba que traduce un bearer conocido a un usuario:
 * la firma del token no es el asunto de este test, si lo es el rol exigido, que
 * se evalua con el `UserRoleGuard` de verdad.
 */

const PASSWORD = 'Abc12345';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

const buildUser = (overrides: Partial<User> = {}): User =>
  ({
    id: randomUUID(),
    email: 'ana@acme.com',
    password: PASSWORD_HASH,
    fullName: 'Ana Tecnica',
    isActive: true,
    roles: [ValidRoles.tecnico],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }) as User;

const admin = buildUser({ email: 'admin@acme.com', roles: [ValidRoles.admin] });
const technician = buildUser({ roles: [ValidRoles.tecnico] });

const ADMIN_TOKEN = 'admin-token';
const TECNICO_TOKEN = 'tecnico-token';

const usersByToken: Record<string, User> = {
  [ADMIN_TOKEN]: admin,
  [TECNICO_TOKEN]: technician,
};

/**
 * Reemplaza a Passport: sin bearer conocido responde 401, igual que la
 * estrategia real. Deja el usuario donde lo espera `UserRoleGuard`.
 */
class FakeUserAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: User }>();

    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    const user = usersByToken[token];

    if (!user) throw new UnauthorizedException('Token not valid');

    req.user = user;

    return true;
  }
}

describe('AuthController (HTTP)', () => {
  let app: INestApplication;
  let server: Server;

  const userRepository = {
    create: jest.fn<Partial<User>, [Partial<User>]>(),
    save: jest.fn<Promise<Partial<User>>, [Partial<User>]>(),
    findOne: jest.fn<Promise<User | null>, [unknown]>(),
    findOneBy: jest.fn<Promise<User | null>, [unknown]>(),
  };

  const jwtService = { sign: jest.fn(() => 'signed-jwt') };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        { provide: JwtService, useValue: jwtService },
      ],
    })
      // El guard de roles se deja el real: es justo lo que se quiere comprobar.
      .overrideGuard(AuthGuard())
      .useClass(FakeUserAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();

    // Mismas reglas que `main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );

    await app.init();

    server = app.getHttpServer() as Server;
  });

  beforeEach(() => {
    jest.clearAllMocks();

    userRepository.create.mockImplementation((data) => ({ ...data }));
    userRepository.save.mockImplementation((user) =>
      Promise.resolve(
        Object.assign(user, {
          id: randomUUID(),
          isActive: true,
          // Lo que hace el default de la columna cuando el alta no manda roles.
          roles: user.roles ?? [ValidRoles.user],
        }),
      ),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/register', () => {
    const body = {
      email: 'nuevo@acme.com',
      password: PASSWORD,
      fullName: 'Nuevo Usuario',
    };

    it('rechaza el alta sin autenticacion', async () => {
      await request(server).post('/auth/register').send(body).expect(401);

      expect(userRepository.save).not.toHaveBeenCalled();
    });

    it('rechaza el alta hecha por un tecnico', async () => {
      await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${TECNICO_TOKEN}`)
        .send(body)
        .expect(403);

      expect(userRepository.save).not.toHaveBeenCalled();
    });

    it('permite al admin crear un usuario y nunca devuelve el password', async () => {
      const response = await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send(body)
        .expect(201);

      expect(userRepository.save).toHaveBeenCalledTimes(1);

      const created = userRepository.create.mock.calls[0][0];
      expect(created.password).not.toBe(PASSWORD);
      expect(bcrypt.compareSync(PASSWORD, created.password!)).toBe(true);

      expect(response.body).not.toHaveProperty('password');
      expect(response.body).toMatchObject({
        email: 'nuevo@acme.com',
        fullName: 'Nuevo Usuario',
        token: 'signed-jwt',
      });
    });

    it('crea el usuario con los roles indicados por el admin', async () => {
      const response = await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ ...body, roles: [ValidRoles.tecnico] })
        .expect(201);

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ roles: [ValidRoles.tecnico] }),
      );
      const created = response.body as Partial<User>;
      expect(created.roles).toContain(ValidRoles.tecnico);
    });

    it('elimina roles duplicados', async () => {
      await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ ...body, roles: [ValidRoles.tecnico, ValidRoles.tecnico] })
        .expect(201);

      expect(userRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ roles: [ValidRoles.tecnico] }),
      );
    });

    it('sin roles deja actuar al default de la columna', async () => {
      const response = await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send(body)
        .expect(201);

      // El backend no manda roles: nadie queda promovido por omision.
      expect(userRepository.create.mock.calls[0][0]).not.toHaveProperty(
        'roles',
      );

      const created = response.body as Partial<User>;
      expect(created.roles).toEqual([ValidRoles.user]);
    });

    it('rechaza un rol inexistente', async () => {
      await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ ...body, roles: ['invalid'] })
        .expect(400);

      expect(userRepository.create).not.toHaveBeenCalled();
    });

    it('rechaza un array de roles vacio', async () => {
      await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ ...body, roles: [] })
        .expect(400);

      expect(userRepository.create).not.toHaveBeenCalled();
    });

    it('no deja que el request decida campos internos', async () => {
      await request(server)
        .post('/auth/register')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ ...body, id: randomUUID(), isActive: false })
        .expect(400);

      expect(userRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/login', () => {
    it('responde 200, no 201, con credenciales validas', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());

      const response = await request(server)
        .post('/auth/login')
        .send({ email: 'ana@acme.com', password: PASSWORD })
        .expect(200);

      expect(response.body).not.toHaveProperty('password');
      expect(response.body).toMatchObject({
        email: 'ana@acme.com',
        roles: [ValidRoles.tecnico],
        token: 'signed-jwt',
      });
    });

    it('rechaza credenciales invalidas', async () => {
      userRepository.findOne.mockResolvedValue(buildUser());

      await request(server)
        .post('/auth/login')
        .send({ email: 'ana@acme.com', password: 'Otro12345' })
        .expect(401);
    });

    it('rechaza el login de un usuario inactivo', async () => {
      userRepository.findOne.mockResolvedValue(buildUser({ isActive: false }));

      await request(server)
        .post('/auth/login')
        .send({ email: 'ana@acme.com', password: PASSWORD })
        .expect(401);
    });
  });
});
