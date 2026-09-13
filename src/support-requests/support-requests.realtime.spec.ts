import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { DataSource, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { DeviceAuthService } from '../devices/auth/device-auth.service';
import { DeviceCredentialsService } from '../devices/auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../devices/auth/interfaces/device-jwt-payload.interface';
import { DeviceCredential } from '../devices/entities/device-credential.entity';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import {
  DEVICES_NAMESPACE,
  DevicesGateway,
} from '../devices/gateway/devices.gateway';
import { SupportRequest } from './entities/support-request.entity';
import { SupportRequestStatus } from './enums/support-request-status.enum';
import {
  SUPPORT_ASSIGNED_EVENT,
  SupportRequestsService,
} from './support-requests.service';

/**
 * Entrega real de `support:assigned` sobre Socket.IO.
 *
 * El gateway, la autenticacion del Device JWT y la salida de eventos son los de
 * produccion: `SupportRequestsService` emite sin conocer Socket.IO y el aviso
 * tiene que llegar al socket del dispositivo correcto, y solo a ese.
 *
 * Solo se sustituyen los repositorios de TypeORM por dobles en memoria: estas
 * pruebas no necesitan PostgreSQL.
 */
jest.setTimeout(20_000);

const DEVICE_JWT_SECRET = 'device-secret-for-tests';

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CREDENTIAL_A_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CREDENTIAL_B_ID = 'b1f6d2f4-1f4a-4a2e-9d6e-2a0f7a5c9d31';

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

describe('support:assigned (Socket.IO)', () => {
  let app: INestApplication;
  let url: string;
  let presence: DevicePresenceService;
  let supportRequestsService: SupportRequestsService;
  let deviceJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const devices: Record<string, Device> = {};
  let supportRequests: SupportRequest[] = [];

  const openClients: ClientSocket[] = [];

  /** Eventos `support:assigned` recibidos por cada socket. */
  const received = new WeakMap<ClientSocket, unknown[]>();

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(devices[id] ?? null),
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      Promise.resolve(
        where.deviceId === DEVICE_A_ID
          ? { id: CREDENTIAL_A_ID, deviceId: DEVICE_A_ID, secretHash: 'hash' }
          : { id: CREDENTIAL_B_ID, deviceId: DEVICE_B_ID, secretHash: 'hash' },
      ),
    update: () => Promise.resolve({ affected: 1 }),
  };

  /** Lo justo que usa `assign`: leer la solicitud y el UPDATE condicional. */
  const supportRequestRepository = {
    findOne: ({ where }: { where: { id: string } }) => {
      const row = supportRequests.find(
        (candidate) => candidate.id === where.id,
      );

      return Promise.resolve(
        row
          ? { ...row, device: devices[row.deviceId], technician: null }
          : null,
      );
    },
    createQueryBuilder: () => {
      let changes: Partial<SupportRequest> = {};
      const params: Record<string, unknown> = {};

      const builder = {
        update: () => builder,
        set: (values: Partial<SupportRequest>) => {
          changes = values;
          return builder;
        },
        where: (_sql: string, parameters: Record<string, unknown>) => {
          Object.assign(params, parameters);
          return builder;
        },
        andWhere: (_sql: string, parameters: Record<string, unknown>) => {
          Object.assign(params, parameters);
          return builder;
        },
        execute: () => {
          const from = params.from as SupportRequestStatus[];
          const row = supportRequests.find(
            (candidate) =>
              candidate.id === params.id && from.includes(candidate.status),
          );

          if (!row) return Promise.resolve({ affected: 0 });

          Object.assign(row, changes);

          return Promise.resolve({ affected: 1 });
        },
      };

      return builder;
    },
  };

  /**
   * `EntityManager` con lo justo que usa `assign`: el UPDATE condicional.
   *
   * El servicio lo pide al `DataSource` en lugar de al repositorio para poder
   * ejecutar la cancelacion dentro de su transaccion; aqui no hay ninguna.
   */
  const entityManager = {
    createQueryBuilder: () => supportRequestRepository.createQueryBuilder(),
  };

  const signDeviceToken = (deviceId: string, credentialId: string): string =>
    deviceJwt.sign({
      sub: deviceId,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId,
    } as DeviceJwtPayload);

  const connect = (token: string): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token },
      });

      openClients.push(client);
      received.set(client, []);

      client.on(SUPPORT_ASSIGNED_EVENT, (payload: unknown) =>
        received.get(client)?.push(payload),
      );

      client.once('connect', () => resolve(client));
      client.once('connect_error', (error: Error) => reject(error));
    });

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

  const eventsOf = (client: ClientSocket): unknown[] =>
    received.get(client) ?? [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      providers: [
        DevicesGateway,
        DevicePresenceService,
        DeviceRealtimeService,
        DeviceAuthService,
        DeviceCredentialsService,
        SupportRequestsService,
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
        { provide: DataSource, useValue: { manager: entityManager } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    presence = app.get(DevicePresenceService);
    supportRequestsService = app.get(SupportRequestsService);
    deviceJwt = app.get(JwtService);

    await app.listen(0);

    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}${DEVICES_NAMESPACE}`;
  });

  beforeEach(() => {
    devices[DEVICE_A_ID] = buildDevice(DEVICE_A_ID, '384-729-142');
    devices[DEVICE_B_ID] = buildDevice(DEVICE_B_ID, '111-222-333');

    supportRequests = [
      {
        id: randomUUID(),
        deviceId: DEVICE_A_ID,
        status: SupportRequestStatus.WAITING,
        technicianId: null,
        assignedAt: null,
        respondedAt: null,
        closedAt: null,
        createdAt: new Date(),
      } as SupportRequest,
    ];
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await waitFor(
      () =>
        presence.connectionCount(DEVICE_A_ID) === 0 &&
        presence.connectionCount(DEVICE_B_ID) === 0,
      'presencia vacia entre pruebas',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('entrega support:assigned solo al dispositivo dueno de la solicitud', async () => {
    const tabletA = await connect(
      signDeviceToken(DEVICE_A_ID, CREDENTIAL_A_ID),
    );
    const tabletB = await connect(
      signDeviceToken(DEVICE_B_ID, CREDENTIAL_B_ID),
    );

    await waitFor(
      () => presence.isOnline(DEVICE_A_ID) && presence.isOnline(DEVICE_B_ID),
      'ambos dispositivos ONLINE',
    );

    const supportRequestId = supportRequests[0].id;

    await supportRequestsService.assign(supportRequestId, technician);

    await waitFor(
      () => eventsOf(tabletA).length === 1,
      `${SUPPORT_ASSIGNED_EVENT} en la tablet asignada`,
    );

    expect(eventsOf(tabletA)[0]).toEqual({
      supportRequestId,
      technician: { id: technician.id, name: technician.fullName },
    });

    // El otro dispositivo no debe enterarse: las rooms las asigna el servidor
    // con la identidad del token, no el cliente.
    expect(eventsOf(tabletB)).toHaveLength(0);
  });

  it('llega a todas las conexiones del mismo dispositivo', async () => {
    const first = await connect(signDeviceToken(DEVICE_A_ID, CREDENTIAL_A_ID));
    const second = await connect(signDeviceToken(DEVICE_A_ID, CREDENTIAL_A_ID));

    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 2,
      'dos sockets registrados',
    );

    await supportRequestsService.assign(supportRequests[0].id, technician);

    await waitFor(
      () => eventsOf(first).length === 1 && eventsOf(second).length === 1,
      `${SUPPORT_ASSIGNED_EVENT} en ambas conexiones`,
    );
  });

  it('mantiene la asignacion aunque la tablet ya no reciba el aviso', async () => {
    const tablet = await connect(signDeviceToken(DEVICE_A_ID, CREDENTIAL_A_ID));

    await waitFor(() => presence.isOnline(DEVICE_A_ID), 'dispositivo ONLINE');

    const assigned = await supportRequestsService.assign(
      supportRequests[0].id,
      technician,
    );

    tablet.close();

    // El estado vive en PostgreSQL: al reconectarse la tablet lo recupera con
    // GET /support-requests/current.
    expect(assigned.status).toBe(SupportRequestStatus.ASSIGNED);
    expect(supportRequests[0].status).toBe(SupportRequestStatus.ASSIGNED);
  });
});
