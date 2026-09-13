import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { Server } from 'http';
import { User } from '../auth/entities/user.entity';
import { UserRoleGuard } from '../auth/guards/user-role.guard';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { DeviceJwtGuard } from '../devices/auth/guards/device-jwt.guard';
import { Device } from '../devices/entities/device.entity';
import { DeviceSupportRequestsController } from './device-support-requests.controller';
import { SupportRequestStatus } from './enums/support-request-status.enum';
import { SupportRequestsController } from './support-requests.controller';
import { SupportRequestsService } from './support-requests.service';

/**
 * Cableado HTTP de los dos controladores.
 *
 * Interesa sobre todo que `GET /support-requests/current` (dispositivo) se
 * resuelva antes que `GET /support-requests/:id` (tecnico), porque ambos
 * cuelgan del mismo prefijo y los protegen identidades distintas. El orden lo
 * fija el array `controllers` del modulo, asi que conviene tenerlo cubierto.
 *
 * La autenticacion se sustituye por guards de prueba: lo que se comprueba aqui
 * es el enrutado y de que identidad sale cada parametro, no el JWT.
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

describe('SupportRequests controllers (HTTP)', () => {
  let app: INestApplication;
  let server: Server;

  const supportRequestsService = {
    createForDevice: jest.fn(),
    findCurrentForDevice: jest.fn(),
    acceptByDevice: jest.fn(),
    rejectByDevice: jest.fn(),
    cancelByDevice: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    assign: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Mismo orden que en `SupportRequestsModule`.
      controllers: [DeviceSupportRequestsController, SupportRequestsController],
      providers: [
        { provide: SupportRequestsService, useValue: supportRequestsService },
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

  it('crea la solicitud con el dispositivo del token y sin body', async () => {
    supportRequestsService.createForDevice.mockResolvedValue({
      id: randomUUID(),
      status: SupportRequestStatus.WAITING,
    });

    await request(server).post('/support-requests').expect(201);

    expect(supportRequestsService.createForDevice).toHaveBeenCalledWith(device);
  });

  it('ignora por completo un deviceId enviado en el body', async () => {
    supportRequestsService.createForDevice.mockResolvedValue({
      id: randomUUID(),
      status: SupportRequestStatus.WAITING,
    });

    await request(server)
      .post('/support-requests')
      .send({ deviceId: 'otro-dispositivo' })
      .expect(201);

    // El handler no declara `@Body()`: el cuerpo ni siquiera se lee, asi que no
    // hay forma de sugerirle al backend un dispositivo distinto al del token.
    expect(supportRequestsService.createForDevice).toHaveBeenCalledWith(device);
  });

  it('resuelve /current con el controlador del dispositivo, no con /:id', async () => {
    supportRequestsService.findCurrentForDevice.mockResolvedValue({
      supportRequest: null,
    });

    await request(server)
      .get('/support-requests/current')
      .expect(200, { supportRequest: null });

    expect(supportRequestsService.findCurrentForDevice).toHaveBeenCalledWith(
      device.id,
    );
    expect(supportRequestsService.findOne).not.toHaveBeenCalled();
  });

  it('responde 400 cuando el :id del dispositivo no es un UUID', async () => {
    await request(server)
      .post('/support-requests/no-es-uuid/accept')
      .expect(400);

    expect(supportRequestsService.acceptByDevice).not.toHaveBeenCalled();
  });

  it('acepta, rechaza y cancela con el dispositivo autenticado', async () => {
    const id = randomUUID();

    supportRequestsService.acceptByDevice.mockResolvedValue({});
    supportRequestsService.rejectByDevice.mockResolvedValue({});
    supportRequestsService.cancelByDevice.mockResolvedValue({});

    await request(server).post(`/support-requests/${id}/accept`).expect(200);
    await request(server).post(`/support-requests/${id}/reject`).expect(200);
    await request(server).post(`/support-requests/${id}/cancel`).expect(200);

    expect(supportRequestsService.acceptByDevice).toHaveBeenCalledWith(
      id,
      device,
    );
    expect(supportRequestsService.rejectByDevice).toHaveBeenCalledWith(
      id,
      device,
    );
    expect(supportRequestsService.cancelByDevice).toHaveBeenCalledWith(
      id,
      device,
    );
  });

  it('lista solicitudes filtrando por estado', async () => {
    supportRequestsService.findAll.mockResolvedValue([]);

    await request(server)
      .get('/support-requests')
      .query({ status: SupportRequestStatus.WAITING })
      .expect(200);

    expect(supportRequestsService.findAll).toHaveBeenCalledWith({
      status: SupportRequestStatus.WAITING,
    });
  });

  it('rechaza un estado que no existe en el filtro', async () => {
    await request(server)
      .get('/support-requests')
      .query({ status: 'LO-QUE-SEA' })
      .expect(400);

    expect(supportRequestsService.findAll).not.toHaveBeenCalled();
  });

  it('asigna con el tecnico autenticado y no con un technicianId del body', async () => {
    const id = randomUUID();

    supportRequestsService.assign.mockResolvedValue({});

    await request(server)
      .post(`/support-requests/${id}/assign`)
      .send({ technicianId: 'otro-tecnico' })
      .expect(200);

    // El body no se usa: el tecnico sale del usuario autenticado.
    expect(supportRequestsService.assign).toHaveBeenCalledWith(id, technician);
  });

  it('responde 400 cuando el :id del tecnico no es un UUID', async () => {
    await request(server).get('/support-requests/no-es-uuid').expect(400);

    expect(supportRequestsService.findOne).not.toHaveBeenCalled();
  });
});
