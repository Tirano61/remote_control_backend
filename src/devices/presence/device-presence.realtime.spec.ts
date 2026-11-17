import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import * as request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../auth/entities/user.entity';
import { ValidRoles } from '../../auth/interfaces/valid-roles';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { RemoteSession } from '../../remote-sessions/entities/remote-session.entity';
import {
  TECHNICIANS_NAMESPACE,
  TechniciansGateway,
} from '../../signaling/gateway/technicians.gateway';
import { SignalingRealtimeService } from '../../signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../../signaling/realtime/technician-realtime.service';
import { SignalingService } from '../../signaling/signaling.service';
import { SupportRequest } from '../../support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../../support-requests/enums/support-request-status.enum';
import { SupportRequestsController } from '../../support-requests/support-requests.controller';
import {
  SUPPORT_REQUEST_QUEUE_UPDATED_EVENT,
  SUPPORT_REQUEST_UPDATED_EVENT,
  SupportRequestsService,
} from '../../support-requests/support-requests.service';
import { DeviceAuthService } from '../auth/device-auth.service';
import { DeviceCredentialsService } from '../auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../auth/interfaces/device-jwt-payload.interface';
import { DeviceEnrollmentService } from '../device-enrollment.service';
import { DevicesController } from '../devices.controller';
import { DevicesService } from '../devices.service';
import { DeviceCredential } from '../entities/device-credential.entity';
import { Device } from '../entities/device.entity';
import {
  DEVICE_CONNECTED_EVENT,
  DEVICES_NAMESPACE,
  DevicesGateway,
} from '../gateway/devices.gateway';
import { DeviceRealtimeService } from '../realtime/device-realtime.service';
import {
  DEVICE_PRESENCE_UPDATED_EVENT,
  DevicePresenceService,
} from './device-presence.service';

/**
 * Cadena completa de `device:presence-updated`, sin mocks de gateways:
 *
 *   socket de tablet en /devices
 *   -> DevicesGateway -> DevicePresenceService
 *   -> TechnicianRealtimeService -> TechniciansGateway (/technicians)
 *   -> la consola recibe el aviso
 *   -> GET /devices y GET /support-requests ya devuelven el estado nuevo
 *
 * Los dos gateways, la autenticacion de ambos tokens, `@Auth()` con la
 * `JwtStrategy` real y los controladores son los de produccion. Solo se
 * sustituyen los repositorios de TypeORM por dobles en memoria.
 */
jest.setTimeout(30_000);

const USER_JWT_SECRET = 'user-secret-for-tests';
const DEVICE_JWT_SECRET = 'device-secret-for-tests';

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Eventos que una consola podria recibir; ninguno debe sustituir a otro. */
const OBSERVED_EVENTS = [
  DEVICE_PRESENCE_UPDATED_EVENT,
  SUPPORT_REQUEST_QUEUE_UPDATED_EVENT,
  SUPPORT_REQUEST_UPDATED_EVENT,
] as const;

type ObservedEvent = (typeof OBSERVED_EVENTS)[number];

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

const buildDevice = (id: string, publicId: string): Device => ({
  id,
  publicId,
  name: `Tablet ${publicId}`,
  manufacturer: 'Samsung',
  model: 'SM-X210',
  androidVersion: '14',
  appVersion: '1.0.0',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const technicianA = buildUser('Ana Tecnica', [ValidRoles.tecnico]);
const adminC = buildUser('Carla Admin', [ValidRoles.admin]);
const plainUser = buildUser('Dario Usuario', [ValidRoles.user]);
const salesUser = buildUser('Elena Ventas', [ValidRoles.sales]);

interface DeviceRow {
  id: string;
  isOnline: boolean;
}

interface SupportRequestRow {
  id: string;
  device: { id: string; isOnline: boolean };
}

describe('device:presence-updated de punta a punta (Socket.IO + REST)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let server: Server;
  let presence: DevicePresenceService;
  let technicianRealtimeService: TechnicianRealtimeService;
  let deviceEnrollmentService: DeviceEnrollmentService;
  let userJwt: JwtService;
  let deviceJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const users: Record<string, User> = {};
  let devices: Record<string, Device> = {};
  /** deviceId -> id de la credencial vigente (las demas estan revocadas). */
  let activeCredentials: Record<string, string> = {};
  let supportRequests: SupportRequest[] = [];

  const openClients: ClientSocket[] = [];

  const received = new WeakMap<
    ClientSocket,
    Record<ObservedEvent, unknown[]>
  >();

  const userRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(users[id] ?? null),
  };

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(devices[id] ?? null),
    find: () => Promise.resolve(Object.values(devices)),
    preload: ({ id, ...changes }: Partial<Device> & { id: string }) =>
      Promise.resolve(
        devices[id] ? ({ ...devices[id], ...changes } as Device) : undefined,
      ),
    save: (updated: Device) => {
      devices[updated.id] = { ...devices[updated.id], ...updated };
      return Promise.resolve(devices[updated.id]);
    },
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) => {
      const id = activeCredentials[where.deviceId];

      return Promise.resolve(
        id ? { id, deviceId: where.deviceId, secretHash: 'hash' } : null,
      );
    },
    update: () => Promise.resolve({ affected: 1 }),
  };

  const supportRequestRepository = {
    find: () =>
      Promise.resolve(
        supportRequests.map((row) => ({
          ...row,
          device: devices[row.deviceId],
          technician: null,
        })),
      ),
  };

  /**
   * La transaccion de activacion (validar el codigo, revocar la credencial
   * anterior y emitir la nueva) ya se prueba en
   * `device-enrollment.service.spec.ts`. Aqui importa lo que pasa DESPUES de
   * confirmarla: el cierre de los sockets de la credencial revocada.
   */
  const dataSource = { transaction: jest.fn() };

  const connect = (namespace: string, token: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(`${baseUrl}${namespace}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token },
      });

      openClients.push(client);

      const events = {} as Record<ObservedEvent, unknown[]>;

      for (const event of OBSERVED_EVENTS) {
        events[event] = [];
        client.on(event, (payload: unknown) => events[event].push(payload));
      }

      received.set(client, events);

      client.once('connect', () => resolve(client));
      client.once('connect_error', (error: Error) => reject(error));
    });

  const tokenFor = (user: User): string => userJwt.sign({ id: user.id });

  const connectTechnician = (user: User): Promise<ClientSocket> =>
    connect(TECHNICIANS_NAMESPACE, tokenFor(user));

  const deviceToken = (
    deviceId: string,
    credentialId = activeCredentials[deviceId],
  ): string =>
    deviceJwt.sign({
      sub: deviceId,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId,
    } as DeviceJwtPayload);

  const connectTablet = (
    deviceId: string,
    credentialId?: string,
  ): Promise<ClientSocket> =>
    connect(DEVICES_NAMESPACE, deviceToken(deviceId, credentialId));

  const presenceEvents = (client: ClientSocket): unknown[] =>
    received.get(client)?.[DEVICE_PRESENCE_UPDATED_EVENT] ?? [];

  const waitFor = async (
    condition: () => boolean,
    description: string,
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;

    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timeout: ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /** Margen para que un mensaje que NO debe llegar tuviera tiempo de llegar. */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 150));

  /** Espera a que cada consola tenga `count` avisos y que no llegue otro. */
  const expectPresenceEvents = async (
    clients: ClientSocket[],
    deviceIds: string[],
  ): Promise<void> => {
    await waitFor(
      () =>
        clients.every(
          (client) => presenceEvents(client).length >= deviceIds.length,
        ),
      `${deviceIds.length} x ${DEVICE_PRESENCE_UPDATED_EVENT}`,
    );

    await settle();

    for (const client of clients)
      expect(presenceEvents(client)).toEqual(
        deviceIds.map((deviceId) => ({ deviceId })),
      );
  };

  const getDevices = async (as: User = technicianA): Promise<DeviceRow[]> => {
    const response = await request(server)
      .get('/devices')
      .set('Authorization', `Bearer ${tokenFor(as)}`)
      .expect(200);

    return response.body as DeviceRow[];
  };

  const restOnline = async (deviceId: string) => {
    const deviceRows = await getDevices();

    const supportResponse = await request(server)
      .get('/support-requests')
      .set('Authorization', `Bearer ${tokenFor(technicianA)}`)
      .expect(200);

    const supportRows = (supportResponse.body as SupportRequestRow[]).filter(
      (row) => row.device.id === deviceId,
    );

    return {
      devices: deviceRows.find((row) => row.id === deviceId)?.isOnline,
      supportRequests: supportRows.map((row) => row.device.isOnline),
    };
  };

  const seedWaiting = (deviceId: string): void => {
    supportRequests.push({
      id: randomUUID(),
      deviceId,
      status: SupportRequestStatus.WAITING,
      technicianId: null,
      assignedAt: null,
      respondedAt: null,
      closedAt: null,
      createdAt: new Date(),
    } as SupportRequest);
  };

  /** Consolas autorizadas: un tecnico y un admin. */
  const connectConsoles = async () => {
    const consoles = {
      tech: await connectTechnician(technicianA),
      admin: await connectTechnician(adminC),
    };

    await settle();

    return consoles;
  };

  const closeAndWait = async (client: ClientSocket): Promise<void> => {
    client.close();
    await settle();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // El JwtService inyectable es el del dispositivo; el de usuario lo
        // construye la factoria de AuthService con su propio secreto.
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
        // `@Auth()` usa `AuthGuard()` sin nombre: la estrategia por defecto.
        PassportModule.register({ defaultStrategy: 'jwt' }),
      ],
      controllers: [DevicesController, SupportRequestsController],
      providers: [
        DevicesGateway,
        TechniciansGateway,
        DevicePresenceService,
        DeviceRealtimeService,
        TechnicianRealtimeService,
        DeviceAuthService,
        DeviceCredentialsService,
        DevicesService,
        DeviceEnrollmentService,
        SupportRequestsService,
        JwtStrategy,
        // Dependencias de signaling de los gateways: no se ejercitan aqui.
        SignalingService,
        SignalingRealtimeService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_SECRET_KEY' ? USER_JWT_SECRET : undefined,
          },
        },
        {
          provide: AuthService,
          useFactory: () =>
            new AuthService(
              userRepository as unknown as Repository<User>,
              new JwtService({
                secret: USER_JWT_SECRET,
                signOptions: { expiresIn: '1h' },
              }),
            ),
        },
        {
          provide: getRepositoryToken(RemoteSession),
          useValue: { findOne: () => Promise.resolve(null) },
        },
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
        {
          provide: getRepositoryToken(SupportRequest),
          useValue:
            supportRequestRepository as unknown as Repository<SupportRequest>,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    // Mismas reglas que `main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );

    presence = app.get(DevicePresenceService);
    technicianRealtimeService = app.get(TechnicianRealtimeService);
    deviceEnrollmentService = app.get(DeviceEnrollmentService);
    deviceJwt = app.get(JwtService);
    userJwt = new JwtService({
      secret: USER_JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    });

    await app.listen(0);

    server = app.getHttpServer() as Server;
    const { port } = server.address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    for (const user of [technicianA, adminC, plainUser, salesUser])
      users[user.id] = user;

    devices = {
      [DEVICE_A_ID]: buildDevice(DEVICE_A_ID, '384-729-142'),
      [DEVICE_B_ID]: buildDevice(DEVICE_B_ID, '511-204-873'),
    };
    activeCredentials = {
      [DEVICE_A_ID]: randomUUID(),
      [DEVICE_B_ID]: randomUUID(),
    };
    supportRequests = [];
    dataSource.transaction.mockReset();
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await waitFor(
      () =>
        presence.connectionCount(DEVICE_A_ID) === 0 &&
        presence.connectionCount(DEVICE_B_ID) === 0,
      'presencia vacia entre pruebas',
    );
    await settle();
  });

  afterAll(async () => {
    await app.close();
  });

  it('OFFLINE -> ONLINE: un aviso a tecnico y admin, y REST ya devuelve ONLINE', async () => {
    const { tech, admin } = await connectConsoles();
    seedWaiting(DEVICE_A_ID);

    expect(await restOnline(DEVICE_A_ID)).toEqual({
      devices: false,
      supportRequests: [false],
    });

    // REST se consulta en cuanto llega el aviso, desde el propio handler: es
    // el escenario T10A (la web recarga al recibirlo).
    const restAtEvent = new Promise<Awaited<ReturnType<typeof restOnline>>>(
      (resolve, reject) =>
        tech.once(DEVICE_PRESENCE_UPDATED_EVENT, () => {
          restOnline(DEVICE_A_ID).then(resolve, reject);
        }),
    );

    await connectTablet(DEVICE_A_ID);

    expect(await restAtEvent).toEqual({
      devices: true,
      supportRequests: [true],
    });

    await expectPresenceEvents([tech, admin], [DEVICE_A_ID]);

    // Es un aviso de presencia: no se disfraza de evento de solicitudes.
    for (const client of [tech, admin]) {
      expect(
        received.get(client)?.[SUPPORT_REQUEST_QUEUE_UPDATED_EVENT],
      ).toEqual([]);
      expect(received.get(client)?.[SUPPORT_REQUEST_UPDATED_EVENT]).toEqual([]);
    }
  });

  it('segundo socket del mismo dispositivo: ningun aviso nuevo', async () => {
    const { tech } = await connectConsoles();

    await connectTablet(DEVICE_A_ID);
    await expectPresenceEvents([tech], [DEVICE_A_ID]);

    await connectTablet(DEVICE_A_ID);
    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 2,
      'dos sockets',
    );

    await expectPresenceEvents([tech], [DEVICE_A_ID]);
  });

  it('desconexion parcial (2 -> 1): sigue ONLINE y sin aviso', async () => {
    const { tech } = await connectConsoles();

    const first = await connectTablet(DEVICE_A_ID);
    await connectTablet(DEVICE_A_ID);
    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 2,
      'dos sockets',
    );

    await closeAndWait(first);
    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 1,
      'un socket',
    );

    await expectPresenceEvents([tech], [DEVICE_A_ID]);
    expect((await restOnline(DEVICE_A_ID)).devices).toBe(true);
  });

  it('ONLINE -> OFFLINE: un aviso y REST ya devuelve OFFLINE', async () => {
    const { tech, admin } = await connectConsoles();
    seedWaiting(DEVICE_A_ID);

    const tablet = await connectTablet(DEVICE_A_ID);
    await expectPresenceEvents([tech, admin], [DEVICE_A_ID]);

    const restAtEvent = new Promise<Awaited<ReturnType<typeof restOnline>>>(
      (resolve, reject) =>
        tech.once(DEVICE_PRESENCE_UPDATED_EVENT, () => {
          restOnline(DEVICE_A_ID).then(resolve, reject);
        }),
    );

    tablet.close();

    expect(await restAtEvent).toEqual({
      devices: false,
      supportRequests: [false],
    });

    await expectPresenceEvents([tech, admin], [DEVICE_A_ID, DEVICE_A_ID]);
  });

  it('reconexion: A conectado, B conecta, A cae -> sigue ONLINE y sin OFFLINE falso', async () => {
    const { tech } = await connectConsoles();

    const oldSocket = await connectTablet(DEVICE_A_ID);
    await connectTablet(DEVICE_A_ID);
    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 2,
      'socket viejo y nuevo',
    );

    await closeAndWait(oldSocket);

    expect(presence.isOnline(DEVICE_A_ID)).toBe(true);
    expect((await restOnline(DEVICE_A_ID)).devices).toBe(true);
    await expectPresenceEvents([tech], [DEVICE_A_ID]);
  });

  it('desactivacion (PATCH isActive:false): exactamente un aviso OFFLINE', async () => {
    const { tech, admin } = await connectConsoles();

    const first = await connectTablet(DEVICE_A_ID);
    await connectTablet(DEVICE_A_ID);
    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 2,
      'dos sockets',
    );

    const closed = new Promise((resolve) => first.once('disconnect', resolve));

    await request(server)
      .patch(`/devices/${DEVICE_A_ID}`)
      .set('Authorization', `Bearer ${tokenFor(adminC)}`)
      .send({ isActive: false })
      .expect(200)
      .expect((response) =>
        expect((response.body as DeviceRow).isOnline).toBe(false),
      );

    await closed;

    // ONLINE inicial + un unico OFFLINE, aunque se cerraran dos sockets.
    await expectPresenceEvents([tech, admin], [DEVICE_A_ID, DEVICE_A_ID]);
    expect((await getDevices()).find((d) => d.id === DEVICE_A_ID)).toEqual(
      expect.objectContaining({ isActive: false, isOnline: false }),
    );

    // Con el dispositivo deshabilitado no puede volver a conectarse.
    await expect(connectTablet(DEVICE_A_ID)).rejects.toThrow('Unauthorized');
    await expectPresenceEvents([tech], [DEVICE_A_ID, DEVICE_A_ID]);
  });

  it('desactivar un dispositivo que ya esta OFFLINE no avisa', async () => {
    const { tech } = await connectConsoles();

    await request(server)
      .patch(`/devices/${DEVICE_A_ID}`)
      .set('Authorization', `Bearer ${tokenFor(adminC)}`)
      .send({ isActive: false })
      .expect(200);

    await settle();
    expect(presenceEvents(tech)).toEqual([]);
  });

  it('re-enrolamiento: un OFFLINE por la credencial revocada y un ONLINE con la nueva, sin duplicados', async () => {
    const { tech } = await connectConsoles();

    const oldCredentialId = activeCredentials[DEVICE_A_ID];
    const oldSocket = await connectTablet(DEVICE_A_ID);
    await expectPresenceEvents([tech], [DEVICE_A_ID]);

    // La transaccion confirma la rotacion de la credencial.
    const newCredentialId = randomUUID();
    dataSource.transaction.mockImplementation(() => {
      activeCredentials[DEVICE_A_ID] = newCredentialId;

      return Promise.resolve({
        activated: true,
        deviceId: DEVICE_A_ID,
        publicId: devices[DEVICE_A_ID].publicId,
        name: devices[DEVICE_A_ID].name,
        deviceSecret: 'nunca-sale-en-el-aviso',
      });
    });

    const closed = new Promise((resolve) =>
      oldSocket.once('disconnect', resolve),
    );

    await deviceEnrollmentService.activate({
      publicId: devices[DEVICE_A_ID].publicId,
      code: '123456',
    });
    await closed;

    await expectPresenceEvents([tech], [DEVICE_A_ID, DEVICE_A_ID]);
    expect((await restOnline(DEVICE_A_ID)).devices).toBe(false);

    // El token de la credencial revocada ya no autentica.
    await expect(connectTablet(DEVICE_A_ID, oldCredentialId)).rejects.toThrow(
      'Unauthorized',
    );

    await connectTablet(DEVICE_A_ID, newCredentialId);

    await expectPresenceEvents([tech], [DEVICE_A_ID, DEVICE_A_ID, DEVICE_A_ID]);
    expect((await restOnline(DEVICE_A_ID)).devices).toBe(true);

    // Nada del secreto ni de la credencial viaja en los avisos.
    expect(JSON.stringify(presenceEvents(tech))).not.toContain(
      'nunca-sale-en-el-aviso',
    );
    expect(JSON.stringify(presenceEvents(tech))).not.toContain(newCredentialId);
  });

  it('varios dispositivos: la presencia de A no produce avisos de B', async () => {
    const { tech } = await connectConsoles();

    const tabletB = await connectTablet(DEVICE_B_ID);
    await expectPresenceEvents([tech], [DEVICE_B_ID]);

    const tabletA = await connectTablet(DEVICE_A_ID);
    await closeAndWait(tabletA);

    await expectPresenceEvents([tech], [DEVICE_B_ID, DEVICE_A_ID, DEVICE_A_ID]);
    expect(presence.isOnline(DEVICE_B_ID)).toBe(true);

    // Las tablets nunca reciben el aviso: es solo para /technicians.
    expect(presenceEvents(tabletB)).toEqual([]);
  });

  describe('autorizacion', () => {
    it.each([
      ['user', plainUser],
      ['sales', salesUser],
    ])(
      'un usuario con rol %s no puede abrir /technicians y no recibe nada',
      async (_role, user) => {
        await expect(connectTechnician(user)).rejects.toThrow('Unauthorized');
      },
    );

    it('ni un socket sin token ni las tablets reciben el aviso', async () => {
      await expect(connect(TECHNICIANS_NAMESPACE, '')).rejects.toThrow(
        'Unauthorized',
      );

      const { tech } = await connectConsoles();
      const tabletB = await connectTablet(DEVICE_B_ID);
      await connectTablet(DEVICE_A_ID);

      await expectPresenceEvents([tech], [DEVICE_B_ID, DEVICE_A_ID]);
      expect(presenceEvents(tabletB)).toEqual([]);
    });

    it('cada pestana del mismo tecnico recibe su copia', async () => {
      const first = await connectTechnician(technicianA);
      const second = await connectTechnician(technicianA);
      await settle();

      await connectTablet(DEVICE_A_ID);

      await expectPresenceEvents([first, second], [DEVICE_A_ID]);
    });
  });

  describe('si el aviso falla', () => {
    let emitToAll: jest.SpyInstance;
    let logError: jest.SpyInstance;

    beforeEach(() => {
      // El fallo se registra a proposito; no ensucia la salida de la prueba.
      logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      emitToAll = jest
        .spyOn(technicianRealtimeService, 'emitToAllTechnicians')
        .mockImplementation(() => {
          throw new Error('transporte caido');
        });
    });

    afterEach(() => {
      emitToAll.mockRestore();
      logError.mockRestore();
    });

    it('la tablet conecta igual, recibe device:connected y REST la ve ONLINE', async () => {
      const tablet = io(`${baseUrl}${DEVICES_NAMESPACE}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token: deviceToken(DEVICE_A_ID) },
      });
      openClients.push(tablet);

      // Se escucha antes de conectar: la confirmacion llega junto al `connect`.
      const confirmed = new Promise((resolve) =>
        tablet.once(DEVICE_CONNECTED_EVENT, resolve),
      );

      await expect(confirmed).resolves.toEqual({
        deviceId: DEVICE_A_ID,
        publicId: devices[DEVICE_A_ID].publicId,
      });
      await waitFor(() => presence.isOnline(DEVICE_A_ID), 'ONLINE');

      expect(emitToAll).toHaveBeenCalledWith(DEVICE_PRESENCE_UPDATED_EVENT, {
        deviceId: DEVICE_A_ID,
      });
      expect((await restOnline(DEVICE_A_ID)).devices).toBe(true);
      expect(logError).toHaveBeenCalledTimes(1);
      expect(tablet.connected).toBe(true);
    });
  });
});
