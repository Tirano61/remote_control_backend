import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import * as request from 'supertest';
import { User } from '../auth/entities/user.entity';
import { UserRoleGuard } from '../auth/guards/user-role.guard';
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
 * que el body no pueda sugerir un dispositivo o un tecnico. La autenticacion se
 * sustituye por guards de prueba: el JWT no es el asunto aqui.
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

const technician: User = {
  id: randomUUID(),
  email: 'ana@acme.com',
  password: 'hash-que-nunca-debe-salir',
  fullName: 'Ana Tecnica',
  isActive: true,
  roles: [ValidRoles.tecnico],
  created_at: new Date(),
  updated_at: new Date(),
} as User;

/** Deja el dispositivo autenticado donde lo espera `@GetDevice()`. */
class FakeDeviceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ device?: Device }>().device = device;

    return true;
  }
}

/** Deja el usuario autenticado donde lo espera `@GetUser()`. */
class FakeUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user?: User }>().user = technician;

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
      .overrideGuard(AuthGuard())
      .useClass(FakeUserGuard)
      .overrideGuard(UserRoleGuard)
      .useValue({ canActivate: () => true })
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
        .send({ supportRequestId: 'no-es-uuid' })
        .expect(400);

      expect(remoteSessionsService.create).not.toHaveBeenCalled();
    });

    it('consulta una sesion con el tecnico autenticado', async () => {
      const id = randomUUID();

      remoteSessionsService.findOneForTechnician.mockResolvedValue({ id });

      await request(server).get(`/remote-sessions/${id}`).expect(200);

      expect(remoteSessionsService.findOneForTechnician).toHaveBeenCalledWith(
        id,
        technician,
      );
    });

    it('cierra la sesion con el tecnico autenticado', async () => {
      const id = randomUUID();

      remoteSessionsService.closeByTechnician.mockResolvedValue({});

      await request(server).post(`/remote-sessions/${id}/close`).expect(200);

      expect(remoteSessionsService.closeByTechnician).toHaveBeenCalledWith(
        id,
        technician,
      );
    });

    it('responde 400 cuando el :id del tecnico no es un UUID', async () => {
      await request(server).get('/remote-sessions/no-es-uuid').expect(400);

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
