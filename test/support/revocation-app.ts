import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomInt, randomUUID } from 'crypto';
import { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import type { Server as IoServer, ServerOptions } from 'socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module';
import { User } from '../../src/auth/entities/user.entity';
import { ValidRoles } from '../../src/auth/interfaces/valid-roles';
import { resolveDatabaseSsl } from '../../src/config/database.config';
import { DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG } from '../../src/config/socket-io-heartbeat.config';
import { SocketIoAdapter } from '../../src/config/socket-io.adapter';
import { DeviceCredentialsService } from '../../src/devices/auth/device-credentials.service';
import { DevicesModule } from '../../src/devices/devices.module';
import { Device } from '../../src/devices/entities/device.entity';
import { RemoteSession } from '../../src/remote-sessions/entities/remote-session.entity';
import { RemoteSessionsModule } from '../../src/remote-sessions/remote-sessions.module';
import { SignalingModule } from '../../src/signaling/signaling.module';
import { SupportRequest } from '../../src/support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../../src/support-requests/enums/support-request-status.enum';
import { SupportRequestsModule } from '../../src/support-requests/support-requests.module';

/**
 * Aplicacion de pruebas con los MODULOS DE PRODUCCION contra PostgreSQL real.
 *
 * Es `AppModule` con una sola diferencia: la conexion de TypeORM apunta a un
 * esquema temporal propio (`rc_rev_<uuid>`) que se crea al empezar y se borra
 * al terminar. Gateways, autenticacion de los dos tipos de identidad,
 * presencia, signaling, sesiones remotas, cierre automatico y controladores
 * REST son los reales, y el servidor Socket.IO lo crea el `SocketIoAdapter` de
 * `main.ts`. Los clientes son `socket.io-client` de verdad.
 *
 * Solo corre contra un PostgreSQL local: nunca contra Neon.
 */

export const REVOCATION_USER_JWT_SECRET = 'user-secret-for-revocation-tests';
export const REVOCATION_DEVICE_JWT_SECRET =
  'device-secret-for-revocation-tests';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** `SocketIoAdapter` de produccion que ademas recuerda el servidor creado. */
class ObservedSocketIoAdapter extends SocketIoAdapter {
  server: IoServer | null = null;

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as IoServer;
    this.server ??= server;
    return server;
  }
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

/** Resultado del handshake visto por el cliente. */
export type HandshakeOutcome =
  | { connected: true }
  | { connected: false; code: string | undefined; message: string };

export interface TestSocket {
  client: ClientSocket;
  /** Eventos recibidos, por nombre, en orden de llegada. */
  events: Map<string, unknown[]>;
  outcome: Promise<HandshakeOutcome>;
  /** Motivo del `disconnect` del cliente. */
  disconnected: Promise<string>;
  received(event: string): unknown[];
  /** ACK del evento, o `NO_ACK` si no llego (socket cerrado o rechazado). */
  emitWithAck(
    event: string,
    payload: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
}

export interface EnrolledDevice {
  device: Device;
  credentialId: string;
  deviceSecret: string;
  token: string;
}

export interface Technician {
  user: User;
  token: string;
}

export interface RevocationApp {
  app: INestApplication;
  dataSource: DataSource;
  http: HttpServer;
  io: IoServer;
  schema: string;
  seedTechnician(roles?: ValidRoles[]): Promise<Technician>;
  enrollDevice(): Promise<EnrolledDevice>;
  loginDevice(deviceId: string, deviceSecret: string): Promise<string>;
  seedAcceptedRequest(
    deviceId: string,
    technicianId: string,
  ): Promise<SupportRequest>;
  /**
   * Re-enrolamiento por el flujo real: codigo generado por un tecnico y
   * activacion desde la tablet. Devuelve el secreto nuevo.
   */
  reEnroll(admin: Technician, device: Device): Promise<string>;
  /** Sesiones de PostgreSQL esperando un lock en el esquema de la prueba. */
  lockWaiters(): Promise<number>;
  /** `POST /remote-sessions` real. Devuelve el id de la sesion creada. */
  createSession(
    technician: Technician,
    supportRequestId: string,
  ): Promise<string>;
  connectDevice(token: string): TestSocket;
  connectTechnician(token: string): TestSocket;
  sessionRow(id: string): Promise<RemoteSession>;
  requestRow(id: string): Promise<SupportRequest>;
  deviceRow(id: string): Promise<Device>;
  closeClients(): void;
  close(): Promise<void>;
}

export const startRevocationApp = async (): Promise<RevocationApp> => {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl)
    throw new Error(
      'DATABASE_URL no esta definido: `npm run test:db` necesita una base PostgreSQL real',
    );

  const target = new URL(databaseUrl);

  if (!LOCAL_HOSTS.has(target.hostname))
    throw new Error(
      `Las pruebas de revocacion solo corren contra un PostgreSQL local y DATABASE_URL apunta a ${target.hostname}.`,
    );

  const ssl = resolveDatabaseSsl(databaseUrl);
  const schema = `rc_rev_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const bootstrap = new DataSource({ type: 'postgres', url: databaseUrl, ssl });
  await bootstrap.initialize();
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  await bootstrap.destroy();

  // Los modulos leen sus secretos de `ConfigService`, que sin `.env` toma
  // `process.env`. Nunca se usan fuera de esta prueba.
  process.env.JWT_SECRET_KEY = REVOCATION_USER_JWT_SECRET;
  process.env.DEVICE_JWT_SECRET = REVOCATION_DEVICE_JWT_SECRET;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: databaseUrl,
        ssl,
        schema,
        autoLoadEntities: true,
        // El esquema acaba de nacer y se borra entero al final.
        synchronize: true,
      }),
      AuthModule,
      DevicesModule,
      SupportRequestsModule,
      RemoteSessionsModule,
      SignalingModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useLogger(['error']);

  const adapter = new ObservedSocketIoAdapter(
    app,
    ['http://localhost:5173'],
    DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG,
  );
  app.useWebSocketAdapter(adapter);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  await app.listen(0, '127.0.0.1');

  const http = app.getHttpServer() as HttpServer;
  const { port } = http.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataSource = app.get(DataSource);

  if (!adapter.server) throw new Error('El adaptador no creo el servidor');

  const userJwt = new JwtService({
    secret: REVOCATION_USER_JWT_SECRET,
    signOptions: { expiresIn: '1h' },
  });

  const clients: ClientSocket[] = [];

  const open = (namespace: string, token: string): TestSocket => {
    const client = io(`${baseUrl}${namespace}`, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token },
    });

    clients.push(client);

    const events = new Map<string, unknown[]>();

    client.onAny((event: string, payload: unknown) => {
      const list = events.get(event) ?? [];
      list.push(payload);
      events.set(event, list);
    });

    const outcome = new Promise<HandshakeOutcome>((resolve) => {
      client.once('connect', () => resolve({ connected: true }));
      client.once(
        'connect_error',
        (error: Error & { data?: { code?: string } }) =>
          resolve({
            connected: false,
            code: error.data?.code,
            message: error.message,
          }),
      );
    });

    const disconnected = new Promise<string>((resolve) =>
      client.once('disconnect', (reason) => resolve(reason)),
    );

    return {
      client,
      events,
      outcome,
      disconnected,
      received: (event) => events.get(event) ?? [],
      // Un cliente desconectado solo encolaria el evento: el servidor nunca lo
      // recibiria. Se dice asi en lugar de esperar al timeout.
      emitWithAck: (event, payload, timeoutMs = 1_500) =>
        client.connected
          ? client
              .timeout(timeoutMs)
              .emitWithAck(event, payload)
              .catch(() => 'NO_ACK')
          : Promise.resolve('NOT_CONNECTED'),
    };
  };

  const loginDevice = async (
    deviceId: string,
    deviceSecret: string,
  ): Promise<string> => {
    const response = await request(http)
      .post('/device-auth/login')
      .send({ deviceId, deviceSecret })
      .expect(200);

    return (response.body as { token: string }).token;
  };

  const harness: RevocationApp = {
    app,
    dataSource,
    http,
    io: adapter.server,
    schema,

    seedTechnician: async (roles = [ValidRoles.tecnico]) => {
      const users = dataSource.getRepository(User);
      const user = await users.save(
        users.create({
          email: `tecnico-${randomUUID()}@test.local`,
          // No es una credencial: el token se firma directamente.
          password: 'not-a-credential',
          fullName: 'Tecnica de prueba',
          isActive: true,
          roles,
        }),
      );

      return { user, token: userJwt.sign({ id: user.id }) };
    },

    enrollDevice: async () => {
      const devices = dataSource.getRepository(Device);
      const device = await devices.save(
        devices.create({
          publicId: [0, 1, 2]
            .map(() => String(randomInt(0, 1000)).padStart(3, '0'))
            .join('-'),
          name: 'Tablet de prueba',
          isActive: true,
        }),
      );

      // Misma emision que hace la activacion del enrolamiento.
      const { credentialId, deviceSecret } = await dataSource.transaction(
        (manager) =>
          app
            .get(DeviceCredentialsService)
            .issueCredential(manager, device.id, new Date()),
      );

      return {
        device,
        credentialId,
        deviceSecret,
        token: await loginDevice(device.id, deviceSecret),
      };
    },

    loginDevice,

    reEnroll: async (admin, device) => {
      const code = await request(http)
        .post(`/devices/${device.id}/enrollment`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(201);

      const activation = await request(http)
        .post('/device-enrollment/activate')
        .send({
          publicId: device.publicId,
          code: (code.body as { enrollmentCode: string }).enrollmentCode,
        })
        .expect(200);

      return (activation.body as { deviceSecret: string }).deviceSecret;
    },

    lockWaiters: async () => {
      const rows: Array<{ waiting: string }> = await dataSource.query(
        `SELECT count(*)::text AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );

      return Number(rows[0]?.waiting ?? 0);
    },

    seedAcceptedRequest: (deviceId, technicianId) => {
      const requests = dataSource.getRepository(SupportRequest);
      const now = new Date();

      return requests.save(
        requests.create({
          deviceId,
          technicianId,
          status: SupportRequestStatus.ACCEPTED,
          assignedAt: now,
          respondedAt: now,
          closedAt: null,
        }),
      );
    },

    createSession: async (technician, supportRequestId) => {
      const response = await request(http)
        .post('/remote-sessions')
        .set('Authorization', `Bearer ${technician.token}`)
        .send({ supportRequestId })
        .expect(201);

      return (response.body as { id: string }).id;
    },

    connectDevice: (token) => open('/devices', token),
    connectTechnician: (token) => open('/technicians', token),

    sessionRow: (id) =>
      dataSource.getRepository(RemoteSession).findOneByOrFail({ id }),
    requestRow: (id) =>
      dataSource.getRepository(SupportRequest).findOneByOrFail({ id }),
    deviceRow: (id) => dataSource.getRepository(Device).findOneByOrFail({ id }),

    closeClients: () => {
      while (clients.length > 0) clients.pop()?.close();
    },

    close: async () => {
      harness.closeClients();
      await app.close();

      const cleanup = new DataSource({
        type: 'postgres',
        url: databaseUrl,
        ssl,
      });
      await cleanup.initialize();
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.destroy();
    },
  };

  return harness;
};

/** Espera activa con limite, para estados que el servidor alcanza solo. */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** Margen para que un mensaje que NO debe llegar tuviera tiempo de llegar. */
export const settle = (ms = 200): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
