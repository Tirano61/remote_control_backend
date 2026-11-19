import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Server } from 'http';
import * as request from 'supertest';
import { FindOneOptions, FindOperator, QueryFailedError } from 'typeorm';
import { DeviceCredential } from '../entities/device-credential.entity';
import { Device } from '../entities/device.entity';
import { DeviceAuthController } from './device-auth.controller';
import { DeviceAuthService } from './device-auth.service';
import { DEVICE_CREDENTIAL_REJECTED } from './device-credential-rejected.exception';
import { DeviceCredentialsService } from './device-credentials.service';
import { DEVICE_TOKEN_TYPE } from './interfaces/device-jwt-payload.interface';
import { DeviceJwtStrategy } from './strategies/device-jwt.strategy';

/**
 * Contrato HTTP de `POST /device-auth/login`.
 *
 * Lo que se fija aqui es CUANDO sale `code: DEVICE_CREDENTIAL_REJECTED` y,
 * sobre todo, cuando no: un fallo de PostgreSQL o una excepcion inesperada
 * tienen que seguir saliendo como 500 sin ese codigo, porque la tablet borra
 * su credencial al ver un rechazo confirmado.
 *
 * Servicio, `DeviceCredentialsService`, `JwtService` y estrategia Passport son
 * los reales. Solo los repositorios se sustituyen por un almacen en memoria;
 * la misma bateria contra PostgreSQL de verdad esta en
 * `test/device-auth.db-spec.ts`.
 */

const DEVICE_JWT_SECRET = 'device-secret-for-tests';
const USER_JWT_SECRET = 'user-secret-for-tests';

/** Cuerpo exacto del rechazo confirmado. */
const REJECTED_BODY = {
  statusCode: 401,
  code: DEVICE_CREDENTIAL_REJECTED,
  message: 'Invalid device credentials',
  error: 'Unauthorized',
};

/** Cuerpo exacto del 500 por defecto de NestJS. */
const INTERNAL_ERROR_BODY = {
  statusCode: 500,
  message: 'Internal server error',
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const newSecret = (): string => randomBytes(32).toString('base64url');

/** Error tal como lo entrega `pg` cuando el servidor no acepta conexiones. */
const connectionRefused = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
    address: '127.0.0.1',
    port: 5432,
  });

/** Error tal como lo entrega `pg` cuando vence `connectionTimeoutMillis`. */
const connectionTimeout = (): Error =>
  new Error('Connection terminated due to connection timeout');

/** Error de consulta como lo envuelve TypeORM. */
const queryFailed = (): QueryFailedError =>
  new QueryFailedError(
    'SELECT * FROM "devices"',
    [],
    Object.assign(new Error('relation "devices" does not exist'), {
      code: '42P01',
    }),
  );

describe('DeviceAuthController (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let jwtService: JwtService;

  let devices: Device[];
  let credentials: DeviceCredential[];

  /** Almacen en memoria con la forma de las consultas del servicio. */
  const deviceRepository = {
    findOneBy: jest.fn((where: { id: string }) =>
      Promise.resolve(devices.find((d) => d.id === where.id) ?? null),
    ),
  };

  const deviceCredentialRepository = {
    findOne: jest.fn((options: FindOneOptions<DeviceCredential>) => {
      const where = options.where as unknown as {
        deviceId: string;
        revokedAt: FindOperator<null>;
      };

      // El servicio pide siempre `revokedAt: IsNull()`: solo la vigente.
      expect(where.revokedAt).toBeInstanceOf(FindOperator);

      return Promise.resolve(
        credentials.find(
          (c) => c.deviceId === where.deviceId && c.revokedAt === null,
        ) ?? null,
      );
    }),
    update: jest.fn(
      (where: { id: string }, data: Partial<DeviceCredential>) => {
        const credential = credentials.find((c) => c.id === where.id);
        if (credential) Object.assign(credential, data);

        return Promise.resolve({ affected: credential ? 1 : 0 });
      },
    ),
  };

  const config: Record<string, string> = {
    DEVICE_JWT_SECRET,
    JWT_SECRET_KEY: USER_JWT_SECRET,
  };

  /** Alta de un dispositivo enrolado; devuelve el secreto en claro. */
  const enrollDevice = (
    overrides: Partial<Device> = {},
  ): { device: Device; deviceSecret: string } => {
    const device = {
      id: randomUUID(),
      publicId: '384-729-142',
      name: 'Tablet Tolva 01',
      isActive: true,
      ...overrides,
    } as Device;

    devices.push(device);

    return { device, deviceSecret: issueCredential(device.id) };
  };

  /** Lo que hace `DeviceCredentialsService.issueCredential`: revoca y emite. */
  const issueCredential = (deviceId: string): string => {
    const now = new Date();

    for (const c of credentials)
      if (c.deviceId === deviceId && c.revokedAt === null) c.revokedAt = now;

    const deviceSecret = newSecret();

    credentials.push({
      id: randomUUID(),
      deviceId,
      secretHash: sha256(deviceSecret),
      lastUsedAt: null,
      revokedAt: null,
    } as DeviceCredential);

    return deviceSecret;
  };

  const login = (body: object) =>
    request(server).post('/device-auth/login').send(body);

  /** Login correcto; devuelve el Device JWT. */
  const loginToken = async (
    deviceId: string,
    deviceSecret: string,
  ): Promise<string> => {
    const response = await login({ deviceId, deviceSecret }).expect(200);

    return (response.body as { token: string }).token;
  };

  beforeAll(async () => {
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
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Los 500 provocados a proposito no ensucian la salida de Jest.
    app.useLogger(false);

    // Mismas reglas que `main.ts`.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );

    await app.init();

    server = app.getHttpServer() as Server;
    jwtService = app.get(JwtService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    devices = [];
    credentials = [];
  });

  afterAll(async () => {
    await app.close();
  });

  describe('login valido', () => {
    it('responde 200 con la identidad y un Device JWT, sin campo code', async () => {
      const { device, deviceSecret } = enrollDevice();

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(200);

      // Compatibilidad: exactamente los campos de siempre.
      expect(Object.keys(response.body as object).sort()).toEqual(
        ['id', 'isActive', 'name', 'publicId', 'token'].sort(),
      );
      expect(response.body).toMatchObject({
        id: device.id,
        publicId: device.publicId,
        name: device.name,
        isActive: true,
      });
      expect(response.body).not.toHaveProperty('code');

      const payload = jwtService.verify<Record<string, unknown>>(
        (response.body as { token: string }).token,
      );
      expect(payload).toMatchObject({
        sub: device.id,
        tokenType: DEVICE_TOKEN_TYPE,
        credentialId: credentials[0].id,
      });

      expect(credentials[0].lastUsedAt).toBeInstanceOf(Date);
    });
  });

  describe('rechazo confirmado: 401 DEVICE_CREDENTIAL_REJECTED', () => {
    it('dispositivo inexistente', async () => {
      const response = await login({
        deviceId: randomUUID(),
        deviceSecret: newSecret(),
      }).expect(401);

      expect(response.body).toEqual(REJECTED_BODY);
    });

    it('dispositivo inactivo, aunque el secreto sea correcto', async () => {
      const { device, deviceSecret } = enrollDevice({ isActive: false });

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(401);

      expect(response.body).toEqual(REJECTED_BODY);
    });

    it('secreto incorrecto', async () => {
      const { device } = enrollDevice();

      const response = await login({
        deviceId: device.id,
        deviceSecret: newSecret(),
      }).expect(401);

      expect(response.body).toEqual(REJECTED_BODY);
      expect(deviceCredentialRepository.update).not.toHaveBeenCalled();
    });

    it('credencial revocada sin credencial vigente que la sustituya', async () => {
      const { device, deviceSecret } = enrollDevice();
      credentials[0].revokedAt = new Date();

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(401);

      expect(response.body).toEqual(REJECTED_BODY);
    });

    it('re-enrolamiento: el secreto anterior se rechaza y el nuevo funciona', async () => {
      const { device, deviceSecret: oldSecret } = enrollDevice();
      const newSecretValue = issueCredential(device.id);

      const rejected = await login({
        deviceId: device.id,
        deviceSecret: oldSecret,
      }).expect(401);
      expect(rejected.body).toEqual(REJECTED_BODY);

      await login({ deviceId: device.id, deviceSecret: newSecretValue }).expect(
        200,
      );
    });

    it('todos los motivos responden exactamente lo mismo', async () => {
      const active = enrollDevice();
      const inactive = enrollDevice({ isActive: false });
      const revoked = enrollDevice();
      credentials.find((c) => c.deviceId === revoked.device.id)!.revokedAt =
        new Date();

      const bodies = await Promise.all(
        [
          { deviceId: randomUUID(), deviceSecret: newSecret() },
          { deviceId: inactive.device.id, deviceSecret: inactive.deviceSecret },
          { deviceId: active.device.id, deviceSecret: newSecret() },
          { deviceId: revoked.device.id, deviceSecret: revoked.deviceSecret },
        ].map(async (body) => (await login(body).expect(401)).body as object),
      );

      for (const body of bodies) expect(body).toEqual(REJECTED_BODY);
    });

    it('el cuerpo no contiene el secreto ni datos del dispositivo', async () => {
      const { device, deviceSecret } = enrollDevice({ isActive: false });

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(401);

      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(deviceSecret);
      expect(raw).not.toContain(device.id);
      expect(raw).not.toContain(device.publicId);
      expect(raw).not.toContain(credentials[0].secretHash);
    });
  });

  describe('fallo de infraestructura: 500 sin code', () => {
    it.each([
      ['PostgreSQL rechaza la conexion', connectionRefused],
      ['timeout de conexion con PostgreSQL', connectionTimeout],
      ['QueryFailedError de TypeORM', queryFailed],
    ])('%s al buscar el dispositivo', async (_label, makeError) => {
      const { device, deviceSecret } = enrollDevice();
      deviceRepository.findOneBy.mockRejectedValueOnce(makeError());

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(500);

      expect(response.body).toEqual(INTERNAL_ERROR_BODY);
    });

    it('PostgreSQL falla al buscar la credencial', async () => {
      const { device, deviceSecret } = enrollDevice();
      deviceCredentialRepository.findOne.mockRejectedValueOnce(
        connectionRefused(),
      );

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(500);

      expect(response.body).toEqual(INTERNAL_ERROR_BODY);
    });

    it('PostgreSQL falla al registrar lastUsedAt: ni token ni rechazo', async () => {
      const { device, deviceSecret } = enrollDevice();
      deviceCredentialRepository.update.mockRejectedValueOnce(
        connectionTimeout(),
      );

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(500);

      expect(response.body).toEqual(INTERNAL_ERROR_BODY);
      expect(response.body).not.toHaveProperty('token');
    });

    it('PostgreSQL falla con un secreto incorrecto: sigue sin ser rechazo', async () => {
      // Sin consulta no hay verificacion: el backend no sabe si la
      // credencial valia, asi que no puede afirmar que no valia.
      const { device } = enrollDevice();
      deviceRepository.findOneBy.mockRejectedValueOnce(connectionRefused());

      const response = await login({
        deviceId: device.id,
        deviceSecret: newSecret(),
      }).expect(500);

      expect(response.body).toEqual(INTERNAL_ERROR_BODY);
    });

    it('excepcion interna inesperada al firmar el token', async () => {
      const { device, deviceSecret } = enrollDevice();
      jest.spyOn(jwtService, 'sign').mockImplementationOnce(() => {
        throw new TypeError('unexpected');
      });

      const response = await login({
        deviceId: device.id,
        deviceSecret,
      }).expect(500);

      expect(response.body).toEqual(INTERNAL_ERROR_BODY);
    });
  });

  describe('errores no relacionados no llevan el codigo', () => {
    it('400 de validacion en el login', async () => {
      const response = await login({
        deviceId: 'no-uuid',
        deviceSecret: 'x',
      }).expect(400);

      expect(response.body).not.toHaveProperty('code');
    });

    it('400 por un campo extra, como publicId', async () => {
      const { device, deviceSecret } = enrollDevice();

      const response = await login({
        deviceId: device.id,
        deviceSecret,
        publicId: device.publicId,
      }).expect(400);

      expect(response.body).not.toHaveProperty('code');
    });

    it('check-status sin token', async () => {
      const response = await request(server)
        .get('/device-auth/check-status')
        .expect(401);

      expect(response.body).not.toHaveProperty('code');
    });

    it('check-status con un Device JWT vencido', async () => {
      const { device } = enrollDevice();
      const expired = new JwtService({ secret: DEVICE_JWT_SECRET }).sign({
        sub: device.id,
        tokenType: DEVICE_TOKEN_TYPE,
        credentialId: credentials[0].id,
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      const response = await request(server)
        .get('/device-auth/check-status')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);

      expect(response.body).not.toHaveProperty('code');
    });

    it('check-status con un token de una credencial revocada por re-enrolamiento', async () => {
      const { device, deviceSecret } = enrollDevice();
      const token = await loginToken(device.id, deviceSecret);
      issueCredential(device.id);

      const response = await request(server)
        .get('/device-auth/check-status')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect(response.body).not.toHaveProperty('code');
    });

    it('check-status con un token valido sigue respondiendo 200', async () => {
      const { device, deviceSecret } = enrollDevice();
      const token = await loginToken(device.id, deviceSecret);

      const response = await request(server)
        .get('/device-auth/check-status')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toEqual({
        id: device.id,
        publicId: device.publicId,
        name: device.name,
        isActive: true,
      });
    });
  });

  describe('compatibilidad con el cliente actual', () => {
    it('el rechazo conserva status, statusCode, message y error de antes', async () => {
      const response = await login({
        deviceId: randomUUID(),
        deviceSecret: newSecret(),
      });

      // El cliente actual decide solo por el status HTTP.
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(/application\/json/);

      // Lo que respondia `new UnauthorizedException('Invalid device credentials')`.
      expect(response.body).toMatchObject({
        statusCode: 401,
        message: 'Invalid device credentials',
        error: 'Unauthorized',
      });
      // Y lo unico nuevo.
      expect(Object.keys(response.body as object).sort()).toEqual(
        ['code', 'error', 'message', 'statusCode'].sort(),
      );
    });
  });
});
