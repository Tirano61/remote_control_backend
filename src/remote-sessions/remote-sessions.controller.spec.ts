import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import * as request from 'supertest';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { DeviceJwtGuard } from '../devices/auth/guards/device-jwt.guard';
import { Device } from '../devices/entities/device.entity';
import { DeviceRemoteSessionsController } from './device-remote-sessions.controller';
import { RemoteSessionsController } from './remote-sessions.controller';
import { RemoteSessionsService } from './remote-sessions.service';

/**
 * Cableado HTTP de los dos controladores de sesiones remotas.
 *
 * Lo que se comprueba es el enrutado, de que identidad sale cada parametro y
 * que el body no pueda sugerir un dispositivo o un tecnico.
 *
 * La firma del JWT no es el asunto aqui, asi que se sustituye por un guard que
 * traduce un bearer conocido en un usuario, igual que en `AuthController`. El
 * `UserRoleGuard` en cambio es el de verdad: los roles que exige `@Auth()` si
 * forman parte del contrato de estas rutas.
 */

const device: Device = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  publicId: '384-729-142',
  name: 'Tablet Tolva 01',
  manufacturer: 'Samsung',
  model: 'SM-X210',
  androidVersion: '14',
  appVersion: '1.0.0',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const buildUser = (fullName: string, roles: ValidRoles[]): User =>
  ({
    id: randomUUID(),
    email: `${fullName.toLowerCase().replace(/ /g, '.')}@acme.com`,
    password: 'hash-que-nunca-debe-salir',
    fullName,
    isActive: true,
    roles,
    created_at: new Date(),
    updated_at: new Date(),
  }) as User;

const technician = buildUser('Ana Tecnica', [ValidRoles.tecnico]);
const admin = buildUser('Admin Total', [ValidRoles.admin]);
const plainUser = buildUser('Usuario Normal', [ValidRoles.user]);

const TECNICO_TOKEN = 'tecnico-token';
const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

const usersByToken: Record<string, User> = {
  [TECNICO_TOKEN]: technician,
  [ADMIN_TOKEN]: admin,
  [USER_TOKEN]: plainUser,
};

/** Cabecera de un tecnico autenticado. */
const asTechnician = { Authorization: `Bearer ${TECNICO_TOKEN}` };

/** Deja el dispositivo autenticado donde lo espera `@GetDevice()`. */
class FakeDeviceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ device?: Device }>().device = device;

    return true;
  }
}

/**
 * Reemplaza a Passport: sin bearer conocido responde `401`, igual que la
 * estrategia real. Deja el usuario donde lo esperan `@GetUser()` y
 * `UserRoleGuard`.
 */
class FakeUserAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: User }>();

    const user = usersByToken[(req.headers.authorization ?? '').slice(7)];

    if (!user) throw new UnauthorizedException('Token not valid');

    req.user = user;

    return true;
  }
}

describe('RemoteSessions controllers (HTTP)', () => {
  let app: INestApplication;
  let server: Server;

  const remoteSessionsService = {
    create: jest.fn(),
    findOneForTechnician: jest.fn(),
    closeByTechnician: jest.fn(),
    findCurrentForDevice: jest.fn(),
    closeByDevice: jest.fn(),
    findCurrentForTechnician: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Mismo orden que en `RemoteSessionsModule`.
      controllers: [DeviceRemoteSessionsController, RemoteSessionsController],
      providers: [
        { provide: RemoteSessionsService, useValue: remoteSessionsService },
      ],
    })
      .overrideGuard(DeviceJwtGuard)
      .useClass(FakeDeviceGuard)
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

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await app.close();
  });

  describe('tecnico', () => {
    it('crea la sesion con el tecnico del token y solo con supportRequestId', async () => {
      const supportRequestId = randomUUID();

      remoteSessionsService.create.mockResolvedValue({ id: randomUUID() });

      await request(server)
        .post('/remote-sessions')
        .set(asTechnician)
        .send({ supportRequestId })
        .expect(201);

      expect(remoteSessionsService.create).toHaveBeenCalledWith(
        { supportRequestId },
        technician,
      );
    });

    it('rechaza un body que intente elegir dispositivo o tecnico', async () => {
      await request(server)
        .post('/remote-sessions')
        .set(asTechnician)
        .send({
          supportRequestId: randomUUID(),
          deviceId: randomUUID(),
          technicianId: randomUUID(),
        })
        .expect(400);

      expect(remoteSessionsService.create).not.toHaveBeenCalled();
    });

    it('rechaza un supportRequestId que no es UUID', async () => {
      await request(server)
        .post('/remote-sessions')
        .set(asTechnician)
        .send({ supportRequestId: 'no-es-uuid' })
        .expect(400);

      expect(remoteSessionsService.create).not.toHaveBeenCalled();
    });

    it('consulta una sesion con el tecnico autenticado', async () => {
      const id = randomUUID();

      remoteSessionsService.findOneForTechnician.mockResolvedValue({ id });

      await request(server)
        .get(`/remote-sessions/${id}`)
        .set(asTechnician)
        .expect(200);

      expect(remoteSessionsService.findOneForTechnician).toHaveBeenCalledWith(
        id,
        technician,
      );
    });

    it('cierra la sesion con el tecnico autenticado', async () => {
      const id = randomUUID();

      remoteSessionsService.closeByTechnician.mockResolvedValue({});

      await request(server)
        .post(`/remote-sessions/${id}/close`)
        .set(asTechnician)
        .expect(200);

      expect(remoteSessionsService.closeByTechnician).toHaveBeenCalledWith(
        id,
        technician,
      );
    });

    it('devuelve la sesion actual del tecnico del token', async () => {
      remoteSessionsService.findCurrentForTechnician.mockResolvedValue({
        remoteSession: null,
      });

      await request(server)
        .get('/remote-sessions/current')
        .set(asTechnician)
        .expect(200, { remoteSession: null });

      // Solo el id del token: no hay ningun parametro de tecnico que pudiera
      // llegar del cliente.
      expect(
        remoteSessionsService.findCurrentForTechnician,
      ).toHaveBeenCalledWith(technician.id);
    });

    it('no deja que /current entre por la ruta /:id', async () => {
      remoteSessionsService.findCurrentForTechnician.mockResolvedValue({
        remoteSession: null,
      });

      await request(server)
        .get('/remote-sessions/current')
        .set(asTechnician)
        .expect(200);

      // Si `:id` ganara, `current` no seria un UUID y esto acabaria en 400.
      expect(remoteSessionsService.findOneForTechnician).not.toHaveBeenCalled();
    });

    it('ignora un technicianId sugerido por query', async () => {
      remoteSessionsService.findCurrentForTechnician.mockResolvedValue({
        remoteSession: null,
      });

      await request(server)
        .get(`/remote-sessions/current?technicianId=${randomUUID()}`)
        .set(asTechnician)
        .expect(200);

      expect(
        remoteSessionsService.findCurrentForTechnician,
      ).toHaveBeenCalledWith(technician.id);
    });

    it('responde 401 sin token', async () => {
      await request(server).get('/remote-sessions/current').expect(401);

      expect(
        remoteSessionsService.findCurrentForTechnician,
      ).not.toHaveBeenCalled();
    });

    it('responde 403 a un rol que no es admin ni tecnico', async () => {
      await request(server)
        .get('/remote-sessions/current')
        .set({ Authorization: `Bearer ${USER_TOKEN}` })
        .expect(403);

      expect(
        remoteSessionsService.findCurrentForTechnician,
      ).not.toHaveBeenCalled();
    });

    it('deja que un admin recupere su propia sesion actual', async () => {
      remoteSessionsService.findCurrentForTechnician.mockResolvedValue({
        remoteSession: null,
      });

      await request(server)
        .get('/remote-sessions/current')
        .set({ Authorization: `Bearer ${ADMIN_TOKEN}` })
        .expect(200);

      // El admin tampoco consulta en nombre de otro: su propio id.
      expect(
        remoteSessionsService.findCurrentForTechnician,
      ).toHaveBeenCalledWith(admin.id);
    });

    it('responde 400 cuando el :id del tecnico no es un UUID', async () => {
      await request(server)
        .get('/remote-sessions/no-es-uuid')
        .set(asTechnician)
        .expect(400);

      expect(remoteSessionsService.findOneForTechnician).not.toHaveBeenCalled();
    });
  });

  describe('dispositivo', () => {
    it('devuelve la sesion actual del dispositivo del token', async () => {
      remoteSessionsService.findCurrentForDevice.mockResolvedValue({
        remoteSession: null,
      });

      await request(server)
        .get('/device/remote-sessions/current')
        .expect(200, { remoteSession: null });

      expect(remoteSessionsService.findCurrentForDevice).toHaveBeenCalledWith(
        device.id,
      );
    });

    it('cierra la sesion con el dispositivo del token, ignorando el body', async () => {
      const id = randomUUID();

      remoteSessionsService.closeByDevice.mockResolvedValue({});

      await request(server)
        .post(`/device/remote-sessions/${id}/close`)
        .send({ deviceId: 'otro-dispositivo' })
        .expect(200);

      // El handler no declara `@Body()`: el cuerpo ni siquiera se lee, asi que
      // no hay forma de sugerir un dispositivo distinto al del token.
      expect(remoteSessionsService.closeByDevice).toHaveBeenCalledWith(
        id,
        device,
      );
    });

    it('responde 400 cuando el :id del dispositivo no es un UUID', async () => {
      await request(server)
        .post('/device/remote-sessions/no-es-uuid/close')
        .expect(400);

      expect(remoteSessionsService.closeByDevice).not.toHaveBeenCalled();
    });
  });
});
