import { io, Socket as ClientSocket } from 'socket.io-client';
import {
  HARNESS_DEVICE_ID,
  HARNESS_PUBLIC_ID,
  RealtimeHeartbeatHarness,
  startRealtimeHeartbeatHarness,
} from '../../test/support/realtime-heartbeat-harness';
import { DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG } from './remote-session-lifecycle.config';
import { resolveSocketIoHeartbeatConfig } from './socket-io-heartbeat.config';
import {
  DEVICE_CONNECTED_EVENT,
  DEVICES_NAMESPACE,
} from '../devices/gateway/devices.gateway';
import { TECHNICIANS_NAMESPACE } from '../signaling/gateway/technicians.gateway';

/**
 * El heartbeat tal como lo ve un cliente: handshake de Engine.IO real contra un
 * servidor real, creado por el `SocketIoAdapter` de produccion con la
 * configuracion que `main.ts` resuelve sin variables de entorno.
 *
 * No se inspecciona el adaptador ni se usan dobles de Socket.IO: lo que se
 * comprueba es el paquete OPEN (`0{...}`) que recibe cualquier cliente, tambien
 * `socket_io_client` de Flutter, y la conexion de clientes reales a los dos
 * namespaces.
 */
jest.setTimeout(30_000);

const ALLOWED_ORIGIN = 'http://localhost:5173';

/** Separador de paquetes en el transporte polling de Engine.IO v4. */
const RECORD_SEPARATOR = '\x1e';

interface EngineOpenPacket {
  sid: string;
  upgrades: string[];
  pingInterval: number;
  pingTimeout: number;
  maxPayload: number;
}

describe('Heartbeat Socket.IO: handshake real de Engine.IO', () => {
  let harness: RealtimeHeartbeatHarness;
  const clients: ClientSocket[] = [];

  const pollingUrl = (sid?: string) =>
    `${harness.baseUrl}/socket.io/?EIO=4&transport=polling${sid ? `&sid=${sid}` : ''}`;

  /** Handshake crudo por polling: el primer paquete es el OPEN de Engine.IO. */
  const engineOpen = async (
    headers: Record<string, string> = {},
  ): Promise<{ packet: EngineOpenPacket; response: Response }> => {
    const response = await fetch(pollingUrl(), { headers });
    const body = await response.text();

    expect(body.startsWith('0')).toBe(true);

    return {
      packet: JSON.parse(body.slice(1)) as EngineOpenPacket,
      response,
    };
  };

  /** Envia paquetes Socket.IO por polling y lee la respuesta del servidor. */
  const pollingExchange = async (
    sid: string,
    packet: string,
  ): Promise<string[]> => {
    const sent = await fetch(pollingUrl(sid), {
      method: 'POST',
      body: packet,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });

    expect(await sent.text()).toBe('ok');

    const received = await fetch(pollingUrl(sid));

    return (await received.text()).split(RECORD_SEPARATOR);
  };

  /**
   * Cliente Socket.IO real que guarda los datos del handshake de SU conexion
   * Engine.IO (cada `forceNew` abre una distinta).
   */
  const connect = (
    namespace: string,
    token: string,
  ): Promise<{
    client: ClientSocket;
    handshake: EngineOpenPacket;
    connected: Promise<unknown>;
  }> =>
    new Promise((resolve, reject) => {
      const client = io(`${harness.baseUrl}${namespace}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        autoConnect: false,
        auth: { token },
      });

      clients.push(client);

      const connected = new Promise<unknown>((resolveEvent) =>
        client.once(DEVICE_CONNECTED_EVENT, resolveEvent),
      );

      // `connect()` crea el motor Engine.IO de forma sincrona; el handshake
      // llega despues, por red.
      client.connect();

      let handshake: EngineOpenPacket | undefined;
      client.io.engine.once('handshake', (data: EngineOpenPacket) => {
        handshake = data;
      });

      client.once('connect', () =>
        resolve({
          client,
          handshake: handshake as EngineOpenPacket,
          connected,
        }),
      );
      client.once('connect_error', reject);
    });

  const connectError = (namespace: string, token: string): Promise<Error> =>
    new Promise((resolve, reject) => {
      const client = io(`${harness.baseUrl}${namespace}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token },
      });

      clients.push(client);
      client.once('connect', () => reject(new Error('conecto sin token')));
      client.once('connect_error', resolve);
    });

  beforeAll(async () => {
    harness = await startRealtimeHeartbeatHarness({
      // Exactamente lo que `main.ts` hace sin variables definidas.
      heartbeat: resolveSocketIoHeartbeatConfig({}),
      lifecycle: { ...DEFAULT_REMOTE_SESSION_LIFECYCLE_CONFIG },
      corsOrigins: [ALLOWED_ORIGIN],
    });
  });

  afterEach(() => {
    while (clients.length > 0) clients.pop()?.close();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('el OPEN de Engine.IO anuncia pingInterval 10000 y pingTimeout 10000', async () => {
    const { packet } = await engineOpen();

    expect(packet).toMatchObject({
      pingInterval: 10_000,
      pingTimeout: 10_000,
      // Lo demas no cambia: mismos transportes y mismo limite de payload.
      upgrades: ['websocket'],
      maxPayload: 1_000_000,
    });
  });

  it('/devices y /technicians se conectan sobre la MISMA sesion Engine.IO (un solo heartbeat)', async () => {
    const { packet } = await engineOpen();

    const deviceReply = await pollingExchange(
      packet.sid,
      `40${DEVICES_NAMESPACE},${JSON.stringify({ token: harness.deviceToken() })}`,
    );

    expect(deviceReply[0]).toMatch(
      new RegExp(`^40${DEVICES_NAMESPACE},\\{"sid":`),
    );
    // El evento de bienvenida sigue siendo el mismo.
    expect(deviceReply.join(RECORD_SEPARATOR)).toContain(
      `"${DEVICE_CONNECTED_EVENT}",${JSON.stringify({
        deviceId: HARNESS_DEVICE_ID,
        publicId: HARNESS_PUBLIC_ID,
      })}`,
    );

    const technicianReply = await pollingExchange(
      packet.sid,
      `40${TECHNICIANS_NAMESPACE},${JSON.stringify({ token: harness.userToken() })}`,
    );

    expect(technicianReply[0]).toMatch(
      new RegExp(`^40${TECHNICIANS_NAMESPACE},\\{"sid":`),
    );

    // Un unico servidor Socket.IO (un unico Engine.IO) para los dos namespaces,
    // creado con los valores del heartbeat aunque cada gateway pase sus propias
    // opciones de decorador.
    expect(harness.adapter.created).toHaveLength(1);
    const [{ server }] = harness.adapter.created;
    expect(server.of(DEVICES_NAMESPACE).server).toBe(server);
    expect(server.of(TECHNICIANS_NAMESPACE).server).toBe(server);
  });

  it.each([
    ['/devices', DEVICES_NAMESPACE],
    ['/technicians', TECHNICIANS_NAMESPACE],
  ])(
    'un cliente Socket.IO real de %s recibe 10000/10000 en su handshake y conecta',
    async (_label, namespace) => {
      const token =
        namespace === DEVICES_NAMESPACE
          ? harness.deviceToken()
          : harness.userToken();

      const { client, handshake, connected } = await connect(namespace, token);

      expect(client.connected).toBe(true);
      expect(handshake).toMatchObject({
        pingInterval: 10_000,
        pingTimeout: 10_000,
      });

      if (namespace === DEVICES_NAMESPACE)
        await expect(connected).resolves.toEqual({
          deviceId: HARNESS_DEVICE_ID,
          publicId: HARNESS_PUBLIC_ID,
        });
    },
  );

  it('la autenticacion de los dos namespaces no cambia', async () => {
    const deviceError = (await connectError(
      DEVICES_NAMESPACE,
      'token-invalido',
    )) as Error & { data?: unknown };

    expect(deviceError.message).toBe('Unauthorized');
    expect(deviceError.data).toEqual({ code: 'DEVICE_AUTH_UNAUTHORIZED' });

    // Un token de tecnico no abre /devices, ni uno de tablet abre /technicians.
    await expect(
      connectError(DEVICES_NAMESPACE, harness.userToken()),
    ).resolves.toMatchObject({ message: 'Unauthorized' });

    const technicianError = await connectError(
      TECHNICIANS_NAMESPACE,
      harness.deviceToken(),
    );
    expect(technicianError.message).toBe('Unauthorized');
  });

  it('el CORS del servidor Socket.IO se conserva', async () => {
    const allowed = await engineOpen({ Origin: ALLOWED_ORIGIN });

    expect(allowed.response.headers.get('access-control-allow-origin')).toBe(
      ALLOWED_ORIGIN,
    );
    expect(
      allowed.response.headers.get('access-control-allow-credentials'),
    ).toBe('true');

    const foreign = await engineOpen({ Origin: 'https://otro.example.com' });

    expect(
      foreign.response.headers.get('access-control-allow-origin'),
    ).toBeNull();
    // El heartbeat es el mismo para cualquier origen.
    expect(foreign.packet.pingInterval).toBe(10_000);
  });
});
