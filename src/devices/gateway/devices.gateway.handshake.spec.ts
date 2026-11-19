import { Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import {
  closedLoopbackPort,
  driverErrorAgainst,
  FAILED_QUERY_SQL,
  queryFailedError,
  SilentTcpServer,
} from '../../../test/support/pg-driver-failures';
import { SignalingRealtimeService } from '../../signaling/realtime/signaling-realtime.service';
import { SignalingService } from '../../signaling/signaling.service';
import { DeviceAuthService } from '../auth/device-auth.service';
import { DeviceCredentialsService } from '../auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../auth/interfaces/device-jwt-payload.interface';
import { DeviceCredential } from '../entities/device-credential.entity';
import { Device } from '../entities/device.entity';
import { DevicePresenceService } from '../presence/device-presence.service';
import { DeviceRealtimeService } from '../realtime/device-realtime.service';
import {
  classifyHandshakeFailure,
  describeHandshakeFailure,
  DeviceHandshakeError,
  DeviceHandshakeErrorCode,
} from './device-handshake-error';
import { DeviceSocketContext, DevicesGateway } from './devices.gateway';

/**
 * Middleware de autenticacion del namespace `/devices`, sin Socket.IO.
 *
 * Se captura la funcion que `afterInit` registra con `namespace.use` y se
 * invoca con sockets de mentira. La autenticacion es la de produccion
 * (`DeviceAuthService` con firma real); solo los repositorios son dobles, y
 * los fallos de infraestructura que lanzan son errores genuinos del driver
 * `pg` (ver `test/support/pg-driver-failures.ts`).
 *
 * La conexion Socket.IO real esta en `devices.handshake-errors.realtime.spec.ts`.
 */

const DEVICE_JWT_SECRET = 'device-secret-for-handshake-unit-tests';
const USER_JWT_SECRET = 'user-secret-for-handshake-unit-tests';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const PUBLIC_ID = '384-729-142';
const CREDENTIAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const REPLACED_CREDENTIAL_ID = 'b1f6d2f4-1f4a-4a2e-9d6e-2a0f7a5c9d31';

interface FakeSocket {
  handshake: { auth: unknown };
  data: { device?: DeviceSocketContext };
}

type Middleware = (socket: FakeSocket, next: (error?: Error) => void) => void;

interface HandshakeOutcome {
  /** Lo que el middleware paso a `next`: `undefined` si acepto. */
  error: Error | undefined;
  socket: FakeSocket;
  nextCalls: number;
}

describe('DevicesGateway — clasificacion de errores del handshake', () => {
  const deviceJwt = new JwtService({ secret: DEVICE_JWT_SECRET });
  const userJwt = new JwtService({ secret: USER_JWT_SECRET });

  let device: Device | null;
  let activeCredentialId: string | null;

  /** Fallo de infraestructura que lanzara el proximo acceso a la base. */
  let failure: (() => Error) | null;

  let middleware: Middleware;

  let refusedError: Error;
  let timeoutError: Error;
  let silentServer: SilentTcpServer;

  const throwIfFailing = (): void => {
    if (failure) throw failure();
  };

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) => {
      throwIfFailing();
      return Promise.resolve(device && id === device.id ? device : null);
    },
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) => {
      throwIfFailing();
      return Promise.resolve(
        activeCredentialId && device && where.deviceId === device.id
          ? { id: activeCredentialId, deviceId: device.id, secretHash: 'hash' }
          : null,
      );
    },
  };

  const signDeviceToken = (payload: Partial<DeviceJwtPayload> = {}): string =>
    deviceJwt.sign({
      sub: DEVICE_ID,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_ID,
      ...payload,
    });

  const expiredDeviceToken = (): string =>
    deviceJwt.sign({
      sub: DEVICE_ID,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_ID,
      exp: Math.floor(Date.now() / 1000) - 60,
    });

  const handshake = (auth: unknown): Promise<HandshakeOutcome> =>
    new Promise((resolve) => {
      const socket: FakeSocket = { handshake: { auth }, data: {} };
      let nextCalls = 0;
      let error: Error | undefined;

      middleware(socket, (passed?: Error) => {
        nextCalls++;
        error = passed;
        // Se deja correr la cola de microtareas por si `next` se llamara dos
        // veces: el resultado se entrega despues.
        setImmediate(() => resolve({ error, socket, nextCalls }));
      });
    });

  /** Lo que Socket.IO serializa de un error de middleware (protocolo 5). */
  const wire = (error: Error | undefined): string =>
    JSON.stringify({
      message: error?.message,
      data: (error as { data?: unknown } | undefined)?.data,
    });

  const expectRefused = (
    outcome: HandshakeOutcome,
    code: DeviceHandshakeErrorCode,
    message: string,
  ): void => {
    expect(outcome.nextCalls).toBe(1);
    expect(outcome.error).toBeInstanceOf(DeviceHandshakeError);
    expect(outcome.error?.message).toBe(message);
    expect((outcome.error as DeviceHandshakeError).data).toEqual({ code });
    // Ninguna identidad queda en un socket rechazado.
    expect(outcome.socket.data.device).toBeUndefined();
  };

  const expectUnauthorized = (outcome: HandshakeOutcome): void =>
    expectRefused(
      outcome,
      DeviceHandshakeErrorCode.UNAUTHORIZED,
      'Unauthorized',
    );

  const expectUnavailable = (outcome: HandshakeOutcome): void =>
    expectRefused(
      outcome,
      DeviceHandshakeErrorCode.UNAVAILABLE,
      'Service unavailable',
    );

  beforeAll(async () => {
    refusedError = await driverErrorAgainst(await closedLoopbackPort());

    silentServer = new SilentTcpServer();
    await silentServer.listen();
    timeoutError = await driverErrorAgainst(silentServer.port, 200);

    const deviceAuthService = new DeviceAuthService(
      deviceRepository as unknown as Repository<Device>,
      deviceCredentialRepository as unknown as Repository<DeviceCredential>,
      new DeviceCredentialsService(),
      deviceJwt,
    );

    const gateway = new DevicesGateway(
      deviceAuthService,
      {} as DevicePresenceService,
      { bind: () => undefined } as unknown as DeviceRealtimeService,
      {} as SignalingService,
      {
        bindDeviceNamespace: () => undefined,
      } as unknown as SignalingRealtimeService,
    );

    const namespace = {
      use: (registered: Middleware) => {
        middleware = registered;
      },
    };

    gateway.afterInit(
      namespace as unknown as Parameters<typeof gateway.afterInit>[0],
    );
  });

  afterAll(async () => {
    await silentServer.close();
  });

  beforeEach(() => {
    device = {
      id: DEVICE_ID,
      publicId: PUBLIC_ID,
      name: 'Tablet Tolva 01',
      manufacturer: null,
      model: null,
      androidVersion: null,
      appVersion: null,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    activeCredentialId = CREDENTIAL_ID;
    failure = null;
  });

  afterEach(() => jest.restoreAllMocks());

  it('los errores del driver usados aqui son genuinos y distintos', () => {
    expect((refusedError as { code?: string }).code).toBe('ECONNREFUSED');
    expect(timeoutError.message).toMatch(/timeout/i);
  });

  it('describe los errores genuinos del driver aunque vengan de otro realm', () => {
    // El ECONNREFUSED lo crea el nucleo de Node: bajo Jest no es instancia del
    // `Error` del test. El log tiene que seguir mostrando tipo y codigo.
    expect(describeHandshakeFailure(refusedError)).toBe('Error ECONNREFUSED');
    expect(describeHandshakeFailure(timeoutError)).toBe('Error');
  });

  describe('JWT valido', () => {
    it('acepta y deja la identidad del token en el socket', async () => {
      const outcome = await handshake({ token: signDeviceToken() });

      expect(outcome.error).toBeUndefined();
      expect(outcome.nextCalls).toBe(1);
      expect(outcome.socket.data.device).toEqual({
        deviceId: DEVICE_ID,
        credentialId: CREDENTIAL_ID,
        publicId: PUBLIC_ID,
      });
    });
  });

  describe('autenticacion rechazada: DEVICE_AUTH_UNAUTHORIZED', () => {
    it('JWT vencido', async () => {
      expectUnauthorized(await handshake({ token: expiredDeviceToken() }));
    });

    it('JWT invalido (no es un JWT)', async () => {
      expectUnauthorized(await handshake({ token: 'not-a-jwt' }));
    });

    it('JWT firmado con otro secreto (token de usuario/tecnico)', async () => {
      const userToken = userJwt.sign({
        id: 'a-user-id',
        email: 'tech@acme.com',
      });

      expectUnauthorized(await handshake({ token: userToken }));
    });

    it('tokenType incorrecto con firma de dispositivo valida', async () => {
      const token = signDeviceToken({
        tokenType: 'user' as typeof DEVICE_TOKEN_TYPE,
      });

      expectUnauthorized(await handshake({ token }));
    });

    it('dispositivo inexistente', async () => {
      device = null;

      expectUnauthorized(await handshake({ token: signDeviceToken() }));
    });

    it('dispositivo desactivado', async () => {
      device = { ...device!, isActive: false };

      expectUnauthorized(await handshake({ token: signDeviceToken() }));
    });

    it('credencial revocada sin reemplazo', async () => {
      activeCredentialId = null;

      expectUnauthorized(await handshake({ token: signDeviceToken() }));
    });

    it('credencial reemplazada por un re-enrolamiento', async () => {
      activeCredentialId = REPLACED_CREDENTIAL_ID;

      expectUnauthorized(await handshake({ token: signDeviceToken() }));
    });

    it.each([
      ['sin auth', undefined],
      ['auth vacio', {}],
      ['token vacio', { token: '' }],
      ['token que no es string', { token: 42 }],
      ['identidad suelta en vez de token', { deviceId: DEVICE_ID }],
    ])('handshake sin token utilizable: %s', async (_label, auth) => {
      expectUnauthorized(await handshake(auth));
    });

    it('todos los motivos producen exactamente el mismo error serializado', async () => {
      const outcomes = [
        await handshake({ token: expiredDeviceToken() }),
        await handshake({ token: 'not-a-jwt' }),
        await handshake({}),
      ];

      device = { ...device!, isActive: false };
      outcomes.push(await handshake({ token: signDeviceToken() }));

      device = { ...device, isActive: true };
      activeCredentialId = REPLACED_CREDENTIAL_ID;
      outcomes.push(await handshake({ token: signDeviceToken() }));

      const serialized = new Set(outcomes.map((o) => wire(o.error)));

      expect([...serialized]).toEqual([
        '{"message":"Unauthorized","data":{"code":"DEVICE_AUTH_UNAUTHORIZED"}}',
      ]);
    });

    it('una firma invalida se rechaza aunque la base de datos este caida', async () => {
      // La firma y el vencimiento se comprueban antes de consultar nada: un
      // token falso o vencido no se convierte en "no disponible".
      failure = () => refusedError;

      expectUnauthorized(await handshake({ token: 'not-a-jwt' }));
      expectUnauthorized(await handshake({ token: expiredDeviceToken() }));
    });
  });

  describe('infraestructura no disponible: DEVICE_AUTH_UNAVAILABLE', () => {
    it('conexion a PostgreSQL rechazada (ECONNREFUSED)', async () => {
      failure = () => refusedError;

      expectUnavailable(await handshake({ token: signDeviceToken() }));
    });

    it('timeout de conexion a PostgreSQL', async () => {
      failure = () => timeoutError;

      expectUnavailable(await handshake({ token: signDeviceToken() }));
    });

    it('timeout de consulta (statement_timeout, 57014)', async () => {
      failure = () =>
        queryFailedError(
          '57014',
          'canceling statement due to statement timeout',
        );

      expectUnavailable(await handshake({ token: signDeviceToken() }));
    });

    it('error de consulta (QueryFailedError, tabla inexistente)', async () => {
      failure = () => queryFailedError();

      expectUnavailable(await handshake({ token: signDeviceToken() }));
    });

    it('fallo en la segunda consulta, la de la credencial', async () => {
      const findOne = jest
        .spyOn(deviceCredentialRepository, 'findOne')
        .mockImplementation(() => Promise.reject(queryFailedError()));

      expectUnavailable(await handshake({ token: signDeviceToken() }));
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it('excepcion inesperada del servicio de autenticacion', async () => {
      failure = () =>
        new TypeError("Cannot read properties of undefined (reading 'id')");

      expectUnavailable(await handshake({ token: signDeviceToken() }));
    });

    it('un valor lanzado que no es un Error', async () => {
      jest
        .spyOn(deviceRepository, 'findOneBy')
        .mockImplementation(() => Promise.reject('boom' as unknown as Error));

      expectUnavailable(await handshake({ token: signDeviceToken() }));
    });
  });

  describe('sin datos sensibles', () => {
    const sensitiveFragments = (token: string): string[] => [
      token,
      FAILED_QUERY_SQL,
      'relation',
      'SELECT',
      'ECONNREFUSED',
      '127.0.0.1',
      'timeout expired',
      'statement timeout',
      'rc_fictitious',
      DEVICE_ID,
      PUBLIC_ID,
      CREDENTIAL_ID,
      'Device is inactive',
      'Token not valid',
    ];

    it.each([
      ['conexion rechazada', () => refusedError],
      ['timeout de conexion', () => timeoutError],
      ['error de consulta', () => queryFailedError()],
      ['excepcion inesperada', () => new Error(`secret ${DEVICE_JWT_SECRET}`)],
    ])(
      'ni el cliente ni el log reciben detalles internos: %s',
      async (_label, makeError) => {
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
        const token = signDeviceToken();
        failure = makeError;

        const outcome = await handshake({ token });

        const toClient = wire(outcome.error);
        const logged = warn.mock.calls
          .map((call) => String(call[0]))
          .join('\n');

        expect(toClient).toBe(
          '{"message":"Service unavailable","data":{"code":"DEVICE_AUTH_UNAVAILABLE"}}',
        );
        expect(warn).toHaveBeenCalledTimes(1);

        for (const fragment of [
          ...sensitiveFragments(token),
          DEVICE_JWT_SECRET,
        ]) {
          expect(toClient).not.toContain(fragment);
          // El codigo del driver si se registra: es lo util para operar.
          if (fragment !== 'ECONNREFUSED')
            expect(logged).not.toContain(fragment);
        }
      },
    );

    it('un rechazo no revela el motivo ni se registra', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      device = { ...device!, isActive: false };
      const token = signDeviceToken();

      const toClient = wire((await handshake({ token })).error);

      for (const fragment of sensitiveFragments(token))
        expect(toClient).not.toContain(fragment);
      expect(warn).not.toHaveBeenCalled();
    });

    it('el error que recibe next no arrastra el error original', async () => {
      failure = () => queryFailedError();

      const { error } = await handshake({ token: signDeviceToken() });

      // `name` no viaja (Socket.IO solo envia `message` y `data`), pero tampoco
      // es el error del driver: es el del contrato.
      expect(Object.keys(error!).sort()).toEqual(['data', 'name']);
      expect(error!.name).toBe('DeviceHandshakeError');
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    });
  });

  describe('ningun socket autorizado ante un fallo', () => {
    it.each([
      ['rechazo', () => null, { token: 'not-a-jwt' }],
      ['conexion rechazada', () => refusedError, undefined],
      ['timeout', () => timeoutError, undefined],
      ['error de consulta', () => queryFailedError(), undefined],
      ['excepcion inesperada', () => new RangeError('x'), undefined],
    ])(
      '%s: next recibe un error exactamente una vez y el socket queda sin identidad',
      async (_label, makeError, auth) => {
        const error = makeError();
        failure = error ? () => error : null;

        const outcome = await handshake(auth ?? { token: signDeviceToken() });

        expect(outcome.nextCalls).toBe(1);
        expect(outcome.error).toBeInstanceOf(Error);
        expect(outcome.socket.data.device).toBeUndefined();
      },
    );

    it('tras recuperarse la base, el mismo token vuelve a autenticar', async () => {
      const token = signDeviceToken();

      failure = () => refusedError;
      expectUnavailable(await handshake({ token }));

      failure = null;
      const outcome = await handshake({ token });

      expect(outcome.error).toBeUndefined();
      expect(outcome.socket.data.device?.deviceId).toBe(DEVICE_ID);
    });
  });

  describe('compatibilidad con remote_control_device', () => {
    /**
     * Regla del cliente Android actual (`isUnauthorizedHandshakeError` en
     * `device_realtime_payloads.dart`): el `connect_error` llega como el mapa
     * `{message, data}` y es rechazo si y solo si `message == "Unauthorized"`,
     * comparado exacto.
     */
    const currentDeviceSeesRejection = (error: Error | undefined): boolean =>
      (JSON.parse(wire(error)) as { message?: unknown }).message ===
      'Unauthorized';

    it('un rechazo conserva el mensaje que el cliente actual reconoce', async () => {
      const { error } = await handshake({ token: 'not-a-jwt' });

      expect(currentDeviceSeesRejection(error)).toBe(true);
    });

    it('un fallo de infraestructura no se presenta como rechazo', async () => {
      failure = () => refusedError;

      const { error } = await handshake({ token: signDeviceToken() });

      expect(currentDeviceSeesRejection(error)).toBe(false);
      expect(error?.message.toLowerCase()).not.toContain('unauthorized');
    });
  });
});

describe('classifyHandshakeFailure / describeHandshakeFailure', () => {
  it('solo UnauthorizedException es rechazo', () => {
    expect(classifyHandshakeFailure(new UnauthorizedException()).code).toBe(
      DeviceHandshakeErrorCode.UNAUTHORIZED,
    );
    expect(
      classifyHandshakeFailure(new UnauthorizedException('Token not valid'))
        .code,
    ).toBe(DeviceHandshakeErrorCode.UNAUTHORIZED);

    for (const other of [
      new Error('Unauthorized'),
      queryFailedError(),
      new TypeError('x'),
      'Unauthorized',
      undefined,
      null,
    ])
      expect(classifyHandshakeFailure(other).code).toBe(
        DeviceHandshakeErrorCode.UNAVAILABLE,
      );
  });

  it('describe con tipo y codigo, nunca con el mensaje', () => {
    expect(describeHandshakeFailure(queryFailedError())).toBe(
      'QueryFailedError 42P01',
    );
    expect(
      describeHandshakeFailure(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
          code: 'ECONNREFUSED',
        }),
      ),
    ).toBe('Error ECONNREFUSED');
    expect(describeHandshakeFailure(new TypeError('secret'))).toBe('TypeError');
    expect(describeHandshakeFailure('secret')).toBe('string');
  });
});
