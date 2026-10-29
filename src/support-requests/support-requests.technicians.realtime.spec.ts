import { ConflictException, INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
import { Device } from '../devices/entities/device.entity';
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
  SUPPORT_REQUEST_UPDATED_EVENT,
  SupportRequestsService,
} from './support-requests.service';

/**
 * Entrega real de `support-request:updated` al tecnico sobre Socket.IO.
 *
 * El gateway de `/technicians`, la autenticacion del JWT de usuario y la salida
 * de eventos son los de produccion: `SupportRequestsService` emite sin conocer
 * Socket.IO y el aviso tiene que llegar al tecnico asignado, y solo a ese,
 * aunque no exista ninguna `RemoteSession` ni se haya hecho
 * `remote-session:join`.
 *
 * Solo se sustituyen los repositorios de TypeORM por dobles en memoria: estas
 * pruebas no necesitan PostgreSQL.
 */
jest.setTimeout(20_000);

const USER_JWT_SECRET = 'user-secret-for-tests';

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';

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
const otherAdmin = buildUser('Carla Admin', [ValidRoles.admin]);

describe('support-request:updated hacia el tecnico (Socket.IO)', () => {
  let app: INestApplication;
  let techniciansUrl: string;
  let supportRequestsService: SupportRequestsService;
  let technicianRealtimeService: TechnicianRealtimeService;
  let userJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const users: Record<string, User> = {};
  let supportRequests: SupportRequest[] = [];

  const openClients: ClientSocket[] = [];

  /** Eventos `support-request:updated` recibidos por cada socket. */
  const received = new WeakMap<ClientSocket, unknown[]>();

  const userRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(users[id] ?? null),
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

  /** Lectura por id y, para el dispositivo, con la pertenencia en el WHERE. */
  const supportRequestRepository = {
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
    findOne: (
      _entity: unknown,
      { where }: { where: { id: string; deviceId?: string } },
    ) => Promise.resolve(findRow(where) ?? null),
    // Aqui no existe ninguna RemoteSession: el aviso no depende de ella.
    exists: () => Promise.resolve(false),
  };

  const dataSource = {
    manager: entityManager,
    transaction: (runInTransaction: (manager: unknown) => Promise<unknown>) =>
      runInTransaction(entityManager),
  };

  const signUserToken = (user: User): string => userJwt.sign({ id: user.id });

  const connectTechnician = (user: User): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(techniciansUrl, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token: signUserToken(user) },
      });

      openClients.push(client);
      received.set(client, []);

      client.on(SUPPORT_REQUEST_UPDATED_EVENT, (payload: unknown) =>
        received.get(client)?.push(payload),
      );

      client.once('connect', () => resolve(client));
      client.once('connect_error', (error: Error) => reject(error));
    });

  const eventsOf = (client: ClientSocket): unknown[] =>
    received.get(client) ?? [];

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

  const requestRow = (id: string): SupportRequest =>
    supportRequests.find((row) => row.id === id) as SupportRequest;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TechniciansGateway,
        TechnicianRealtimeService,
        SupportRequestsService,
        // Dependencias de signaling del gateway: no se ejercitan aqui.
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
          provide: DevicePresenceService,
          useValue: { isOnline: () => true },
        },
        {
          provide: DeviceRealtimeService,
          useValue: { emitToDevice: () => true },
        },
        {
          provide: getRepositoryToken(RemoteSession),
          useValue: { findOne: () => Promise.resolve(null) },
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

    supportRequestsService = app.get(SupportRequestsService);
    technicianRealtimeService = app.get(TechnicianRealtimeService);
    userJwt = new JwtService({
      secret: USER_JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    });

    await app.listen(0);

    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;

    techniciansUrl = `http://127.0.0.1:${port}${TECHNICIANS_NAMESPACE}`;
  });

  beforeEach(() => {
    users[technicianA.id] = technicianA;
    users[technicianB.id] = technicianB;
    users[otherAdmin.id] = otherAdmin;

    // Solicitud ya tomada por el tecnico A, sin ninguna RemoteSession.
    supportRequests = [
      {
        id: randomUUID(),
        deviceId: DEVICE_A_ID,
        status: SupportRequestStatus.ASSIGNED,
        technicianId: technicianA.id,
        assignedAt: new Date(),
        respondedAt: null,
        closedAt: null,
        createdAt: new Date(),
      } as SupportRequest,
    ];
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await settle();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['acepta', 'acceptByDevice', SupportRequestStatus.ACCEPTED],
    ['rechaza', 'rejectByDevice', SupportRequestStatus.REJECTED],
  ] as const)(
    'cuando el dispositivo %s, solo el tecnico asignado recibe el aviso',
    async (_label, method, expected) => {
      const web = await connectTechnician(technicianA);
      const otherWeb = await connectTechnician(technicianB);
      const adminWeb = await connectTechnician(otherAdmin);

      await settle();

      const supportRequestId = supportRequests[0].id;

      const response = await supportRequestsService[method](
        supportRequestId,
        deviceA,
      );

      expect(response.status).toBe(expected);

      await waitFor(
        () => eventsOf(web).length === 1,
        `${SUPPORT_REQUEST_UPDATED_EVENT} en la web del tecnico asignado`,
      );

      expect(eventsOf(web)).toEqual([{ supportRequestId }]);

      // Ni otro tecnico ni un admin que no es el asignado: la room la asigna el
      // servidor con la identidad del token y el destinatario sale de la fila.
      await settle();
      expect(eventsOf(otherWeb)).toHaveLength(0);
      expect(eventsOf(adminWeb)).toHaveLength(0);
    },
  );

  it('llega a todas las conexiones del mismo tecnico', async () => {
    const first = await connectTechnician(technicianA);
    const second = await connectTechnician(technicianA);

    await settle();

    const supportRequestId = supportRequests[0].id;

    await supportRequestsService.acceptByDevice(supportRequestId, deviceA);

    await waitFor(
      () => eventsOf(first).length === 1 && eventsOf(second).length === 1,
      `${SUPPORT_REQUEST_UPDATED_EVENT} en ambas pestanas`,
    );

    expect(eventsOf(first)).toEqual([{ supportRequestId }]);
    expect(eventsOf(second)).toEqual([{ supportRequestId }]);
  });

  it('llega sin remote-session:join y sin ninguna RemoteSession', async () => {
    const web = await connectTechnician(technicianA);

    // A proposito el socket solo se autentica: no envia
    // `remote-session:join`, y no hay sesion a la que unirse.
    const emitted: string[] = [];
    web.onAnyOutgoing((event: string) => emitted.push(event));

    await settle();

    await supportRequestsService.acceptByDevice(supportRequests[0].id, deviceA);

    await waitFor(
      () => eventsOf(web).length === 1,
      `${SUPPORT_REQUEST_UPDATED_EVENT} sin join`,
    );

    expect(emitted).not.toContain(REMOTE_SESSION_JOIN_EVENT);
  });

  it('no repite el aviso si el dispositivo acepta dos veces', async () => {
    const web = await connectTechnician(technicianA);

    await settle();

    const supportRequestId = supportRequests[0].id;

    await supportRequestsService.acceptByDevice(supportRequestId, deviceA);

    // La politica REST se conserva: repetir no es una transicion, es un 409.
    await expect(
      supportRequestsService.acceptByDevice(supportRequestId, deviceA),
    ).rejects.toBeInstanceOf(ConflictException);

    await waitFor(() => eventsOf(web).length >= 1, 'primer aviso');
    await settle();

    expect(eventsOf(web)).toHaveLength(1);
  });

  it.each([
    ['acceptByDevice', SupportRequestStatus.ACCEPTED],
    ['rejectByDevice', SupportRequestStatus.REJECTED],
  ] as const)(
    'si el aviso falla, %s conserva %s y responde bien',
    async (method, expected) => {
      const web = await connectTechnician(technicianA);

      await settle();

      const emit = jest
        .spyOn(technicianRealtimeService, 'emitToTechnician')
        .mockImplementation(() => {
          throw new Error('transporte caido');
        });

      const supportRequestId = supportRequests[0].id;

      try {
        const response = await supportRequestsService[method](
          supportRequestId,
          deviceA,
        );

        expect(response.status).toBe(expected);
      } finally {
        emit.mockRestore();
      }

      // El realtime no es la fuente de verdad y no deshace nada.
      expect(requestRow(supportRequestId).status).toBe(expected);

      await settle();
      expect(eventsOf(web)).toHaveLength(0);
    },
  );
});
