import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import type { Server as IoServer, ServerOptions } from 'socket.io';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { AuthService } from '../../src/auth/auth.service';
import { User } from '../../src/auth/entities/user.entity';
import { ValidRoles } from '../../src/auth/interfaces/valid-roles';
import { JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import {
  REMOTE_SESSION_LIFECYCLE_CONFIG,
  RemoteSessionLifecycleConfig,
} from '../../src/config/remote-session-lifecycle.config';
import { SocketIoHeartbeatConfig } from '../../src/config/socket-io-heartbeat.config';
import { SocketIoAdapter } from '../../src/config/socket-io.adapter';
import { DeviceAuthService } from '../../src/devices/auth/device-auth.service';
import { DeviceCredentialsService } from '../../src/devices/auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../../src/devices/auth/interfaces/device-jwt-payload.interface';
import { DeviceJwtStrategy } from '../../src/devices/auth/strategies/device-jwt.strategy';
import { DeviceCredential } from '../../src/devices/entities/device-credential.entity';
import { Device } from '../../src/devices/entities/device.entity';
import { DevicesGateway } from '../../src/devices/gateway/devices.gateway';
import { DevicePresenceService } from '../../src/devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../../src/devices/realtime/device-realtime.service';
import { DeviceRemoteSessionsController } from '../../src/remote-sessions/device-remote-sessions.controller';
import { RemoteSession } from '../../src/remote-sessions/entities/remote-session.entity';
import { RemoteSessionLifecycleService } from '../../src/remote-sessions/lifecycle/remote-session-lifecycle.service';
import { RemoteSessionsController } from '../../src/remote-sessions/remote-sessions.controller';
import { RemoteSessionsService } from '../../src/remote-sessions/remote-sessions.service';
import { TechniciansGateway } from '../../src/signaling/gateway/technicians.gateway';
import { SessionParticipationService } from '../../src/signaling/participation/session-participation.service';
import { SignalingRealtimeService } from '../../src/signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../../src/signaling/realtime/technician-realtime.service';
import { SignalingService } from '../../src/signaling/signaling.service';
import { SupportRequest } from '../../src/support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../../src/support-requests/enums/support-request-status.enum';

/**
 * Aplicacion Nest de pruebas para el heartbeat de Socket.IO.
 *
 * Gateways (`/devices` y `/technicians`), autenticacion de los dos tipos de
 * token, presencia, signaling, participacion, ciclo de vida de sesiones y
 * controladores REST son los de produccion, y el servidor Socket.IO lo crea el
 * `SocketIoAdapter` real con el heartbeat y el CORS que se le pasen, igual que
 * `main.ts`. Solo PostgreSQL se sustituye por un almacen en memoria (la
 * persistencia real se prueba en `npm run test:db`).
 *
 * El adaptador se extiende unicamente para OBSERVAR los servidores que crea:
 * asi las pruebas pueden comprobar que hay uno solo para los dos namespaces y
 * escuchar el motivo de cada desconexion en el lado del servidor.
 */
export const HARNESS_USER_JWT_SECRET = 'user-secret-for-heartbeat-tests';
export const HARNESS_DEVICE_JWT_SECRET = 'device-secret-for-heartbeat-tests';

export const HARNESS_DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
export const HARNESS_PUBLIC_ID = '384-729-142';
const CREDENTIAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

export interface HarnessOptions {
  heartbeat: SocketIoHeartbeatConfig;
  lifecycle: RemoteSessionLifecycleConfig;
  corsOrigins?: string[];
}

/** `SocketIoAdapter` de produccion, que ademas recuerda lo que creo. */
class ObservedSocketIoAdapter extends SocketIoAdapter {
  readonly created: Array<{ options?: ServerOptions; server: IoServer }> = [];

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as IoServer;
    this.created.push({ options, server });
    return server;
  }
}

type Where = Record<string, unknown>;

const matches = (row: object, where: Where): boolean =>
  Object.entries(where).every(([key, expected]) => {
    const actual = (row as Record<string, unknown>)[key];

    if (expected instanceof FindOperator)
      return (expected.value as unknown as unknown[]).includes(actual);

    return actual === expected;
  });

export interface RealtimeHeartbeatHarness {
  app: INestApplication;
  baseUrl: string;
  port: number;
  adapter: ObservedSocketIoAdapter;
  technician: User;
  device: Device;
  remoteSessions: RemoteSession[];
  supportRequests: SupportRequest[];
  remoteSessionsService: RemoteSessionsService;
  presence: DevicePresenceService;
  userToken(): string;
  deviceToken(): string;
  /** Solicitud ACCEPTED + sesion CONNECTING creada por el flujo real. */
  createSession(): Promise<string>;
  sessionRow(id: string): RemoteSession;
  requestRow(id: string): SupportRequest;
  reset(): void;
  close(): Promise<void>;
}

export const startRealtimeHeartbeatHarness = async (
  options: HarnessOptions,
): Promise<RealtimeHeartbeatHarness> => {
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
    id: HARNESS_DEVICE_ID,
    publicId: HARNESS_PUBLIC_ID,
    name: 'Tablet Tolva 01',
    manufacturer: 'Samsung',
    model: 'SM-X210',
    androidVersion: '14',
    appVersion: '1.0.0',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const remoteSessions: RemoteSession[] = [];
  const supportRequests: SupportRequest[] = [];

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
      Promise.resolve(id === HARNESS_DEVICE_ID ? device : null),
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      Promise.resolve(
        where.deviceId === HARNESS_DEVICE_ID
          ? {
              id: CREDENTIAL_ID,
              deviceId: HARNESS_DEVICE_ID,
              secretHash: 'hash',
            }
          : null,
      ),
    update: () => Promise.resolve({ affected: 1 }),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      JwtModule.register({
        secret: HARNESS_DEVICE_JWT_SECRET,
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
      { provide: REMOTE_SESSION_LIFECYCLE_CONFIG, useValue: options.lifecycle },
      DeviceAuthService,
      DeviceCredentialsService,
      JwtStrategy,
      DeviceJwtStrategy,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) =>
            ({
              JWT_SECRET_KEY: HARNESS_USER_JWT_SECRET,
              DEVICE_JWT_SECRET: HARNESS_DEVICE_JWT_SECRET,
            })[key],
        },
      },
      {
        provide: AuthService,
        useFactory: () =>
          new AuthService(
            userRepository as unknown as Repository<User>,
            new JwtService({
              secret: HARNESS_USER_JWT_SECRET,
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

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.useLogger(false);

  // Igual que `main.ts`: el adaptador recibe los origenes y el heartbeat.
  const adapter = new ObservedSocketIoAdapter(
    app,
    options.corsOrigins ?? ['http://localhost:5173'],
    options.heartbeat,
  );
  app.useWebSocketAdapter(adapter);

  const remoteSessionsService = app.get(RemoteSessionsService);
  const presence = app.get(DevicePresenceService);
  const deviceJwt = app.get(JwtService);
  const userJwt = new JwtService({
    secret: HARNESS_USER_JWT_SECRET,
    signOptions: { expiresIn: '1h' },
  });

  await app.listen(0, '127.0.0.1');

  const httpServer = app.getHttpServer() as HttpServer;
  const { port } = httpServer.address() as AddressInfo;

  const sessionRow = (id: string): RemoteSession =>
    remoteSessions.find((row) => row.id === id) as RemoteSession;

  return {
    app,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    adapter,
    technician,
    device,
    remoteSessions,
    supportRequests,
    remoteSessionsService,
    presence,
    userToken: () => userJwt.sign({ id: technician.id }),
    deviceToken: () =>
      deviceJwt.sign({
        sub: HARNESS_DEVICE_ID,
        tokenType: DEVICE_TOKEN_TYPE,
        credentialId: CREDENTIAL_ID,
      } as DeviceJwtPayload),
    createSession: async () => {
      const supportRequestId = randomUUID();

      supportRequests.push({
        id: supportRequestId,
        deviceId: HARNESS_DEVICE_ID,
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
    },
    sessionRow,
    requestRow: (id: string) =>
      supportRequests.find((row) => row.id === id) as SupportRequest,
    reset: () => {
      remoteSessions.length = 0;
      supportRequests.length = 0;
    },
    close: () => app.close(),
  };
};
