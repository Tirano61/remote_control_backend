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
import {
  TECHNICIANS_NAMESPACE,
  TechniciansGateway,
} from '../signaling/gateway/technicians.gateway';
import { SignalingRealtimeService } from '../signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../signaling/realtime/technician-realtime.service';
import { SignalingService } from '../signaling/signaling.service';
import { RemoteSession } from './entities/remote-session.entity';
import { RemoteSessionStatus } from './enums/remote-session-status.enum';
import {
  REMOTE_SESSION_ACTIVE_EVENT,
  RemoteSessionsService,
} from './remote-sessions.service';

/**
 * Entrega real de `remote-session:active` sobre Socket.IO, en los DOS
 * namespaces a la vez.
 *
 * Los dos gateways, la autenticacion del Device JWT, la del JWT de usuario y la
 * salida de eventos son los de produccion: `RemoteSessionsService` activa la
 * sesion sin conocer Socket.IO y el aviso tiene que llegar a la tablet y a la
 * web de la sesion, y solo a esas.
 *
 * Es lo que distingue este fichero de `remote-sessions.realtime.spec.ts`, que
 * cubre `remote-session:closed` con la salida hacia el dispositivo simulada:
 * aqui hacen falta las dos puntas reales porque el evento va a las dos.
 *
 * Solo se sustituyen los repositorios de TypeORM por dobles en memoria: estas
 * pruebas no necesitan PostgreSQL. El signaling no se toca: por aqui no viaja
 * ninguna SDP ni ningun candidato ICE, y ningun cliente hace
 * `remote-session:join`.
 */
jest.setTimeout(20_000);

const DEVICE_JWT_SECRET = 'device-secret-for-tests';
const USER_JWT_SECRET = 'user-secret-for-tests';

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const CREDENTIAL_OF: Record<string, string> = {
  [DEVICE_A_ID]: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  [DEVICE_B_ID]: 'b1f6d2f4-1f4a-4a2e-9d6e-2a0f7a5c9d31',
};

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

const technicianA = buildUser('Ana Tecnica', [ValidRoles.tecnico]);
const technicianB = buildUser('Beto Tecnico', [ValidRoles.tecnico]);

describe('remote-session:active (Socket.IO)', () => {
  let app: INestApplication;
  let devicesUrl: string;
  let techniciansUrl: string;
  let remoteSessionsService: RemoteSessionsService;
  let technicianRealtimeService: TechnicianRealtimeService;
  let presence: DevicePresenceService;
  let deviceJwt: JwtService;
  let userJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const devices: Record<string, Device> = {};
  const users: Record<string, User> = {};
  let remoteSessions: RemoteSession[] = [];

  const openClients: ClientSocket[] = [];

  /** Eventos `remote-session:active` recibidos por cada socket. */
  const received = new WeakMap<ClientSocket, unknown[]>();

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(devices[id] ?? null),
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      Promise.resolve({
        id: CREDENTIAL_OF[where.deviceId],
        deviceId: where.deviceId,
        secretHash: 'hash',
      }),
    update: () => Promise.resolve({ affected: 1 }),
  };

  const userRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(users[id] ?? null),
  };

  /** Solo lectura: la pertenencia viaja en el WHERE. */
  const remoteSessionRepository = {
    findOne: ({ where }: { where: { id?: string; technicianId?: string } }) => {
      const found = remoteSessions.find(
        (session) =>
          (where.id === undefined || where.id === session.id) &&
          (where.technicianId === undefined ||
            where.technicianId === session.technicianId),
      );

      return Promise.resolve(found ? { ...found } : null);
    },
  };

  /**
   * `update / set / where / andWhere / execute`: la unica cadena que usa la
   * activacion. La condicion se evalua al ejecutar.
   */
  const createUpdateBuilder = () => {
    let changes: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};

    const builder = {
      update: () => builder,
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
        const row = remoteSessions.find(
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

  /**
   * `EntityManager` con lo justo que usa la activacion: la lectura bloqueante,
   * el UPDATE condicional y el dispositivo de la respuesta.
   */
  const entityManager = {
    findOne: (
      _entity: unknown,
      options: { where: { id?: string; technicianId?: string } },
    ) => remoteSessionRepository.findOne(options),
    findOneByOrFail: (_entity: unknown, where: { id: string }) =>
      Promise.resolve(devices[where.id]),
    createQueryBuilder: createUpdateBuilder,
  };

  /** Sin locks reales: el aislamiento se prueba contra PostgreSQL aparte. */
  const dataSource = {
    transaction: (runInTransaction: (manager: unknown) => Promise<unknown>) =>
      runInTransaction(entityManager),
  };

  const signDeviceToken = (deviceId: string): string =>
    deviceJwt.sign({
      sub: deviceId,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_OF[deviceId],
    } as DeviceJwtPayload);

  const signUserToken = (user: User): string => userJwt.sign({ id: user.id });

  const connect = (
    url: string,
    auth: Record<string, unknown>,
  ): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth,
      });

      openClients.push(client);
      received.set(client, []);

      client.on(REMOTE_SESSION_ACTIVE_EVENT, (payload: unknown) =>
        received.get(client)?.push(payload),
      );

      client.once('connect', () => resolve(client));
      client.once('connect_error', (error: Error) => reject(error));
    });

  const connectDevice = (deviceId: string): Promise<ClientSocket> =>
    connect(devicesUrl, { token: signDeviceToken(deviceId) });

  const connectTechnician = (user: User): Promise<ClientSocket> =>
    connect(techniciansUrl, { token: signUserToken(user) });

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // El JwtService del modulo es el de los dispositivos. El de usuarios va
        // aparte, dentro de AuthService: son dos secretos distintos.
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      providers: [
        DevicesGateway,
        TechniciansGateway,
        RemoteSessionsService,
        DevicePresenceService,
        DeviceRealtimeService,
        TechnicianRealtimeService,
        DeviceAuthService,
        DeviceCredentialsService,
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
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
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
    presence = app.get(DevicePresenceService);
    deviceJwt = app.get(JwtService);
    userJwt = new JwtService({
      secret: USER_JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    });

    await app.listen(0);

    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;

    devicesUrl = `http://127.0.0.1:${port}${DEVICES_NAMESPACE}`;
    techniciansUrl = `http://127.0.0.1:${port}${TECHNICIANS_NAMESPACE}`;
  });

  beforeEach(() => {
    devices[DEVICE_A_ID] = buildDevice(DEVICE_A_ID, '384-729-142');
    devices[DEVICE_B_ID] = buildDevice(DEVICE_B_ID, '111-222-333');

    users[technicianA.id] = technicianA;
    users[technicianB.id] = technicianB;

    remoteSessions = [
      {
        id: randomUUID(),
        supportRequestId: randomUUID(),
        deviceId: DEVICE_A_ID,
        technicianId: technicianA.id,
        status: RemoteSessionStatus.CONNECTING,
        createdAt: new Date(),
        connectedAt: null,
        endedAt: null,
        endedBy: null,
      } as RemoteSession,
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

  it('avisa a la tablet y al tecnico de la sesion', async () => {
    const tablet = await connectDevice(DEVICE_A_ID);
    const web = await connectTechnician(technicianA);

    // A proposito NO se ejecuta `remote-session:join`: la activacion es un
    // evento de dominio y no puede depender del signaling.
    await waitFor(() => presence.isOnline(DEVICE_A_ID), 'tablet ONLINE');

    const remoteSessionId = remoteSessions[0].id;

    await remoteSessionsService.activateByTechnician(
      remoteSessionId,
      technicianA,
    );

    await waitFor(
      () => eventsOf(tablet).length === 1 && eventsOf(web).length === 1,
      `${REMOTE_SESSION_ACTIVE_EVENT} en los dos extremos`,
    );

    // Mismo nombre y mismo payload en los dos namespaces.
    expect(eventsOf(tablet)[0]).toEqual({ remoteSessionId });
    expect(eventsOf(web)[0]).toEqual({ remoteSessionId });
  });

  it('no se lo entrega a otro dispositivo ni a otro tecnico', async () => {
    const tablet = await connectDevice(DEVICE_A_ID);
    const otherTablet = await connectDevice(DEVICE_B_ID);
    const web = await connectTechnician(technicianA);
    const otherWeb = await connectTechnician(technicianB);

    await waitFor(
      () => presence.isOnline(DEVICE_A_ID) && presence.isOnline(DEVICE_B_ID),
      'ambas tablets ONLINE',
    );

    await remoteSessionsService.activateByTechnician(
      remoteSessions[0].id,
      technicianA,
    );

    await waitFor(
      () => eventsOf(tablet).length === 1 && eventsOf(web).length === 1,
      `${REMOTE_SESSION_ACTIVE_EVENT} en los extremos de la sesion`,
    );

    // Las rooms las asigna el servidor con la identidad del token: nadie mas
    // puede pedirlas.
    await settle();
    expect(eventsOf(otherTablet)).toHaveLength(0);
    expect(eventsOf(otherWeb)).toHaveLength(0);
  });

  it('llega a todas las conexiones del mismo extremo', async () => {
    const firstTablet = await connectDevice(DEVICE_A_ID);
    const secondTablet = await connectDevice(DEVICE_A_ID);
    const firstTab = await connectTechnician(technicianA);
    const secondTab = await connectTechnician(technicianA);

    await waitFor(
      () => presence.connectionCount(DEVICE_A_ID) === 2,
      'dos sockets del dispositivo',
    );

    await remoteSessionsService.activateByTechnician(
      remoteSessions[0].id,
      technicianA,
    );

    await waitFor(
      () =>
        eventsOf(firstTablet).length === 1 &&
        eventsOf(secondTablet).length === 1 &&
        eventsOf(firstTab).length === 1 &&
        eventsOf(secondTab).length === 1,
      `${REMOTE_SESSION_ACTIVE_EVENT} en las cuatro conexiones`,
    );
  });

  it('no repite el aviso cuando la sesion ya estaba ACTIVE', async () => {
    const tablet = await connectDevice(DEVICE_A_ID);
    const web = await connectTechnician(technicianA);

    await waitFor(() => presence.isOnline(DEVICE_A_ID), 'tablet ONLINE');

    const remoteSessionId = remoteSessions[0].id;

    await remoteSessionsService.activateByTechnician(
      remoteSessionId,
      technicianA,
    );

    await waitFor(
      () => eventsOf(tablet).length === 1 && eventsOf(web).length === 1,
      `${REMOTE_SESSION_ACTIVE_EVENT} en los dos extremos`,
    );

    // Reintento: la respuesta del primero se perdio por red.
    const retried = await remoteSessionsService.activateByTechnician(
      remoteSessionId,
      technicianA,
    );

    expect(retried.status).toBe(RemoteSessionStatus.ACTIVE);

    // Solo la transicion real avisa.
    await settle();
    expect(eventsOf(tablet)).toHaveLength(1);
    expect(eventsOf(web)).toHaveLength(1);
  });

  it('no avisa a nadie cuando la sesion esta CLOSED', async () => {
    const tablet = await connectDevice(DEVICE_A_ID);
    const web = await connectTechnician(technicianA);

    await waitFor(() => presence.isOnline(DEVICE_A_ID), 'tablet ONLINE');

    const remoteSessionId = remoteSessions[0].id;

    remoteSessions[0].status = RemoteSessionStatus.CLOSED;

    await expect(
      remoteSessionsService.activateByTechnician(remoteSessionId, technicianA),
    ).rejects.toBeInstanceOf(ConflictException);

    await settle();
    expect(eventsOf(tablet)).toHaveLength(0);
    expect(eventsOf(web)).toHaveLength(0);
    expect(sessionRow(remoteSessionId).status).toBe(RemoteSessionStatus.CLOSED);
  });

  it('mantiene la persistencia si el aviso falla', async () => {
    const tablet = await connectDevice(DEVICE_A_ID);
    const web = await connectTechnician(technicianA);

    await waitFor(() => presence.isOnline(DEVICE_A_ID), 'tablet ONLINE');

    const emit = jest
      .spyOn(technicianRealtimeService, 'emitToTechnician')
      .mockImplementation(() => {
        throw new Error('transporte caido');
      });

    const remoteSessionId = remoteSessions[0].id;

    try {
      const activated = await remoteSessionsService.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(activated.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(activated.connectedAt).toBeInstanceOf(Date);
    } finally {
      emit.mockRestore();
    }

    // El realtime no es la fuente de verdad y no deshace nada.
    expect(sessionRow(remoteSessionId).status).toBe(RemoteSessionStatus.ACTIVE);
    expect(sessionRow(remoteSessionId).connectedAt).toBeInstanceOf(Date);

    // Y el extremo que si funciona recibe su aviso igualmente. La web recupera
    // el estado con GET /remote-sessions/current.
    await waitFor(
      () => eventsOf(tablet).length === 1,
      `${REMOTE_SESSION_ACTIVE_EVENT} en la tablet`,
    );
    expect(eventsOf(web)).toHaveLength(0);
  });
});
