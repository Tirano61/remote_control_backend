import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import {
  DataSource,
  FindOperator,
  FindOptionsWhere,
  Repository,
} from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import {
  TECHNICIANS_NAMESPACE,
  TechniciansGateway,
} from '../signaling/gateway/technicians.gateway';
import { SignalingRealtimeService } from '../signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../signaling/realtime/technician-realtime.service';
import { SignalingService } from '../signaling/signaling.service';
import { SupportRequest } from '../support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../support-requests/enums/support-request-status.enum';
import { RemoteSession } from './entities/remote-session.entity';
import { RemoteSessionEndedBy } from './enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from './enums/remote-session-status.enum';
import {
  REMOTE_SESSION_CLOSED_EVENT,
  RemoteSessionsService,
} from './remote-sessions.service';

/**
 * Entrega real de `remote-session:closed` al tecnico sobre Socket.IO.
 *
 * El gateway de `/technicians`, la autenticacion del JWT de usuario y la salida
 * de eventos son los de produccion: `RemoteSessionsService` emite sin conocer
 * Socket.IO y el aviso tiene que llegar al tecnico dueno de la sesion, y solo a
 * ese, aunque nunca haya ejecutado `remote-session:join`.
 *
 * Solo se sustituyen los repositorios de TypeORM por dobles en memoria: estas
 * pruebas no necesitan PostgreSQL. El signaling no se toca: por aqui no viaja
 * ninguna SDP ni ningun candidato ICE.
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

describe('remote-session:closed hacia el tecnico (Socket.IO)', () => {
  let app: INestApplication;
  let techniciansUrl: string;
  let remoteSessionsService: RemoteSessionsService;
  let technicianRealtimeService: TechnicianRealtimeService;
  let userJwt: JwtService;
  let emitToDevice: jest.Mock;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const users: Record<string, User> = {};
  let remoteSessions: RemoteSession[] = [];
  let supportRequests: SupportRequest[] = [];

  const openClients: ClientSocket[] = [];

  /** Eventos `remote-session:closed` recibidos por cada socket. */
  const received = new WeakMap<ClientSocket, unknown[]>();

  const userRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(users[id] ?? null),
  };

  const matchesStatus = (
    session: RemoteSession,
    condition: FindOptionsWhere<RemoteSession>['status'],
  ): boolean => {
    if (!(condition instanceof FindOperator)) return true;

    return (condition.value as unknown as RemoteSessionStatus[]).includes(
      session.status,
    );
  };

  /** Solo lectura: la pertenencia y el estado viajan en el WHERE. */
  const remoteSessionRepository = {
    findOne: ({ where }: { where: FindOptionsWhere<RemoteSession> }) => {
      const found = remoteSessions.find(
        (session) =>
          (where.id === undefined || where.id === session.id) &&
          (where.deviceId === undefined ||
            where.deviceId === session.deviceId) &&
          (where.technicianId === undefined ||
            where.technicianId === session.technicianId) &&
          matchesStatus(session, where.status),
      );

      if (!found) return Promise.resolve(null);

      return Promise.resolve({
        ...found,
        device: deviceA,
        technician: users[found.technicianId],
      });
    },
  };

  /**
   * `update / set / where / andWhere / execute`: la unica cadena que usan las
   * transiciones de cierre. La condicion se evalua al ejecutar.
   */
  const createUpdateBuilder = () => {
    let rows: Array<RemoteSession | SupportRequest> = [];
    let changes: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};

    const builder = {
      update: (entity: unknown) => {
        rows = entity === RemoteSession ? remoteSessions : supportRequests;
        return builder;
      },
      set: (values: Record<string, unknown>) => {
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
        const from = params.from as string[];
        const row = rows.find(
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

  /** Sin locks ni rollback: el cierre no los necesita para estas pruebas. */
  const dataSource = {
    transaction: (runInTransaction: (manager: unknown) => Promise<unknown>) =>
      runInTransaction({ createQueryBuilder: createUpdateBuilder }),
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

      client.on(REMOTE_SESSION_CLOSED_EVENT, (payload: unknown) =>
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

  const sessionRow = (id: string): RemoteSession =>
    remoteSessions.find((row) => row.id === id) as RemoteSession;

  const requestRow = (id: string): SupportRequest =>
    supportRequests.find((row) => row.id === id) as SupportRequest;

  beforeAll(async () => {
    emitToDevice = jest.fn().mockReturnValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        TechniciansGateway,
        TechnicianRealtimeService,
        RemoteSessionsService,
        DevicePresenceService,
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
        { provide: DeviceRealtimeService, useValue: { emitToDevice } },
        {
          provide: getRepositoryToken(RemoteSession),
          useValue:
            remoteSessionRepository as unknown as Repository<RemoteSession>,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    remoteSessionsService = app.get(RemoteSessionsService);
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

    const supportRequestId = randomUUID();

    supportRequests = [
      {
        id: supportRequestId,
        deviceId: DEVICE_A_ID,
        status: SupportRequestStatus.ACCEPTED,
        technicianId: technicianA.id,
        assignedAt: new Date(),
        respondedAt: new Date(),
        closedAt: null,
        createdAt: new Date(),
      } as SupportRequest,
    ];

    remoteSessions = [
      {
        id: randomUUID(),
        supportRequestId,
        deviceId: DEVICE_A_ID,
        technicianId: technicianA.id,
        status: RemoteSessionStatus.CONNECTING,
        createdAt: new Date(),
        connectedAt: null,
        endedAt: null,
        endedBy: null,
      } as RemoteSession,
    ];

    emitToDevice.mockClear();
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await settle();
  });

  afterAll(async () => {
    await app.close();
  });

  it('avisa al tecnico dueno cuando el dispositivo cierra la sesion', async () => {
    const web = await connectTechnician(technicianA);

    // A proposito NO se ejecuta `remote-session:join`: el cierre es un evento
    // de dominio y no puede depender del signaling.
    await settle();

    const remoteSessionId = remoteSessions[0].id;

    await remoteSessionsService.closeByDevice(remoteSessionId, deviceA);

    await waitFor(
      () => eventsOf(web).length === 1,
      `${REMOTE_SESSION_CLOSED_EVENT} en la web del tecnico`,
    );

    expect(eventsOf(web)[0]).toEqual({
      remoteSessionId,
      endedBy: RemoteSessionEndedBy.DEVICE,
    });
  });

  it('no se lo entrega a otro tecnico conectado', async () => {
    const web = await connectTechnician(technicianA);
    const otherWeb = await connectTechnician(technicianB);

    await settle();

    await remoteSessionsService.closeByDevice(remoteSessions[0].id, deviceA);

    await waitFor(
      () => eventsOf(web).length === 1,
      `${REMOTE_SESSION_CLOSED_EVENT} en la web del tecnico dueno`,
    );

    // La room la asigna el servidor con la identidad del token: nadie mas
    // puede pedirla.
    await settle();
    expect(eventsOf(otherWeb)).toHaveLength(0);
  });

  it('llega a todas las conexiones del mismo tecnico', async () => {
    const first = await connectTechnician(technicianA);
    const second = await connectTechnician(technicianA);

    await settle();

    await remoteSessionsService.closeByDevice(remoteSessions[0].id, deviceA);

    await waitFor(
      () => eventsOf(first).length === 1 && eventsOf(second).length === 1,
      `${REMOTE_SESSION_CLOSED_EVENT} en ambas pestanas`,
    );
  });

  it('no le devuelve el eco al tecnico que cierra', async () => {
    const web = await connectTechnician(technicianA);

    await settle();

    await remoteSessionsService.closeByTechnician(
      remoteSessions[0].id,
      technicianA,
    );

    // La tablet si recibe el aviso; la web ya tiene la respuesta HTTP.
    expect(emitToDevice).toHaveBeenCalledTimes(1);

    await settle();
    expect(eventsOf(web)).toHaveLength(0);
  });

  it('mantiene la persistencia si el aviso falla', async () => {
    const web = await connectTechnician(technicianA);

    await settle();

    const emit = jest
      .spyOn(technicianRealtimeService, 'emitToTechnician')
      .mockImplementation(() => {
        throw new Error('transporte caido');
      });

    const remoteSessionId = remoteSessions[0].id;
    const supportRequestId = remoteSessions[0].supportRequestId;

    try {
      const closed = await remoteSessionsService.closeByDevice(
        remoteSessionId,
        deviceA,
      );

      expect(closed.status).toBe(RemoteSessionStatus.CLOSED);
    } finally {
      emit.mockRestore();
    }

    // El realtime no es la fuente de verdad y no deshace nada.
    expect(sessionRow(remoteSessionId).status).toBe(RemoteSessionStatus.CLOSED);
    expect(sessionRow(remoteSessionId).endedBy).toBe(
      RemoteSessionEndedBy.DEVICE,
    );
    expect(requestRow(supportRequestId).status).toBe(
      SupportRequestStatus.COMPLETED,
    );

    await settle();
    expect(eventsOf(web)).toHaveLength(0);
  });
});
