import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomBytes, randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
import { AddressInfo, createServer, Server as NetServer, Socket } from 'net';
import { Server } from 'http';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { resolveDatabaseSsl } from '../src/config/database.config';
import { DeviceAuthController } from '../src/devices/auth/device-auth.controller';
import { DeviceAuthService } from '../src/devices/auth/device-auth.service';
import { DEVICE_CREDENTIAL_REJECTED } from '../src/devices/auth/device-credential-rejected.exception';
import { DeviceCredentialsService } from '../src/devices/auth/device-credentials.service';
import { DeviceJwtStrategy } from '../src/devices/auth/strategies/device-jwt.strategy';
import { DeviceCredential } from '../src/devices/entities/device-credential.entity';
import { Device } from '../src/devices/entities/device.entity';

/**
 * `POST /device-auth/login` por HTTP contra PostgreSQL de verdad.
 *
 * Complementa `src/devices/auth/device-auth.controller.spec.ts`: alli los
 * repositorios son dobles y los fallos de base de datos, errores fabricados.
 * Aqui las consultas, el indice unico de la credencial activa y la revocacion
 * por re-enrolamiento son los de PostgreSQL, y los fallos de infraestructura se
 * provocan de verdad: la aplicacion conecta a traves de un proxy TCP local que
 * se puede cortar (conexion rechazada) o dejar mudo (timeout de conexion).
 *
 * NO forma parte de `npm test`. Se ejecuta con `npm run test:db`.
 *
 * DESTINO: solo acepta un PostgreSQL local (`localhost`, `127.0.0.1`, `::1`).
 * Contra cualquier otro host se niega a arrancar salvo que se declare
 * `TEST_DB_ALLOW_REMOTE=true`. Aun asi, todo ocurre en un esquema temporal
 * propio (`rc_test_<uuid>`) que se crea al empezar y se borra al terminar.
 */

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL?.trim();

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const TEST_SCHEMA = `rc_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

const DEVICE_JWT_SECRET = randomBytes(32).toString('hex');
const USER_JWT_SECRET = randomBytes(32).toString('hex');

/** Lo que tarda el pool en dar por perdida una conexion que no contesta. */
const CONNECTION_TIMEOUT_MS = 1_500;

const REJECTED_BODY = {
  statusCode: 401,
  code: DEVICE_CREDENTIAL_REJECTED,
  message: 'Invalid device credentials',
  error: 'Unauthorized',
};

const INTERNAL_ERROR_BODY = {
  statusCode: 500,
  message: 'Internal server error',
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Proxy TCP entre la aplicacion y PostgreSQL.
 *
 * `forward` reenvia; `refuse` cierra el puerto, como un servidor caido;
 * `blackhole` acepta la conexion y no contesta nunca, como una red que pierde
 * paquetes. Al cambiar de modo se cortan las conexiones abiertas, de modo que
 * el pool tiene que volver a conectar.
 */
class TcpProxy {
  private server: NetServer | null = null;
  private readonly sockets = new Set<Socket>();
  private mode: 'forward' | 'blackhole' = 'forward';
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async listen(): Promise<void> {
    this.server = createServer((client) => {
      this.track(client);

      if (this.mode === 'blackhole') return;

      const upstream = new Socket();
      this.track(upstream);
      upstream.connect(this.targetPort, this.targetHost);
      client.pipe(upstream).pipe(client);
    });

    await new Promise<void>((resolve) =>
      this.server!.listen(this.port, '127.0.0.1', resolve),
    );

    this.port = (this.server.address() as AddressInfo).port;
  }

  async forward(): Promise<void> {
    await this.cut();
    this.mode = 'forward';
    if (!this.server) await this.listen();
  }

  async blackhole(): Promise<void> {
    await this.cut();
    this.mode = 'blackhole';
    if (!this.server) await this.listen();
  }

  async refuse(): Promise<void> {
    await this.cut();
    await this.close();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.destroyAll();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Corta lo abierto y espera a que el pool se entere. */
  private async cut(): Promise<void> {
    this.destroyAll();
    await delay(200);
  }

  private destroyAll(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));
  }
}

describe('POST /device-auth/login contra PostgreSQL', () => {
  let admin: DataSource;
  let dataSource: DataSource;
  let proxy: TcpProxy;
  let app: INestApplication;
  let server: Server;

  const login = (body: object) =>
    request(server).post('/device-auth/login').send(body);

  /** Alta real de un dispositivo y emision real de su credencial. */
  const enrollDevice = async (
    overrides: Partial<Device> = {},
  ): Promise<{ device: Device; deviceSecret: string }> => {
    const device = await admin.getRepository(Device).save(
      admin.getRepository(Device).create({
        publicId: `${randomDigits(3)}-${randomDigits(3)}-${randomDigits(3)}`,
        name: 'Tablet Tolva 01',
        isActive: true,
        ...overrides,
      }),
    );

    return { device, deviceSecret: await reEnroll(device.id) };
  };

  /**
   * Lo mismo que hace la activacion del enrolamiento con la credencial: en una
   * transaccion, revocar la vigente y emitir otra.
   */
  const reEnroll = async (deviceId: string): Promise<string> => {
    const credentials = new DeviceCredentialsService();

    const { deviceSecret } = await admin.transaction((manager) =>
      credentials.issueCredential(manager, deviceId, new Date()),
    );

    return deviceSecret;
  };

  beforeAll(async () => {
    if (!DATABASE_URL)
      throw new Error(
        'DATABASE_URL no esta definido: `npm run test:db` necesita una base PostgreSQL real',
      );

    const target = new URL(DATABASE_URL);

    if (
      !LOCAL_HOSTS.has(target.hostname) &&
      process.env.TEST_DB_ALLOW_REMOTE !== 'true'
    )
      throw new Error(
        `device-auth.db-spec solo corre contra un PostgreSQL local y DATABASE_URL apunta a ${target.hostname}. ` +
          'Usa una base aislada o declara TEST_DB_ALLOW_REMOTE=true a sabiendas.',
      );

    const ssl = resolveDatabaseSsl(DATABASE_URL);

    const bootstrap = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      ssl,
    });
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await bootstrap.destroy();

    // Conexion directa: prepara datos y nunca pasa por el proxy.
    admin = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      ssl,
      schema: TEST_SCHEMA,
      entities: [Device, DeviceCredential],
      synchronize: true,
    });
    await admin.initialize();

    proxy = new TcpProxy(target.hostname, Number(target.port || 5432));
    await proxy.listen();

    const viaProxy = new URL(DATABASE_URL);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);

    // La de la aplicacion: misma base y esquema, pero a traves del proxy.
    dataSource = new DataSource({
      type: 'postgres',
      url: viaProxy.toString(),
      ssl,
      schema: TEST_SCHEMA,
      entities: [Device, DeviceCredential],
      extra: { connectionTimeoutMillis: CONNECTION_TIMEOUT_MS, max: 2 },
    });
    await dataSource.initialize();

    const config: Record<string, string> = {
      DEVICE_JWT_SECRET,
      JWT_SECRET_KEY: USER_JWT_SECRET,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '24h' },
        }),
      ],
      controllers: [DeviceAuthController],
      providers: [
        DeviceAuthService,
        DeviceCredentialsService,
        DeviceJwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        {
          provide: getRepositoryToken(Device),
          useValue: dataSource.getRepository(Device),
        },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: dataSource.getRepository(DeviceCredential),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Cada prueba empieza con PostgreSQL alcanzable.
    await proxy.forward();
  });

  afterAll(async () => {
    await app?.close();
    if (dataSource?.isInitialized) await dataSource.destroy();
    await proxy?.close();

    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      await admin.destroy();
    }
  });

  it('login valido: 200, Device JWT y lastUsedAt registrado', async () => {
    const { device, deviceSecret } = await enrollDevice();

    const response = await login({ deviceId: device.id, deviceSecret }).expect(
      200,
    );

    expect(Object.keys(response.body as object).sort()).toEqual(
      ['id', 'isActive', 'name', 'publicId', 'token'].sort(),
    );
    expect(response.body).toMatchObject({ id: device.id, isActive: true });

    const credential = await admin
      .getRepository(DeviceCredential)
      .findOneByOrFail({ deviceId: device.id });
    expect(credential.lastUsedAt).toBeInstanceOf(Date);
  });

  it('dispositivo inexistente', async () => {
    const response = await login({
      deviceId: randomUUID(),
      deviceSecret: randomBytes(32).toString('base64url'),
    }).expect(401);

    expect(response.body).toEqual(REJECTED_BODY);
  });

  it('dispositivo inactivo, con su secreto correcto', async () => {
    const { device, deviceSecret } = await enrollDevice();
    await admin.getRepository(Device).update(device.id, { isActive: false });

    const response = await login({ deviceId: device.id, deviceSecret }).expect(
      401,
    );

    expect(response.body).toEqual(REJECTED_BODY);
  });

  it('secreto incorrecto', async () => {
    const { device } = await enrollDevice();

    const response = await login({
      deviceId: device.id,
      deviceSecret: randomBytes(32).toString('base64url'),
    }).expect(401);

    expect(response.body).toEqual(REJECTED_BODY);
  });

  it('credencial revocada sin otra vigente', async () => {
    const { device, deviceSecret } = await enrollDevice();
    await admin
      .getRepository(DeviceCredential)
      .update({ deviceId: device.id }, { revokedAt: new Date() });

    const response = await login({ deviceId: device.id, deviceSecret }).expect(
      401,
    );

    expect(response.body).toEqual(REJECTED_BODY);
  });

  it('re-enrolamiento: el secreto anterior se rechaza y el nuevo entra', async () => {
    const { device, deviceSecret: oldSecret } = await enrollDevice();
    const newSecret = await reEnroll(device.id);

    const rejected = await login({
      deviceId: device.id,
      deviceSecret: oldSecret,
    }).expect(401);
    expect(rejected.body).toEqual(REJECTED_BODY);

    await login({ deviceId: device.id, deviceSecret: newSecret }).expect(200);
  });

  it('PostgreSQL inaccesible (conexion rechazada): 500 sin code', async () => {
    const { device, deviceSecret } = await enrollDevice();
    await proxy.refuse();

    const response = await login({ deviceId: device.id, deviceSecret }).expect(
      500,
    );

    expect(response.body).toEqual(INTERNAL_ERROR_BODY);
  });

  it('PostgreSQL inaccesible con un secreto incorrecto: tampoco es rechazo', async () => {
    const { device } = await enrollDevice();
    await proxy.refuse();

    const response = await login({
      deviceId: device.id,
      deviceSecret: randomBytes(32).toString('base64url'),
    }).expect(500);

    expect(response.body).toEqual(INTERNAL_ERROR_BODY);
  });

  it('PostgreSQL no contesta (timeout de conexion): 500 sin code', async () => {
    const { device, deviceSecret } = await enrollDevice();
    await proxy.blackhole();

    const response = await login({ deviceId: device.id, deviceSecret }).expect(
      500,
    );

    expect(response.body).toEqual(INTERNAL_ERROR_BODY);
  });

  it('error de consulta real de PostgreSQL: 500 sin code', async () => {
    const { device, deviceSecret } = await enrollDevice();

    // La tabla desaparece: `relation "device_credentials" does not exist`.
    await admin.query(
      `ALTER TABLE "${TEST_SCHEMA}"."device_credentials" RENAME TO "device_credentials_off"`,
    );

    try {
      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(500);

      expect(response.body).toEqual(INTERNAL_ERROR_BODY);
    } finally {
      await admin.query(
        `ALTER TABLE "${TEST_SCHEMA}"."device_credentials_off" RENAME TO "device_credentials"`,
      );
    }
  });

  it('excepcion interna inesperada: 500 sin code', async () => {
    const { device, deviceSecret } = await enrollDevice();
    jest.spyOn(app.get(JwtService), 'sign').mockImplementationOnce(() => {
      throw new TypeError('unexpected');
    });

    const response = await login({ deviceId: device.id, deviceSecret }).expect(
      500,
    );

    expect(response.body).toEqual(INTERNAL_ERROR_BODY);
  });

  it('recuperado PostgreSQL, el mismo dispositivo vuelve a entrar', async () => {
    const { device, deviceSecret } = await enrollDevice();

    await proxy.refuse();
    await login({ deviceId: device.id, deviceSecret }).expect(500);

    await proxy.forward();
    await login({ deviceId: device.id, deviceSecret }).expect(200);
  });
});

function randomDigits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');
}
