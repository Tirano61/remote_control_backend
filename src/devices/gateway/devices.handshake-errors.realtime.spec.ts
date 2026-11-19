import { INestApplication, Logger } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { Namespace } from 'socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
import {
  closedLoopbackPort,
  queryFailedError,
  queryThroughDriver,
  SilentTcpServer,
} from '../../../test/support/pg-driver-failures';
import { RemoteSession } from '../../remote-sessions/entities/remote-session.entity';
import { SessionParticipationService } from '../../signaling/participation/session-participation.service';
import { SignalingRealtimeService } from '../../signaling/realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from '../../signaling/realtime/technician-realtime.service';
import { REMOTE_SESSION_JOIN_EVENT } from '../../signaling/signaling.events';
import { SignalingService } from '../../signaling/signaling.service';
import { DeviceAuthService } from '../auth/device-auth.service';
import { DeviceCredentialsService } from '../auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../auth/interfaces/device-jwt-payload.interface';
import { DevicesService } from '../devices.service';
import { DeviceCredential } from '../entities/device-credential.entity';
import { Device } from '../entities/device.entity';
import { DevicePresenceService } from '../presence/device-presence.service';
import { DeviceRealtimeService } from '../realtime/device-realtime.service';
import { DeviceHandshakeErrorCode } from './device-handshake-error';
import {
  DEVICE_CONNECTED_EVENT,
  DEVICES_NAMESPACE,
  DevicesGateway,
} from './devices.gateway';

/**
 * El `connect_error` de `/devices` tal como lo recibe un cliente Socket.IO
 * real, a traves de un servidor real.
 *
 * El gateway, su middleware, `DeviceAuthService` (firma incluida), la presencia
 * y el signaling son los de produccion. Los repositorios de TypeORM son dobles
 * en memoria; cuando se les pide fallar, el fallo lo produce EN VIVO el driver
 * `pg` durante el handshake: conexion a un puerto local cerrado o a un servidor
 * TCP que nunca contesta. No hay PostgreSQL ni ninguna base de datos.
 *
 * Ademas del error que entrega `socket.io-client`, se captura el paquete
 * Engine.IO crudo, que es lo que cualquier cliente (tambien el de Dart) decodifica.
 */
jest.setTimeout(30_000);

const DEVICE_JWT_SECRET = 'device-secret-for-handshake-realtime-tests';
const USER_JWT_SECRET = 'user-secret-for-handshake-realtime-tests';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const PUBLIC_ID = '384-729-142';
const CREDENTIAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const UNAUTHORIZED_PACKET =
  '4/devices,{"message":"Unauthorized","data":{"code":"DEVICE_AUTH_UNAUTHORIZED"}}';
const UNAVAILABLE_PACKET =
  '4/devices,{"message":"Service unavailable","data":{"code":"DEVICE_AUTH_UNAVAILABLE"}}';

type DatabaseMode = 'up' | 'refused' | 'timeout' | 'query-error' | 'unexpected';

interface HandshakeError extends Error {
  data?: unknown;
}

interface Attempt {
  client: ClientSocket;
  /** Mensajes Socket.IO crudos (sin el prefijo Engine.IO `4`) recibidos. */
  raw: string[];
  result: Promise<
    { connected: true } | { connected: false; error: HandshakeError }
  >;
}

describe('DevicesGateway — connect_error por Socket.IO real', () => {
  let app: INestApplication;
  let url: string;
  let namespace: Namespace;
  let presence: DevicePresenceService;
  let signaling: SignalingService;
  let deviceJwt: JwtService;
  let userJwt: JwtService;

  let device: Device;
  let activeCredentialId: string | null;
  let databaseMode: DatabaseMode;

  let closedPort: number;
  const silentServer = new SilentTcpServer();

  const openClients: ClientSocket[] = [];

  /** Cada acceso a la "base" pasa por aqui y falla como se haya pedido. */
  const database = async <T>(answer: () => T): Promise<T> => {
    switch (databaseMode) {
      case 'refused':
        return queryThroughDriver(closedPort);
      case 'timeout':
        return queryThroughDriver(silentServer.port, 300);
      case 'query-error':
        throw queryFailedError();
      case 'unexpected':
        throw new TypeError(
          "Cannot read properties of undefined (reading 'id')",
        );
      default:
        return answer();
    }
  };

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) =>
      database(() => (id === device.id ? device : null)),
    find: () => database(() => [device]),
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      database(() =>
        activeCredentialId && where.deviceId === device.id
          ? { id: activeCredentialId, deviceId: device.id, secretHash: 'hash' }
          : null,
      ),
    update: () => database(() => ({ affected: 1 })),
  };

  const signDeviceToken = (payload: Partial<DeviceJwtPayload> = {}): string =>
    deviceJwt.sign({
      sub: DEVICE_ID,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_ID,
      ...payload,
    });

  const expiredDeviceToken = (): string =>
    new JwtService({ secret: DEVICE_JWT_SECRET }).sign({
      sub: DEVICE_ID,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_ID,
      exp: Math.floor(Date.now() / 1000) - 60,
    });

  /** Espera el desenlace del intento de conexion en curso de `client`. */
  const outcomeOf = (client: ClientSocket): Attempt['result'] =>
    new Promise((resolve) => {
      const onConnect = () => {
        client.off('connect_error', onError);
        resolve({ connected: true });
      };
      const onError = (error: HandshakeError) => {
        client.off('connect', onConnect);
        resolve({ connected: false, error });
      };

      client.once('connect', onConnect);
      client.once('connect_error', onError);
    });

  /** Abre un socket real; el resultado dice si el servidor lo acepto. */
  const attempt = (auth?: Record<string, unknown>): Attempt => {
    const client = io(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth,
    });
    const raw: string[] = [];

    openClients.push(client);

    // El Manager abre la conexion Engine.IO; desde ahi se ve cada mensaje tal
    // como viaja, antes de que el parser de Socket.IO lo interprete.
    client.io.on('open', () =>
      client.io.engine.on('message', (data: unknown) => {
        if (typeof data === 'string') raw.push(data);
      }),
    );

    return { client, raw, result: outcomeOf(client) };
  };

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

  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const refusal = async (
    pending: Attempt,
  ): Promise<{ error: HandshakeError; raw: string[] }> => {
    const result = await pending.result;

    if (result.connected)
      throw new Error('El servidor acepto un handshake que debia rechazar');

    return { error: result.error, raw: pending.raw };
  };

  /** Sin socket en el namespace, sin presencia y sin registro de presencia. */
  const expectNoTrace = (): void => {
    expect(namespace.sockets.size).toBe(0);
    expect(presence.connectionCount(DEVICE_ID)).toBe(0);
    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  };

  beforeAll(async () => {
    closedPort = await closedLoopbackPort();
    await silentServer.listen();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      providers: [
        DevicesGateway,
        DevicePresenceService,
        DeviceRealtimeService,
        DeviceAuthService,
        DeviceCredentialsService,
        DevicesService,
        SignalingService,
        SessionParticipationService,
        SignalingRealtimeService,
        TechnicianRealtimeService,
        {
          provide: getRepositoryToken(RemoteSession),
          useValue: { findOne: () => Promise.resolve(null) },
        },
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Los avisos del middleware ensuciarian la salida; su contenido se
    // comprueba en la prueba de logs.
    app.useLogger(false);

    presence = app.get(DevicePresenceService);
    signaling = app.get(SignalingService);
    deviceJwt = app.get(JwtService);
    userJwt = new JwtService({ secret: USER_JWT_SECRET });

    const gateway = app.get(DevicesGateway);
    const afterInit = jest.spyOn(gateway, 'afterInit');

    afterInit.mockImplementation((initialized) => {
      namespace = initialized;
      afterInit.mockRestore();
      gateway.afterInit(initialized);
    });

    await app.listen(0);

    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    url = `http://127.0.0.1:${port}${DEVICES_NAMESPACE}`;
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
    databaseMode = 'up';
  });

  afterEach(async () => {
    jest.restoreAllMocks();

    while (openClients.length > 0) openClients.pop()?.close();

    await waitFor(
      () => presence.connectionCount(DEVICE_ID) === 0,
      'presencia vacia entre pruebas',
    );
  });

  afterAll(async () => {
    await app.close();
    await silentServer.close();
  });

  it('handshake valido: conecta, recibe device:connected y queda ONLINE', async () => {
    const pending = attempt({ token: signDeviceToken() });
    const confirmed = new Promise((resolve) =>
      pending.client.once(DEVICE_CONNECTED_EVENT, resolve),
    );

    expect(await pending.result).toEqual({ connected: true });
    expect(await confirmed).toEqual({
      deviceId: DEVICE_ID,
      publicId: PUBLIC_ID,
    });
    expect(pending.raw[0]).toMatch(/^0\/devices,\{"sid":"[^"]+"\}$/);

    await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');
    expect(namespace.sockets.size).toBe(1);
  });

  describe('autenticacion rechazada', () => {
    it.each<[string, () => Record<string, unknown> | undefined, () => void]>([
      ['sin token', () => undefined, () => undefined],
      ['JWT invalido', () => ({ token: 'not-a-jwt' }), () => undefined],
      ['JWT vencido', () => ({ token: expiredDeviceToken() }), () => undefined],
      [
        'JWT de usuario/tecnico',
        () => ({ token: userJwt.sign({ id: 'u', email: 'tech@acme.com' }) }),
        () => undefined,
      ],
      [
        'tokenType incorrecto',
        () => ({
          token: signDeviceToken({
            tokenType: 'user' as typeof DEVICE_TOKEN_TYPE,
          }),
        }),
        () => undefined,
      ],
      [
        'dispositivo inexistente',
        () => ({
          token: signDeviceToken({
            sub: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
          }),
        }),
        () => undefined,
      ],
      [
        'dispositivo desactivado',
        () => ({ token: signDeviceToken() }),
        () => {
          device = { ...device, isActive: false };
        },
      ],
      [
        'credencial revocada',
        () => ({ token: signDeviceToken() }),
        () => {
          activeCredentialId = 'b1f6d2f4-1f4a-4a2e-9d6e-2a0f7a5c9d31';
        },
      ],
    ])(
      '%s: connect_error DEVICE_AUTH_UNAUTHORIZED',
      async (_label, auth, arrange) => {
        arrange();
        const register = jest.spyOn(presence, 'register');

        const { error, raw } = await refusal(attempt(auth()));

        expect(error.message).toBe('Unauthorized');
        expect(error.data).toEqual({
          code: DeviceHandshakeErrorCode.UNAUTHORIZED,
        });
        expect(raw).toEqual([UNAUTHORIZED_PACKET]);
        expect(register).not.toHaveBeenCalled();
        expectNoTrace();
      },
    );
  });

  describe('infraestructura no disponible', () => {
    it.each<[DatabaseMode, string]>([
      [
        'refused',
        'PostgreSQL rechaza la conexion (ECONNREFUSED real del driver)',
      ],
      ['timeout', 'PostgreSQL no contesta (timeout real del pool del driver)'],
      ['query-error', 'la consulta falla (QueryFailedError)'],
      ['unexpected', 'excepcion inesperada'],
    ])('%s — %s: connect_error DEVICE_AUTH_UNAVAILABLE', async (mode) => {
      databaseMode = mode;
      const register = jest.spyOn(presence, 'register');

      const { error, raw } = await refusal(
        attempt({ token: signDeviceToken() }),
      );

      expect(error.message).toBe('Service unavailable');
      expect(error.data).toEqual({
        code: DeviceHandshakeErrorCode.UNAVAILABLE,
      });
      expect(raw).toEqual([UNAVAILABLE_PACKET]);
      expect(register).not.toHaveBeenCalled();
      expectNoTrace();
    });

    it('el servidor registra el fallo sin mensaje, token ni datos de conexion', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const token = signDeviceToken();
      databaseMode = 'refused';

      await refusal(attempt({ token }));

      const logged = warn.mock.calls.map((call) => String(call[0]));

      expect(logged).toEqual([
        'Device handshake refused, authentication unavailable: Error ECONNREFUSED',
      ]);
      for (const fragment of [token, '127.0.0.1', String(closedPort)])
        expect(logged.join('\n')).not.toContain(fragment);
    });
  });

  describe('estructura serializada', () => {
    it('message y data son las unicas propiedades que cruzan el cable', async () => {
      databaseMode = 'query-error';
      const unavailable = await refusal(attempt({ token: signDeviceToken() }));

      databaseMode = 'up';
      const unauthorized = await refusal(attempt({ token: 'not-a-jwt' }));

      for (const { raw } of [unavailable, unauthorized]) {
        expect(raw).toHaveLength(1);
        // `4` es CONNECT_ERROR en el protocolo de Socket.IO; despues del
        // namespace va el JSON completo del error.
        const body = JSON.parse(raw[0].replace(/^4\/devices,/, '')) as Record<
          string,
          unknown
        >;
        expect(Object.keys(body).sort()).toEqual(['data', 'message']);
        expect(Object.keys(body.data as object)).toEqual(['code']);
      }
    });
  });

  describe('reconexion', () => {
    it('cuando vuelve la infraestructura, el MISMO token conecta sin renovarlo', async () => {
      const token = signDeviceToken();

      databaseMode = 'refused';
      const pending = attempt({ token });
      const { error } = await refusal(pending);

      expect(error.data).toEqual({
        code: DeviceHandshakeErrorCode.UNAVAILABLE,
      });
      // Un rechazo del namespace no se reintenta solo: lo decide la aplicacion.
      expect(pending.client.active).toBe(false);

      databaseMode = 'up';
      const retried = outcomeOf(pending.client);
      pending.client.connect();

      expect(await retried).toEqual({ connected: true });
      await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');
      expect(namespace.sockets.size).toBe(1);
    });

    it('un JWT realmente invalido se rechaza en cada intento, haya o no base', async () => {
      const pending = attempt({ token: 'not-a-jwt' });
      const codes: unknown[] = [(await refusal(pending)).error.data];

      for (const mode of ['up', 'refused', 'up'] as DatabaseMode[]) {
        databaseMode = mode;
        const next = outcomeOf(pending.client);
        pending.client.connect();
        const result = await next;

        codes.push(result.connected ? 'CONNECTED' : result.error.data);
      }

      expect(codes).toEqual(
        Array(4).fill({ code: DeviceHandshakeErrorCode.UNAUTHORIZED }),
      );
      expectNoTrace();
    });
  });

  describe('sin conexiones fantasma', () => {
    it('una rafaga de handshakes fallidos no deja sockets ni presencia', async () => {
      const register = jest.spyOn(presence, 'register');

      databaseMode = 'refused';
      const failing = Array.from({ length: 10 }, (_, i) =>
        attempt({ token: i % 2 === 0 ? signDeviceToken() : 'not-a-jwt' }),
      );
      const results = await Promise.all(failing.map((p) => p.result));

      expect(results.every((r) => !r.connected)).toBe(true);
      expect(register).not.toHaveBeenCalled();
      expectNoTrace();
    });

    it('un socket rechazado no puede operar: sus eventos no llegan al signaling', async () => {
      const join = jest.spyOn(signaling, 'join');

      for (const [mode, token] of [
        ['up', 'not-a-jwt'],
        ['refused', signDeviceToken()],
      ] as const) {
        databaseMode = mode;
        const pending = attempt({ token });
        await refusal(pending);

        // El transporte Engine.IO sigue abierto tras el rechazo del namespace:
        // se inyecta a mano un EVENT de /devices con ACK, como haria un
        // cliente que ignorase el connect_error.
        pending.client.io.engine.send(
          `2/devices,7["${REMOTE_SESSION_JOIN_EVENT}",{"remoteSessionId":"a3bb189e-8bf9-3888-9912-ace4e6543002"}]`,
        );
        await delay(200);

        expect(pending.raw.some((m) => m.startsWith('3/devices,7'))).toBe(
          false,
        );
      }

      expect(join).not.toHaveBeenCalled();
      expectNoTrace();
    });

    it('si el cliente abandona mientras PostgreSQL no contesta, no queda nada', async () => {
      // Un pool de conexiones colgado: el middleware tarda en responder. El
      // cliente se va antes; Socket.IO descarta el `next` tardio.
      let release!: () => void;
      const hanging = new Promise<void>((resolve) => (release = resolve));
      jest.spyOn(deviceRepository, 'findOneBy').mockImplementation(async () => {
        await hanging;
        return device;
      });

      const pending = attempt({ token: signDeviceToken() });
      await delay(100);
      pending.client.close();
      release();
      await delay(200);

      expectNoTrace();
    });
  });
});
