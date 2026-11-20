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
import { DataSource, FindOperator, Repository } from 'typeorm';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../auth/entities/user.entity';
import { ValidRoles } from '../../auth/interfaces/valid-roles';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import {
  REMOTE_SESSION_LIFECYCLE_CONFIG,
  RemoteSessionLifecycleConfig,
} from '../../config/remote-session-lifecycle.config';
import { DeviceAuthService } from '../../devices/auth/device-auth.service';
import { DeviceCredentialsService } from '../../devices/auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../../devices/auth/interfaces/device-jwt-payload.interface';
import { DeviceJwtStrategy } from '../../devices/auth/strategies/device-jwt.strategy';
import { DeviceCredential } from '../../devices/entities/device-credential.entity';
import { Device } from '../../devices/entities/device.entity';
import {
  DEVICES_NAMESPACE,
  DevicesGateway,
} from '../../devices/gateway/devices.gateway';
import {
  DEVICE_PRESENCE_UPDATED_EVENT,
  DevicePresenceService,
} from '../../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../../devices/realtime/device-realtime.service';
import {
  TECHNICIANS_NAMESPACE,
  TechniciansGateway,
} from '../../signaling/gateway/technicians.gateway';
import { SessionParticipationService } from '../../signaling/participation/session-participation.service';
import { SignalingRealtimeService } from '../../signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../../signaling/realtime/technician-realtime.service';
import { REMOTE_SESSION_JOIN_EVENT } from '../../signaling/signaling.events';
import { SignalingService } from '../../signaling/signaling.service';
import { SupportRequest } from '../../support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../../support-requests/enums/support-request-status.enum';
import { DeviceRemoteSessionsController } from '../device-remote-sessions.controller';
import { RemoteSession } from '../entities/remote-session.entity';
import { RemoteSessionEndedBy } from '../enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from '../enums/remote-session-status.enum';
import { RemoteSessionsController } from '../remote-sessions.controller';
import {
  REMOTE_SESSION_CLOSED_EVENT,
  RemoteSessionsService,
} from '../remote-sessions.service';
import { RemoteSessionLifecycleService } from './remote-session-lifecycle.service';

/**
 * Cierre automatico de punta a punta, sin mocks de gateways:
 *
 *   sockets reales en /devices y /technicians
 *   -> remote-session:join real (SignalingService)
 *   -> desconexion real -> SessionParticipationService
 *   -> RemoteSessionLifecycleService -> RemoteSessionsService.closeBySystem
 *   -> remote-session:closed a los dos namespaces
 *   -> REST ya devuelve la sesion CLOSED / SYSTEM
 *
 * Gateways, autenticacion de ambos tokens, `@Auth()`/`@DeviceAuth()` con sus
 * estrategias y controladores son los de produccion. Solo se sustituye
 * PostgreSQL por un almacen en memoria (sin locks: la concurrencia esta
 * probada en las pruebas unitarias y contra PostgreSQL) y se acortan los
 * tiempos para que la prueba dure milisegundos.
 */
jest.setTimeout(30_000);

const USER_JWT_SECRET = 'user-secret-for-tests';
const DEVICE_JWT_SECRET = 'device-secret-for-tests';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const CREDENTIAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const GRACE_MS = 400;
const TTL_MS = 1_000;

const LIFECYCLE: RemoteSessionLifecycleConfig = {
  disconnectGraceMs: GRACE_MS,
  connectingTtlMs: TTL_MS,
  // Sin ventana tras el arranque: el arranque se prueba con reloj falso.
  startupRecoveryMs: 0,
};

const OBSERVED_EVENTS = [
  REMOTE_SESSION_CLOSED_EVENT,
  DEVICE_PRESENCE_UPDATED_EVENT,
] as const;

type ObservedEvent = (typeof OBSERVED_EVENTS)[number];

const technician = {
  id: randomUUID(),
  email: 'ana.tecnica@acme.com',
  password: 'hash-que-nunca-debe-salir',
  fullName: 'Ana Tecnica',
  isActive: true,
  roles: [ValidRoles.tecnico],
  created_at: new Date(),
  updated_at: new Date(),
} as User;

const device: Device = {
  id: DEVICE_ID,
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

type Where = Record<string, unknown>;

const matches = (row: object, where: Where): boolean =>
  Object.entries(where).every(([key, expected]) => {
    const actual = (row as Record<string, unknown>)[key];

    if (expected instanceof FindOperator)
      return (expected.value as unknown as unknown[]).includes(actual);

    return actual === expected;
  });

describe('Cierre automatico de sesiones (Socket.IO + REST)', () => {
  let app: INestApplication;
  let server: Server;
  let baseUrl: string;
  let remoteSessionsService: RemoteSessionsService;
  let userJwt: JwtService;
  let deviceJwt: JwtService;

  let remoteSessions: RemoteSession[] = [];
  let supportRequests: SupportRequest[] = [];

  const openClients: ClientSocket[] = [];
  const received = new WeakMap<
    ClientSocket,
    Record<ObservedEvent, unknown[]>
  >();

  const hydrate = (row: RemoteSession): RemoteSession => ({
    ...row,
    device,
    technician,
  });

  const remoteSessionRepository = {
    findOne: ({ where }: { where: Where }) => {
      const row = remoteSessions.find((candidate) => matches(candidate, where));
      return Promise.resolve(row ? hydrate(row) : null);
    },
    find: ({ where }: { where: Where }) =>
      Promise.resolve(
        remoteSessions
          .filter((candidate) => matches(candidate, where))
          .map((row) => ({ ...row })),
      ),
    create: (partial: Partial<RemoteSession>) => ({ ...partial }),
  };

  const rowsOf = (entity: unknown): Array<RemoteSession | SupportRequest> =>
    entity === RemoteSession ? remoteSessions : supportRequests;

  const createUpdateBuilder = () => {
    let rows: Array<RemoteSession | SupportRequest> = [];
    let changes: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};

    const builder = {
      update: (entity: unknown) => {
        rows = rowsOf(entity);
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

  const manager = {
    findOne: (
      entity: unknown,
      { where, relations }: { where: Where; relations?: object },
    ) => {
      const row = rowsOf(entity).find((candidate) => matches(candidate, where));

      if (!row) return Promise.resolve(null);

      // Como TypeORM: las relaciones solo llegan si se piden (la relectura del
      // cierre las pide; el `SELECT ... FOR UPDATE` no puede).
      return Promise.resolve(
        relations && entity === RemoteSession
          ? hydrate(row as RemoteSession)
          : { ...row },
      );
    },
    exists: (_entity: unknown, { where }: { where: Where }) =>
      Promise.resolve(
        remoteSessions.some((candidate) => matches(candidate, where)),
      ),
    save: (_entity: unknown, entity: RemoteSession) => {
      const row = {
        ...entity,
        id: randomUUID(),
        createdAt: new Date(),
      } as RemoteSession;
      remoteSessions.push(row);
      return Promise.resolve({ ...row });
    },
    findOneByOrFail: () => Promise.resolve(device),
    createQueryBuilder: createUpdateBuilder,
  };

  const dataSource = {
    transaction: (run: (m: unknown) => Promise<unknown>) => run(manager),
  };

  const userRepository = {
    findOneBy: ({ id }: { id: string }) =>
      Promise.resolve(id === technician.id ? technician : null),
  };

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) =>
      Promise.resolve(id === DEVICE_ID ? device : null),
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      Promise.resolve(
        where.deviceId === DEVICE_ID
          ? { id: CREDENTIAL_ID, deviceId: DEVICE_ID, secretHash: 'hash' }
          : null,
      ),
    update: () => Promise.resolve({ affected: 1 }),
  };

  const userToken = (): string => userJwt.sign({ id: technician.id });

  const deviceToken = (): string =>
    deviceJwt.sign({
      sub: DEVICE_ID,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_ID,
    } as DeviceJwtPayload);

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

  const connectTechnician = () => connect(TECHNICIANS_NAMESPACE, userToken());
  const connectTablet = () => connect(DEVICES_NAMESPACE, deviceToken());

  const join = (client: ClientSocket, remoteSessionId: string) =>
    client
      .timeout(5_000)
      .emitWithAck(REMOTE_SESSION_JOIN_EVENT, { remoteSessionId }) as Promise<{
      joined: boolean;
    }>;

  const eventsOf = (client: ClientSocket, event: ObservedEvent): unknown[] =>
    received.get(client)?.[event] ?? [];

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

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const sessionRow = (id: string): RemoteSession =>
    remoteSessions.find((row) => row.id === id) as RemoteSession;

  const requestRow = (id: string): SupportRequest =>
    supportRequests.find((row) => row.id === id) as SupportRequest;

  const waitForClosed = (id: string): Promise<void> =>
    waitFor(
      () => sessionRow(id).status === RemoteSessionStatus.CLOSED,
      `sesion ${id} CLOSED`,
    );

  /** Solicitud ACCEPTED + sesion creada por el flujo real (tablet ONLINE). */
  const createSession = async (): Promise<string> => {
    const supportRequestId = randomUUID();

    supportRequests.push({
      id: supportRequestId,
      deviceId: DEVICE_ID,
      status: SupportRequestStatus.ACCEPTED,
      technicianId: technician.id,
      assignedAt: new Date(),
      respondedAt: new Date(),
      closedAt: null,
      createdAt: new Date(),
    } as SupportRequest);

    const { id } = await remoteSessionsService.create(
      { supportRequestId },
      technician,
    );

    return id;
  };

  /** Sesion ACTIVE con la tablet y una pestana del tecnico unidas. */
  const activeSession = async () => {
    const tablet = await connectTablet();
    const technicianTab = await connectTechnician();
    // Consola abierta pero SIN join: no participa, pero recibe los avisos.
    const idleConsole = await connectTechnician();

    const id = await createSession();

    await expect(join(tablet, id)).resolves.toMatchObject({ joined: true });
    await expect(join(technicianTab, id)).resolves.toMatchObject({
      joined: true,
    });

    await remoteSessionsService.activateByTechnician(id, technician);

    return { id, tablet, technicianTab, idleConsole };
  };

  const getAsTechnician = (path: string) =>
    request(server)
      .get(path)
      .set('Authorization', `Bearer ${userToken()}`)
      .expect(200);

  const getAsDevice = (path: string) =>
    request(server)
      .get(path)
      .set('Authorization', `Bearer ${deviceToken()}`)
      .expect(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
        PassportModule.register({ defaultStrategy: 'jwt' }),
      ],
      controllers: [RemoteSessionsController, DeviceRemoteSessionsController],
      providers: [
        DevicesGateway,
        TechniciansGateway,
        SignalingService,
        SessionParticipationService,
        SignalingRealtimeService,
        DevicePresenceService,
        DeviceRealtimeService,
        TechnicianRealtimeService,
        RemoteSessionsService,
        RemoteSessionLifecycleService,
        { provide: REMOTE_SESSION_LIFECYCLE_CONFIG, useValue: LIFECYCLE },
        DeviceAuthService,
        DeviceCredentialsService,
        JwtStrategy,
        DeviceJwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                JWT_SECRET_KEY: USER_JWT_SECRET,
                DEVICE_JWT_SECRET,
              })[key],
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
          useValue: remoteSessionRepository,
        },
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    // Los logs del ciclo de vida son parte del diseno, no de esta prueba.
    app.useLogger(false);

    remoteSessionsService = app.get(RemoteSessionsService);
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
    remoteSessions = [];
    supportRequests = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    // Que no quede ninguna sesion viva programada para la prueba siguiente.
    for (const row of remoteSessions)
      if (row.status !== RemoteSessionStatus.CLOSED)
        row.status = RemoteSessionStatus.CLOSED;

    await sleep(GRACE_MS + 100);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('tecnico desaparece -> vence la gracia -> CLOSED/SYSTEM, solicitud COMPLETED, aviso a los dos extremos', async () => {
    const { id, tablet, technicianTab, idleConsole } = await activeSession();
    const { supportRequestId } = sessionRow(id);

    technicianTab.close();

    // Dentro de la gracia sigue viva.
    await sleep(GRACE_MS / 2);
    expect(sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);

    await waitForClosed(id);

    expect(sessionRow(id)).toMatchObject({
      status: RemoteSessionStatus.CLOSED,
      endedBy: RemoteSessionEndedBy.SYSTEM,
    });
    expect(requestRow(supportRequestId)).toMatchObject({
      status: SupportRequestStatus.COMPLETED,
      closedAt: sessionRow(id).endedAt,
    });

    const payload = {
      remoteSessionId: id,
      endedBy: RemoteSessionEndedBy.SYSTEM,
    };

    await waitFor(
      () =>
        eventsOf(tablet, REMOTE_SESSION_CLOSED_EVENT).length === 1 &&
        eventsOf(idleConsole, REMOTE_SESSION_CLOSED_EVENT).length === 1,
      'remote-session:closed en los dos extremos',
    );
    expect(eventsOf(tablet, REMOTE_SESSION_CLOSED_EVENT)).toEqual([payload]);
    // La consola abierta no evito el cierre, pero recibe el aviso.
    expect(eventsOf(idleConsole, REMOTE_SESSION_CLOSED_EVENT)).toEqual([
      payload,
    ]);

    // REST: el tecnico ya no tiene sesion viva y la ve cerrada por id.
    const current = await getAsTechnician('/remote-sessions/current');
    expect(current.body).toEqual({ remoteSession: null });

    const byId = await getAsTechnician(`/remote-sessions/${id}`);
    expect(byId.body).toMatchObject({
      status: RemoteSessionStatus.CLOSED,
      endedBy: RemoteSessionEndedBy.SYSTEM,
    });
  });

  it('tablet desaparece -> device:presence-updated -> vence la gracia -> CLOSED/SYSTEM; al volver la tablet lo lee por REST', async () => {
    const { id, tablet, technicianTab } = await activeSession();

    tablet.close();

    // Coexistencia con la presencia: el aviso de OFFLINE sale como siempre.
    await waitFor(
      () => eventsOf(technicianTab, DEVICE_PRESENCE_UPDATED_EVENT).length > 0,
      'device:presence-updated',
    );
    expect(sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);

    await waitForClosed(id);

    expect(sessionRow(id).endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    await waitFor(
      () => eventsOf(technicianTab, REMOTE_SESSION_CLOSED_EVENT).length === 1,
      'remote-session:closed en el tecnico',
    );
    expect(eventsOf(technicianTab, REMOTE_SESSION_CLOSED_EVENT)).toEqual([
      { remoteSessionId: id, endedBy: RemoteSessionEndedBy.SYSTEM },
    ]);

    // La tablet estuvo desconectada y se perdio el evento: reconcilia por REST.
    const reconnected = await connectTablet();

    expect(eventsOf(reconnected, REMOTE_SESSION_CLOSED_EVENT)).toEqual([]);

    const current = await getAsDevice('/device/remote-sessions/current');
    expect(current.body).toEqual({ remoteSession: null });

    // Y su join a la sesion cerrada se rechaza.
    await expect(join(reconnected, id)).resolves.toMatchObject({
      joined: false,
    });
  });

  it('el tecnico reconecta y vuelve a unirse dentro de la gracia: la sesion sigue ACTIVE', async () => {
    const { id, tablet, technicianTab } = await activeSession();

    technicianTab.close();
    await sleep(GRACE_MS / 4);

    const reconnected = await connectTechnician();
    await expect(join(reconnected, id)).resolves.toMatchObject({
      joined: true,
    });

    await sleep(GRACE_MS * 2);

    expect(sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);
    expect(eventsOf(tablet, REMOTE_SESSION_CLOSED_EVENT)).toEqual([]);
  });

  it('reconectar SIN volver a unirse no recupera la sesion', async () => {
    const { id, technicianTab } = await activeSession();

    technicianTab.close();
    await sleep(GRACE_MS / 4);

    // Socket autenticado, pero sin remote-session:join.
    await connectTechnician();

    await waitForClosed(id);

    expect(sessionRow(id).endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
  });

  it('cerrar una de dos pestanas unidas no abre la gracia', async () => {
    const { id, technicianTab } = await activeSession();
    const secondTab = await connectTechnician();
    await join(secondTab, id);

    technicianTab.close();
    await sleep(GRACE_MS * 2);

    expect(sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);
  });

  it('CONNECTING que nunca llega a ACTIVE se cierra al vencer el TTL, con aviso a ambos', async () => {
    const tablet = await connectTablet();
    const technicianTab = await connectTechnician();

    const id = await createSession();
    await join(tablet, id);
    await join(technicianTab, id);

    await sleep(TTL_MS / 2);
    expect(sessionRow(id).status).toBe(RemoteSessionStatus.CONNECTING);

    await waitForClosed(id);

    expect(sessionRow(id).endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    await waitFor(
      () =>
        eventsOf(tablet, REMOTE_SESSION_CLOSED_EVENT).length === 1 &&
        eventsOf(technicianTab, REMOTE_SESSION_CLOSED_EVENT).length === 1,
      'remote-session:closed en los dos extremos',
    );
  });

  it('un cierre normal del tecnico conserva su contrato y no deja un SYSTEM pendiente', async () => {
    const { id, tablet, technicianTab, idleConsole } = await activeSession();

    technicianTab.close();
    await remoteSessionsService.closeByTechnician(id, technician);

    await sleep(GRACE_MS * 2);

    expect(sessionRow(id).endedBy).toBe(RemoteSessionEndedBy.TECHNICIAN);
    expect(eventsOf(tablet, REMOTE_SESSION_CLOSED_EVENT)).toEqual([
      { remoteSessionId: id, endedBy: RemoteSessionEndedBy.TECHNICIAN },
    ]);
    // Sin eco al tecnico que cerro, como hasta ahora.
    expect(eventsOf(idleConsole, REMOTE_SESSION_CLOSED_EVENT)).toEqual([]);
  });
});
