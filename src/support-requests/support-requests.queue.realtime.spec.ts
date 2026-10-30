import { ConflictException, INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { DataSource, Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
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
import {
  DEVICES_NAMESPACE,
  DevicesGateway,
} from '../devices/gateway/devices.gateway';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import {
  TECHNICIANS_NAMESPACE,
  TechniciansGateway,
} from '../signaling/gateway/technicians.gateway';
import { SignalingRealtimeService } from '../signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../signaling/realtime/technician-realtime.service';
import { REMOTE_SESSION_JOIN_EVENT } from '../signaling/signaling.events';
import { SignalingService } from '../signaling/signaling.service';
import { SupportRequest } from './entities/support-request.entity';
import { SupportRequestStatus } from './enums/support-request-status.enum';
import {
  SUPPORT_ASSIGNED_EVENT,
  SUPPORT_REQUEST_QUEUE_UPDATED_EVENT,
  SUPPORT_REQUEST_UPDATED_EVENT,
  SupportRequestsService,
} from './support-requests.service';

/**
 * Entrega real de `support-request:queue-updated` sobre Socket.IO.
 *
 * Los dos gateways (`/devices` y `/technicians`), la autenticacion de ambos
 * tokens y la salida de eventos son los de produccion. El aviso de la cola tiene
 * que llegar a todos los sockets de tecnicos y admins, sin `remote-session:join`
 * y sin ninguna `RemoteSession`, y a nadie mas.
 *
 * Solo se sustituyen los repositorios de TypeORM por dobles en memoria: estas
 * pruebas no necesitan PostgreSQL.
 */
jest.setTimeout(20_000);

const USER_JWT_SECRET = 'user-secret-for-tests';
const DEVICE_JWT_SECRET = 'device-secret-for-tests';

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const CREDENTIAL_A_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Eventos de solicitudes que un socket podria recibir por error. */
const OBSERVED_EVENTS = [
  SUPPORT_REQUEST_QUEUE_UPDATED_EVENT,
  SUPPORT_REQUEST_UPDATED_EVENT,
  SUPPORT_ASSIGNED_EVENT,
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

const deviceA: Device = {
  id: DEVICE_A_ID,
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

const technicianA = buildUser('Ana Tecnica', [ValidRoles.tecnico]);
const technicianB = buildUser('Beto Tecnico', [ValidRoles.tecnico]);
const adminC = buildUser('Carla Admin', [ValidRoles.admin]);
const plainUser = buildUser('Dario Usuario', [ValidRoles.user]);
const salesUser = buildUser('Elena Ventas', [ValidRoles.sales]);

describe('support-request:queue-updated hacia todos los tecnicos (Socket.IO)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let presence: DevicePresenceService;
  let supportRequestsService: SupportRequestsService;
  let technicianRealtimeService: TechnicianRealtimeService;
  let userJwt: JwtService;
  let deviceJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const users: Record<string, User> = {};
  let supportRequests: SupportRequest[] = [];

  const openClients: ClientSocket[] = [];

  /** Eventos recibidos por cada socket, por nombre. */
  const received = new WeakMap<
    ClientSocket,
    Record<ObservedEvent, unknown[]>
  >();

  const userRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(users[id] ?? null),
  };

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) =>
      Promise.resolve(id === DEVICE_A_ID ? deviceA : null),
  };

  const deviceCredentialRepository = {
    findOne: () =>
      Promise.resolve({
        id: CREDENTIAL_A_ID,
        deviceId: DEVICE_A_ID,
        secretHash: 'hash',
      }),
    update: () => Promise.resolve({ affected: 1 }),
  };

  const findRow = (where: {
    id: string;
    deviceId?: string;
  }): SupportRequest | undefined =>
    supportRequests.find(
      (row) =>
        row.id === where.id &&
        (where.deviceId === undefined || row.deviceId === where.deviceId),
    );

  /** Lo que usan crear, asignar y cancelar: INSERT, lectura y UPDATE. */
  const supportRequestRepository = {
    create: (partial: Partial<SupportRequest>) => ({ ...partial }),
    // Sin indice unico: la regla de una activa por dispositivo se prueba en
    // `support-requests.service.spec.ts`.
    save: (entity: SupportRequest) => {
      const row = {
        ...entity,
        id: randomUUID(),
        createdAt: new Date(),
      } as SupportRequest;

      supportRequests.push(row);

      return Promise.resolve({ ...row });
    },
    findOne: ({ where }: { where: { id: string; deviceId?: string } }) => {
      const row = findRow(where);

      return Promise.resolve(
        row
          ? {
              ...row,
              device: deviceA,
              technician: row.technicianId ? users[row.technicianId] : null,
            }
          : null,
      );
    },
  };

  /** El UPDATE condicional de las transiciones. */
  const createUpdateBuilder = () => {
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
  };

  /** Sin locks ni rollback: estas pruebas no ejercitan carreras. */
  const entityManager = {
    createQueryBuilder: createUpdateBuilder,
    // Una copia, como haria TypeORM: el UPDATE posterior no la modifica.
    findOne: (
      _entity: unknown,
      { where }: { where: { id: string; deviceId?: string } },
    ) => {
      const row = findRow(where);

      return Promise.resolve(row ? { ...row } : null);
    },
    // Aqui no existe ninguna RemoteSession: el aviso no depende de ella.
    exists: () => Promise.resolve(false),
  };

  const dataSource = {
    manager: entityManager,
    transaction: (runInTransaction: (manager: unknown) => Promise<unknown>) =>
      runInTransaction(entityManager),
  };

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

  const connectTechnician = (user: User): Promise<ClientSocket> =>
    connect(TECHNICIANS_NAMESPACE, userJwt.sign({ id: user.id }));

  const connectTablet = async (): Promise<ClientSocket> => {
    const tablet = await connect(
      DEVICES_NAMESPACE,
      deviceJwt.sign({
        sub: DEVICE_A_ID,
        tokenType: DEVICE_TOKEN_TYPE,
        credentialId: CREDENTIAL_A_ID,
      } as DeviceJwtPayload),
    );

    // `assign` exige la tablet ONLINE.
    await waitFor(() => presence.isOnline(DEVICE_A_ID), 'tablet ONLINE');

    return tablet;
  };

  const eventsOf = (
    client: ClientSocket,
    event: ObservedEvent = SUPPORT_REQUEST_QUEUE_UPDATED_EVENT,
  ): unknown[] => received.get(client)?.[event] ?? [];

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
    new Promise((resolve) => setTimeout(resolve, 100));

  /** Las tres consolas autorizadas, sin join y sin sesion remota. */
  const connectConsoles = async () => {
    const consoles = {
      a: await connectTechnician(technicianA),
      b: await connectTechnician(technicianB),
      c: await connectTechnician(adminC),
    };

    await settle();

    return consoles;
  };

  const expectExactlyOne = async (
    clients: ClientSocket[],
    supportRequestId: string,
  ): Promise<void> => {
    await waitFor(
      () => clients.every((client) => eventsOf(client).length >= 1),
      `${SUPPORT_REQUEST_QUEUE_UPDATED_EVENT} en todas las consolas`,
    );

    // Que no llegue un segundo aviso rezagado.
    await settle();

    for (const client of clients)
      expect(eventsOf(client)).toEqual([{ supportRequestId }]);
  };

  /** Siembra una WAITING sin pasar por el servicio, para no generar avisos. */
  const seedWaiting = (): string => {
    const id = randomUUID();

    supportRequests.push({
      id,
      deviceId: DEVICE_A_ID,
      status: SupportRequestStatus.WAITING,
      technicianId: null,
      assignedAt: null,
      respondedAt: null,
      closedAt: null,
      createdAt: new Date(),
    } as SupportRequest);

    return id;
  };

  const statusOf = (id: string): SupportRequestStatus | undefined =>
    supportRequests.find((row) => row.id === id)?.status;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // El JwtService inyectable es el del dispositivo; el de usuario lo
        // construye la factoria de AuthService con su propio secreto.
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      providers: [
        DevicesGateway,
        TechniciansGateway,
        DevicePresenceService,
        DeviceRealtimeService,
        DeviceAuthService,
        DeviceCredentialsService,
        TechnicianRealtimeService,
        SupportRequestsService,
        // Dependencias de signaling de los gateways: no se ejercitan aqui.
        SignalingService,
        SignalingRealtimeService,
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

    presence = app.get(DevicePresenceService);
    supportRequestsService = app.get(SupportRequestsService);
    technicianRealtimeService = app.get(TechnicianRealtimeService);
    deviceJwt = app.get(JwtService);
    userJwt = new JwtService({
      secret: USER_JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    });

    await app.listen(0);

    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    for (const user of [technicianA, technicianB, adminC, plainUser, salesUser])
      users[user.id] = user;

    supportRequests = [];
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 0,
      'presencia vacia entre pruebas',
    );
    await settle();
  });

  afterAll(async () => {
    await app.close();
  });

  it('CREATE: tecnico A, tecnico B y admin C reciben un aviso cada uno', async () => {
    const { a, b, c } = await connectConsoles();

    const created = await supportRequestsService.createForDevice(deviceA);

    expect(created.status).toBe(SupportRequestStatus.WAITING);
    expect(statusOf(created.id)).toBe(SupportRequestStatus.WAITING);

    await expectExactlyOne([a, b, c], created.id);

    // Es la cola comun, no el aviso al propietario: aun no hay ninguno.
    for (const client of [a, b, c])
      expect(eventsOf(client, SUPPORT_REQUEST_UPDATED_EVENT)).toHaveLength(0);
  });

  it('ASSIGN: todas las consolas reciben la cola y la tablet support:assigned', async () => {
    const tablet = await connectTablet();
    const { a, b, c } = await connectConsoles();
    const id = seedWaiting();

    const assigned = await supportRequestsService.assign(id, technicianA);

    expect(assigned.status).toBe(SupportRequestStatus.ASSIGNED);

    // El tecnico que asigno tambien recibe el aviso: le sirve para reconciliar.
    await expectExactlyOne([a, b, c], id);

    await waitFor(
      () => eventsOf(tablet, SUPPORT_ASSIGNED_EVENT).length === 1,
      `${SUPPORT_ASSIGNED_EVENT} en la tablet`,
    );
    expect(eventsOf(tablet, SUPPORT_ASSIGNED_EVENT)).toEqual([
      {
        supportRequestId: id,
        technician: { id: technicianA.id, name: technicianA.fullName },
      },
    ]);

    // Cada evento a su destinatario: ni la tablet ve la cola de tecnicos, ni
    // los tecnicos reciben el aviso dirigido al dispositivo.
    expect(eventsOf(tablet)).toHaveLength(0);
    for (const client of [a, b, c])
      expect(eventsOf(client, SUPPORT_ASSIGNED_EVENT)).toHaveLength(0);
  });

  it('CANCEL WAITING: todas las consolas reciben la cola y nadie el aviso al propietario', async () => {
    const { a, b, c } = await connectConsoles();
    const id = seedWaiting();

    const cancelled = await supportRequestsService.cancelByDevice(id, deviceA);

    expect(cancelled.status).toBe(SupportRequestStatus.CANCELLED);

    await expectExactlyOne([a, b, c], id);

    for (const client of [a, b, c])
      expect(eventsOf(client, SUPPORT_REQUEST_UPDATED_EVENT)).toHaveLength(0);
  });

  it('un segundo cancel es 409 y no repite el aviso', async () => {
    const { a } = await connectConsoles();
    const id = seedWaiting();

    await supportRequestsService.cancelByDevice(id, deviceA);

    await expect(
      supportRequestsService.cancelByDevice(id, deviceA),
    ).rejects.toBeInstanceOf(ConflictException);

    await expectExactlyOne([a], id);
  });

  it('cancelar una ASSIGNED avisa solo al propietario, no a la cola', async () => {
    const tablet = await connectTablet();
    const { a, b, c } = await connectConsoles();
    const id = seedWaiting();

    await supportRequestsService.assign(id, technicianA);
    await expectExactlyOne([a, b, c], id);

    await supportRequestsService.cancelByDevice(id, deviceA);

    await waitFor(
      () => eventsOf(a, SUPPORT_REQUEST_UPDATED_EVENT).length === 1,
      `${SUPPORT_REQUEST_UPDATED_EVENT} en el propietario`,
    );
    await settle();

    // Sigue habiendo un unico aviso de cola por consola: el del assign.
    for (const client of [a, b, c]) expect(eventsOf(client)).toHaveLength(1);
    expect(eventsOf(b, SUPPORT_REQUEST_UPDATED_EVENT)).toHaveLength(0);
    expect(eventsOf(c, SUPPORT_REQUEST_UPDATED_EVENT)).toHaveLength(0);
    expect(eventsOf(tablet)).toHaveLength(0);
  });

  it('llega a cada pestana del mismo tecnico, sin deduplicar por usuario', async () => {
    const first = await connectTechnician(technicianA);
    const second = await connectTechnician(technicianA);

    await settle();

    const created = await supportRequestsService.createForDevice(deviceA);

    await expectExactlyOne([first, second], created.id);
  });

  it('llega sin remote-session:join y sin ninguna RemoteSession', async () => {
    const web = await connectTechnician(technicianB);

    const emitted: string[] = [];
    web.onAnyOutgoing((event: string) => emitted.push(event));

    await settle();

    const created = await supportRequestsService.createForDevice(deviceA);

    await expectExactlyOne([web], created.id);
    expect(emitted).not.toContain(REMOTE_SESSION_JOIN_EVENT);
  });

  it.each([
    ['user', plainUser],
    ['sales', salesUser],
  ])(
    'un usuario con rol %s no puede conectarse a /technicians',
    async (_role, user) => {
      await expect(connectTechnician(user)).rejects.toThrow('Unauthorized');
    },
  );

  it('ni un socket sin token ni la tablet reciben la cola', async () => {
    await expect(connect(TECHNICIANS_NAMESPACE, '')).rejects.toThrow(
      'Unauthorized',
    );

    const tablet = await connectTablet();
    const { a } = await connectConsoles();

    const created = await supportRequestsService.createForDevice(deviceA);

    await expectExactlyOne([a], created.id);
    expect(eventsOf(tablet)).toHaveLength(0);
  });

  describe('si el aviso a la cola falla', () => {
    let emitToAll: jest.SpyInstance;

    beforeEach(() => {
      emitToAll = jest
        .spyOn(technicianRealtimeService, 'emitToAllTechnicians')
        .mockImplementation(() => {
          throw new Error('transporte caido');
        });
    });

    afterEach(() => emitToAll.mockRestore());

    it('CREATE persiste WAITING y responde bien', async () => {
      const { a } = await connectConsoles();

      const created = await supportRequestsService.createForDevice(deviceA);

      expect(created.status).toBe(SupportRequestStatus.WAITING);
      expect(statusOf(created.id)).toBe(SupportRequestStatus.WAITING);
      expect(emitToAll).toHaveBeenCalledTimes(1);

      await settle();
      expect(eventsOf(a)).toHaveLength(0);
    });

    it('ASSIGN conserva ASSIGNED, responde bien y la tablet recibe su aviso', async () => {
      const tablet = await connectTablet();
      const id = seedWaiting();

      const assigned = await supportRequestsService.assign(id, technicianA);

      expect(assigned.status).toBe(SupportRequestStatus.ASSIGNED);
      expect(statusOf(id)).toBe(SupportRequestStatus.ASSIGNED);

      await waitFor(
        () => eventsOf(tablet, SUPPORT_ASSIGNED_EVENT).length === 1,
        `${SUPPORT_ASSIGNED_EVENT} pese al fallo de la cola`,
      );
    });

    it('CANCEL WAITING conserva CANCELLED y responde bien', async () => {
      const id = seedWaiting();

      const cancelled = await supportRequestsService.cancelByDevice(
        id,
        deviceA,
      );

      expect(cancelled.status).toBe(SupportRequestStatus.CANCELLED);
      expect(statusOf(id)).toBe(SupportRequestStatus.CANCELLED);
    });
  });
});
