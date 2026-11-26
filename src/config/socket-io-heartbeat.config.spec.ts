import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import {
  DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG,
  resolveRemoteSessionLifecycleConfig,
} from './remote-session-lifecycle.config';
import {
  DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG,
  resolveSocketIoHeartbeatConfig,
  SOCKET_IO_HEARTBEAT_MAX_MS,
  SOCKET_IO_HEARTBEAT_MIN_MS,
  SOCKET_IO_PING_INTERVAL_MS_ENV,
  SOCKET_IO_PING_TIMEOUT_MS_ENV,
} from './socket-io-heartbeat.config';
import { SocketIoAdapter } from './socket-io.adapter';

describe('resolveSocketIoHeartbeatConfig', () => {
  it('usa 10000/10000 sin variables', () => {
    expect(resolveSocketIoHeartbeatConfig({})).toEqual({
      pingIntervalMs: 10_000,
      pingTimeoutMs: 10_000,
    });
    expect(DEFAULT_SOCKET_IO_HEARTBEAT_CONFIG).toEqual({
      pingIntervalMs: 10_000,
      pingTimeoutMs: 10_000,
    });
  });

  it('trata una variable vacia o solo con espacios como ausente', () => {
    expect(
      resolveSocketIoHeartbeatConfig({
        [SOCKET_IO_PING_INTERVAL_MS_ENV]: '',
        [SOCKET_IO_PING_TIMEOUT_MS_ENV]: '   ',
      }),
    ).toEqual({ pingIntervalMs: 10_000, pingTimeoutMs: 10_000 });
  });

  it('completa con el valor por defecto la variable que falta', () => {
    expect(
      resolveSocketIoHeartbeatConfig({
        [SOCKET_IO_PING_INTERVAL_MS_ENV]: '15000',
      }),
    ).toEqual({ pingIntervalMs: 15_000, pingTimeoutMs: 10_000 });

    expect(
      resolveSocketIoHeartbeatConfig({
        [SOCKET_IO_PING_TIMEOUT_MS_ENV]: '12000',
      }),
    ).toEqual({ pingIntervalMs: 10_000, pingTimeoutMs: 12_000 });
  });

  it('lee los dos valores personalizados (con espacios alrededor)', () => {
    expect(
      resolveSocketIoHeartbeatConfig({
        [SOCKET_IO_PING_INTERVAL_MS_ENV]: ' 25000 ',
        [SOCKET_IO_PING_TIMEOUT_MS_ENV]: '20000',
      }),
    ).toEqual({ pingIntervalMs: 25_000, pingTimeoutMs: 20_000 });
  });

  it('acepta exactamente los limites', () => {
    expect(
      resolveSocketIoHeartbeatConfig({
        [SOCKET_IO_PING_INTERVAL_MS_ENV]: String(SOCKET_IO_HEARTBEAT_MIN_MS),
        [SOCKET_IO_PING_TIMEOUT_MS_ENV]: String(SOCKET_IO_HEARTBEAT_MAX_MS),
      }),
    ).toEqual({ pingIntervalMs: 5_000, pingTimeoutMs: 60_000 });
  });

  it.each(['abc', '-1', '1.5', '10s', '1e4', '0x2710', '10 000'])(
    'rechaza un intervalo que no es un entero de ms: %s',
    (raw) => {
      expect(() =>
        resolveSocketIoHeartbeatConfig({
          [SOCKET_IO_PING_INTERVAL_MS_ENV]: raw,
        }),
      ).toThrow(SOCKET_IO_PING_INTERVAL_MS_ENV);
    },
  );

  it.each(['abc', '-1', '1.5', '10s', '1e4', '0x2710', '10 000'])(
    'rechaza un timeout que no es un entero de ms: %s',
    (raw) => {
      expect(() =>
        resolveSocketIoHeartbeatConfig({
          [SOCKET_IO_PING_TIMEOUT_MS_ENV]: raw,
        }),
      ).toThrow(SOCKET_IO_PING_TIMEOUT_MS_ENV);
    },
  );

  it.each([
    [SOCKET_IO_PING_INTERVAL_MS_ENV, '0'],
    [SOCKET_IO_PING_INTERVAL_MS_ENV, '500'],
    [SOCKET_IO_PING_INTERVAL_MS_ENV, '4999'],
    [SOCKET_IO_PING_INTERVAL_MS_ENV, '60001'],
    [SOCKET_IO_PING_TIMEOUT_MS_ENV, '0'],
    [SOCKET_IO_PING_TIMEOUT_MS_ENV, '500'],
    [SOCKET_IO_PING_TIMEOUT_MS_ENV, '4999'],
    [SOCKET_IO_PING_TIMEOUT_MS_ENV, '3600000'],
  ])('rechaza %s=%s por estar fuera de [5000, 60000]', (name, raw) => {
    expect(() => resolveSocketIoHeartbeatConfig({ [name]: raw })).toThrow(
      `${name} debe estar entre 5000 y 60000 ms (recibido: ${Number(raw)})`,
    );
  });

  it('no deja pasar por entorno los tiempos de milisegundos de las pruebas', () => {
    // Las pruebas con 500/500 construyen el adaptador directamente; por
    // variables de entorno esos valores no arrancan la aplicacion.
    expect(() =>
      resolveSocketIoHeartbeatConfig({
        [SOCKET_IO_PING_INTERVAL_MS_ENV]: '500',
        [SOCKET_IO_PING_TIMEOUT_MS_ENV]: '500',
      }),
    ).toThrow(SOCKET_IO_PING_INTERVAL_MS_ENV);
  });

  it('no altera los plazos de las sesiones remotas', () => {
    const env = {
      [SOCKET_IO_PING_INTERVAL_MS_ENV]: '5000',
      [SOCKET_IO_PING_TIMEOUT_MS_ENV]: '5000',
    };

    resolveSocketIoHeartbeatConfig(env);

    expect(resolveRemoteSessionLifecycleConfig(env)).toEqual({
      disconnectGraceMs: 60_000,
      connectingTtlMs: 120_000,
      startupRecoveryMs: 90_000,
    });
    expect(DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG).toEqual({
      disconnectGraceMs: 60_000,
      connectingTtlMs: 120_000,
      startupRecoveryMs: 90_000,
    });
  });
});

describe('SocketIoAdapter: heartbeat', () => {
  afterEach(() => jest.restoreAllMocks());

  const adapterWith = (pingIntervalMs: number, pingTimeoutMs: number) =>
    new SocketIoAdapter({} as never, ['https://soporte.example.com'], {
      pingIntervalMs,
      pingTimeoutMs,
    });

  it('pasa el heartbeat y conserva el CORS y el resto de opciones', () => {
    const created = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({});

    adapterWith(10_000, 10_000).createIOServer(0, {
      path: '/socket.io',
      transports: ['polling', 'websocket'],
    } as ServerOptions);

    expect(created).toHaveBeenCalledWith(0, {
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      cors: { origin: ['https://soporte.example.com'], credentials: true },
      pingInterval: 10_000,
      pingTimeout: 10_000,
    });
  });

  it('un decorador de gateway no puede sustituir el heartbeat del servidor', () => {
    const created = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({});

    adapterWith(12_000, 8_000).createIOServer(0, {
      pingInterval: 25_000,
      pingTimeout: 20_000,
    } as ServerOptions);

    expect(created).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ pingInterval: 12_000, pingTimeout: 8_000 }),
    );
  });

  it('funciona sin opciones (gateway sin decorador con opciones)', () => {
    const created = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({});

    adapterWith(10_000, 10_000).createIOServer(0);

    expect(created).toHaveBeenCalledWith(0, {
      cors: { origin: ['https://soporte.example.com'], credentials: true },
      pingInterval: 10_000,
      pingTimeout: 10_000,
    });
  });
});
