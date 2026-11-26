import type { Server as IoServer } from 'socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
import {
  BOTH_DIRECTIONS,
  HalfOpenRelay,
} from '../../../test/support/half-open-relay';
import {
  HARNESS_DEVICE_ID,
  RealtimeHeartbeatHarness,
  startRealtimeHeartbeatHarness,
} from '../../../test/support/realtime-heartbeat-harness';
import { DEVICES_NAMESPACE } from '../../devices/gateway/devices.gateway';
import { DEVICE_PRESENCE_UPDATED_EVENT } from '../../devices/presence/device-presence.service';
import { TECHNICIANS_NAMESPACE } from '../../signaling/gateway/technicians.gateway';
import { REMOTE_SESSION_JOIN_EVENT } from '../../signaling/signaling.events';
import { RemoteSessionEndedBy } from '../enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from '../enums/remote-session-status.enum';
import { REMOTE_SESSION_CLOSED_EVENT } from '../remote-sessions.service';
import { SupportRequestStatus } from '../../support-requests/enums/support-request-status.enum';

/**
 * Heartbeat de Socket.IO frente a conexiones medio abiertas, de punta a punta.
 *
 * La tablet se conecta a traves de `HalfOpenRelay`, que puede dejar de entregar
 * trafico en uno o en los dos sentidos SIN emitir FIN ni RST: para TCP la
 * conexion sigue viva y solo el ping/pong de Engine.IO puede notar el corte.
 * Todo lo demas (gateways, autenticacion, presencia, participacion, ciclo de
 * vida y `SocketIoAdapter`) es lo de produccion; PostgreSQL esta en memoria.
 *
 * Los tiempos estan escalados 1:20 respecto a produccion para que la suite dure
 * segundos:
 *
 * ```text
 *                       produccion   aqui
 * pingInterval          10 s         500 ms
 * pingTimeout           10 s         500 ms
 * gracia SYSTEM         60 s         3000 ms
 * microcorte             8 s         400 ms
 * corte "de 30 s"       30 s         1500 ms
 * ```
 *
 * Los 500/500 no se pueden configurar por variables de entorno (el minimo es
 * 5000): el adaptador se construye aqui con ellos directamente.
 */
jest.setTimeout(60_000);

const PING_INTERVAL_MS = 500;
const PING_TIMEOUT_MS = 500;
const GRACE_MS = 3_000;

/** Peor caso teorico de deteccion de una conexion medio abierta. */
const WORST_DETECTION_MS = PING_INTERVAL_MS + PING_TIMEOUT_MS;

/** Holgura para la planificacion de timers del proceso de pruebas. */
const SCHEDULING_MARGIN_MS = 250;

const MICRO_CUT_MS = 400;
const RECOVERABLE_CUT_MS = 1_500;

interface Stamped<T> {
  at: number;
  value: T;
}

interface TabletProbe {
  client: ClientSocket;
  /** Cuando recibio cada PING del servidor (evento del motor Engine.IO). */
  pings: number[];
  disconnects: Array<Stamped<string>>;
  connects: number[];
  /** ACK de cada `remote-session:join` automatico tras (re)conectar. */
  joins: Array<Stamped<{ joined: boolean; error?: string }>>;
}

interface ConsoleProbe {
  client: ClientSocket;
  /** `device:presence-updated` y el estado que REST devolveria al recibirlo. */
  presence: Array<Stamped<boolean>>;
  closed: Array<Stamped<unknown>>;
}

describe('Heartbeat Socket.IO frente a conexiones medio abiertas', () => {
  let harness: RealtimeHeartbeatHarness;
  let relay: HalfOpenRelay;
  let ioServer: IoServer;

  /** Desconexiones vistas por el SERVIDOR en /devices, con su motivo. */
  let serverDeviceDisconnects: Array<Stamped<string>> = [];

  const clients: ClientSocket[] = [];

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (
    condition: () => boolean,
    description: string,
    timeoutMs = 10_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timeout: ${description}`);
      await sleep(5);
    }
  };

  const join = (client: ClientSocket, remoteSessionId: string) =>
    client
      .timeout(5_000)
      .emitWithAck(REMOTE_SESSION_JOIN_EVENT, { remoteSessionId }) as Promise<{
      joined: boolean;
      error?: string;
    }>;

  /**
   * Tablet a traves del relay. Con `rejoin`, al (re)conectar vuelve a unirse a
   * la sesion, como hace la aplicacion DEVICE.
   */
  const connectTablet = (
    options: { reconnect?: boolean; rejoin?: () => string | null } = {},
  ): Promise<TabletProbe> =>
    new Promise((resolve, reject) => {
      const client = io(`${relay.url}${DEVICES_NAMESPACE}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: options.reconnect ?? false,
        reconnectionDelay: 100,
        reconnectionDelayMax: 200,
        randomizationFactor: 0,
        auth: { token: harness.deviceToken() },
      });

      clients.push(client);

      const probe: TabletProbe = {
        client,
        pings: [],
        disconnects: [],
        connects: [],
        joins: [],
      };

      // El motor Engine.IO cambia en cada reconexion: se engancha en cada 'open'.
      client.io.on('open', () =>
        client.io.engine.on('ping', () => probe.pings.push(Date.now())),
      );

      client.on('connect', () => {
        probe.connects.push(Date.now());

        const remoteSessionId = options.rejoin?.();

        if (remoteSessionId)
          void join(client, remoteSessionId).then(
            (ack) => probe.joins.push({ at: Date.now(), value: ack }),
            () => undefined,
          );

        if (probe.connects.length === 1) resolve(probe);
      });

      client.on('disconnect', (reason) =>
        probe.disconnects.push({ at: Date.now(), value: reason }),
      );

      client.once('connect_error', (error) => {
        if (probe.connects.length === 0) reject(error);
      });
    });

  /** Pestana del tecnico, conectada directamente (su red no se corta). */
  const connectTechnician = (): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(`${harness.baseUrl}${TECHNICIANS_NAMESPACE}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: { token: harness.userToken() },
      });

      clients.push(client);
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });

  /** Consola del tecnico sin join: observa presencia y cierres. */
  const connectConsole = async (): Promise<ConsoleProbe> => {
    const client = await connectTechnician();
    const probe: ConsoleProbe = { client, presence: [], closed: [] };

    client.on(DEVICE_PRESENCE_UPDATED_EVENT, () =>
      probe.presence.push({
        at: Date.now(),
        value: harness.presence.isOnline(HARNESS_DEVICE_ID),
      }),
    );
    client.on(REMOTE_SESSION_CLOSED_EVENT, (payload: unknown) =>
      probe.closed.push({ at: Date.now(), value: payload }),
    );

    return probe;
  };

  /** Sesion ACTIVE con la tablet (por el relay) y el tecnico unidos. */
  const activeSession = async (
    tabletOptions: { reconnect?: boolean; autoRejoin?: boolean } = {},
  ) => {
    let sessionId: string | null = null;

    const monitor = await connectConsole();
    const tablet = await connectTablet({
      reconnect: tabletOptions.reconnect,
      // Solo las reconexiones: el primer join se hace abajo, con la sesion ya
      // creada.
      rejoin: tabletOptions.autoRejoin ? () => sessionId : undefined,
    });
    const technicianTab = await connectTechnician();
    const technicianClosed: unknown[] = [];
    technicianTab.on(REMOTE_SESSION_CLOSED_EVENT, (payload: unknown) =>
      technicianClosed.push(payload),
    );

    const id = await harness.createSession();

    await expect(join(tablet.client, id)).resolves.toMatchObject({
      joined: true,
    });
    await expect(join(technicianTab, id)).resolves.toMatchObject({
      joined: true,
    });
    await harness.remoteSessionsService.activateByTechnician(
      id,
      harness.technician,
    );

    sessionId = id;

    // Lo anterior a la sesion (ONLINE inicial) no interesa a las pruebas.
    monitor.presence.length = 0;

    return { id, tablet, technicianTab, technicianClosed, monitor };
  };

  /** Espera un PING recien llegado a la tablet y luego `offsetMs`. */
  const atPhase = async (
    tablet: TabletProbe,
    offsetMs: number,
  ): Promise<number> => {
    const seen = tablet.pings.length;
    await waitFor(() => tablet.pings.length > seen, 'PING del servidor');
    const pingAt = tablet.pings[tablet.pings.length - 1];
    await sleep(Math.max(0, pingAt + offsetMs - Date.now()));
    return pingAt;
  };

  const lastServerDisconnect = (): Stamped<string> =>
    serverDeviceDisconnects[serverDeviceDisconnects.length - 1];

  beforeAll(async () => {
    harness = await startRealtimeHeartbeatHarness({
      heartbeat: {
        pingIntervalMs: PING_INTERVAL_MS,
        pingTimeoutMs: PING_TIMEOUT_MS,
      },
      lifecycle: {
        disconnectGraceMs: GRACE_MS,
        connectingTtlMs: 60_000,
        startupRecoveryMs: 0,
      },
    });

    relay = await HalfOpenRelay.start(harness.port);

    [{ server: ioServer }] = harness.adapter.created;

    ioServer
      .of(DEVICES_NAMESPACE)
      .on('connection', (socket) =>
        socket.on('disconnect', (reason) =>
          serverDeviceDisconnects.push({ at: Date.now(), value: reason }),
        ),
      );
  });

  beforeEach(() => {
    harness.reset();
    serverDeviceDisconnects = [];
  });

  afterEach(async () => {
    relay.restore();

    while (clients.length > 0) clients.pop()?.close();

    // Que ninguna sesion siga programada para la prueba siguiente.
    for (const row of harness.remoteSessions)
      row.status = RemoteSessionStatus.CLOSED;

    await waitFor(
      () => !harness.presence.isOnline(HARNESS_DEVICE_ID),
      'tablet OFFLINE tras la prueba',
    );
    await sleep(100);
  });

  afterAll(async () => {
    await relay.close();
    await harness.close();
  });

  it('el servidor envia un PING cada pingInterval (500 ms) a /devices', async () => {
    const tablet = await connectTablet();

    await sleep(4 * PING_INTERVAL_MS + 200);

    expect(tablet.pings.length).toBeGreaterThanOrEqual(3);

    const gaps = tablet.pings
      .slice(1)
      .map((at, index) => at - tablet.pings[index]);

    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(PING_INTERVAL_MS - 50);
      expect(gap).toBeLessThanOrEqual(PING_INTERVAL_MS + 150);
    }
  });

  describe('A. cierre limpio', () => {
    it('una conexion cerrada (FIN/RST) se detecta enseguida, sin esperar el timeout', async () => {
      const { id, monitor } = await activeSession();

      const cutAt = Date.now();
      relay.resetAll();

      await waitFor(() => serverDeviceDisconnects.length === 1, 'disconnect');
      const detectedIn = lastServerDisconnect().at - cutAt;

      expect(lastServerDisconnect().value).toBe('transport close');
      expect(detectedIn).toBeLessThan(PING_TIMEOUT_MS / 2);

      await waitFor(() => monitor.presence.length === 1, 'presencia');
      expect(monitor.presence[0].value).toBe(false);

      // La gracia empieza ahora; la sesion sigue viva mientras dura.
      expect(harness.sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);
    });

    it('un disconnect explicito de la tablet tambien es inmediato', async () => {
      const { monitor, tablet } = await activeSession();

      const cutAt = Date.now();
      tablet.client.disconnect();

      await waitFor(() => serverDeviceDisconnects.length === 1, 'disconnect');

      expect(lastServerDisconnect().value).toBe('client namespace disconnect');
      expect(lastServerDisconnect().at - cutAt).toBeLessThan(
        PING_TIMEOUT_MS / 2,
      );
      await waitFor(() => monitor.presence.length === 1, 'presencia');
    });
  });

  describe('B. medio abierto en los dos sentidos', () => {
    it.each([
      ['justo despues de un PING', 50],
      ['a mitad del intervalo', 250],
      ['justo antes del siguiente PING', 450],
    ])(
      'corte %s: el servidor detecta en (pingInterval - fase) + pingTimeout y empieza la gracia',
      async (_phase, offset) => {
        const { id, tablet, monitor } = await activeSession();

        const pingAt = await atPhase(tablet, offset);
        const cutAt = Date.now();
        relay.cut(BOTH_DIRECTIONS);

        await waitFor(
          () => serverDeviceDisconnects.length === 1,
          'deteccion del servidor',
        );

        const detected = lastServerDisconnect();
        const detectedIn = detected.at - cutAt;
        // El siguiente PING sale pingInterval despues del anterior PONG y se da
        // por perdido pingTimeout despues.
        const expected = pingAt + WORST_DETECTION_MS - cutAt;

        expect(detected.value).toBe('ping timeout');
        expect(detectedIn).toBeGreaterThanOrEqual(expected - 100);
        expect(detectedIn).toBeLessThanOrEqual(expected + SCHEDULING_MARGIN_MS);
        expect(detectedIn).toBeLessThanOrEqual(
          WORST_DETECTION_MS + SCHEDULING_MARGIN_MS,
        );

        // La consola (cuya red no se corto) recibe OFFLINE al detectarse.
        await waitFor(() => monitor.presence.length === 1, 'presencia');
        expect(monitor.presence[0].value).toBe(false);
        expect(monitor.presence[0].at - detected.at).toBeLessThan(100);

        // El cliente tambien se da por desconectado por su cuenta, al no
        // recibir un PING en pingInterval + pingTimeout.
        await waitFor(() => tablet.disconnects.length === 1, 'cliente');
        expect(tablet.disconnects[0].value).toBe('ping timeout');
        expect(tablet.disconnects[0].at - pingAt).toBeGreaterThanOrEqual(
          WORST_DETECTION_MS - 50,
        );
        expect(tablet.disconnects[0].at - pingAt).toBeLessThanOrEqual(
          WORST_DETECTION_MS + SCHEDULING_MARGIN_MS,
        );

        // Detectar no cierra: empieza la gracia (su vencimiento lo mide F).
        expect(harness.sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);
      },
    );
  });

  describe('C. perdida en un solo sentido', () => {
    it('la tablet puede enviar pero no recibir: ninguno de los dos ve PING y los dos cierran por timeout', async () => {
      const { tablet, monitor } = await activeSession();

      await atPhase(tablet, 100);
      const cutAt = Date.now();
      relay.cut(['toClient']);

      await waitFor(() => serverDeviceDisconnects.length === 1, 'servidor');

      expect(lastServerDisconnect().value).toBe('ping timeout');
      expect(lastServerDisconnect().at - cutAt).toBeLessThanOrEqual(
        WORST_DETECTION_MS + SCHEDULING_MARGIN_MS,
      );
      await waitFor(() => monitor.presence.length === 1, 'presencia');

      await waitFor(() => tablet.disconnects.length === 1, 'cliente');
      expect(tablet.disconnects[0].value).toBe('ping timeout');
    });

    it('la tablet puede recibir pero no enviar: el servidor cierra por timeout; la tablet, por su propio timer', async () => {
      const { tablet, monitor } = await activeSession();

      await atPhase(tablet, 100);
      const cutAt = Date.now();
      relay.cut(['toServer']);

      await waitFor(() => serverDeviceDisconnects.length === 1, 'servidor');

      const detected = lastServerDisconnect();
      expect(detected.value).toBe('ping timeout');
      expect(detected.at - cutAt).toBeLessThanOrEqual(
        WORST_DETECTION_MS + SCHEDULING_MARGIN_MS,
      );
      await waitFor(() => monitor.presence.length === 1, 'presencia');

      // Los PING siguen llegando hasta que el servidor cierra, y el frame de
      // cierre WebSocket del servidor tambien llega. Pero el cierre no termina:
      // la respuesta de la tablet y el cierre TCP se pierden, y `ws` solo avisa
      // del cierre cuando el TCP acaba. La tablet se da por desconectada con su
      // propio timer: pingInterval + pingTimeout despues del ultimo PING.
      await waitFor(() => tablet.disconnects.length === 1, 'cliente');
      const lastPingAt = tablet.pings[tablet.pings.length - 1];

      expect(lastPingAt).toBeLessThan(detected.at);
      expect(tablet.disconnects[0].value).toBe('ping timeout');
      expect(tablet.disconnects[0].at - lastPingAt).toBeLessThanOrEqual(
        WORST_DETECTION_MS + SCHEDULING_MARGIN_MS,
      );
    });
  });

  describe('D. microcorte (8 s en produccion, por debajo de pingTimeout)', () => {
    it.each([
      ['justo despues de un PING', 50],
      ['a mitad del intervalo', 250],
      ['justo antes del siguiente PING', 450],
    ])(
      'microcorte de 400 ms %s: nadie se desconecta, la presencia no cambia y la sesion sigue',
      async (_phase, offset) => {
        const { id, tablet, technicianTab, monitor } = await activeSession();

        await atPhase(tablet, offset);
        relay.cut(BOTH_DIRECTIONS);
        await sleep(MICRO_CUT_MS);
        relay.restore();

        // Dos ciclos completos de heartbeat despues del corte.
        await sleep(2 * WORST_DETECTION_MS);

        expect(serverDeviceDisconnects).toEqual([]);
        expect(tablet.disconnects).toEqual([]);
        expect(monitor.presence).toEqual([]);
        expect(harness.sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);

        // El signaling sigue funcionando por el mismo socket.
        await expect(join(tablet.client, id)).resolves.toMatchObject({
          joined: true,
          peerJoined: true,
        });
        expect(technicianTab.connected).toBe(true);
      },
    );
  });

  describe('E. corte recuperable (30 s en produccion, menor que deteccion + gracia)', () => {
    it('se detecta, la tablet reconecta y se vuelve a unir: misma sesion ACTIVE, sin cierre SYSTEM', async () => {
      const { id, tablet, technicianClosed, monitor } = await activeSession({
        reconnect: true,
        autoRejoin: true,
      });

      await atPhase(tablet, 100);
      relay.cut(BOTH_DIRECTIONS);
      await sleep(RECOVERABLE_CUT_MS);

      // Durante el corte: detectado por el servidor, OFFLINE, gracia en curso.
      expect(serverDeviceDisconnects.map((d) => d.value)).toEqual([
        'ping timeout',
      ]);
      expect(monitor.presence.map((p) => p.value)).toEqual([false]);
      expect(tablet.disconnects.map((d) => d.value)).toEqual(['ping timeout']);

      const detectedAt = serverDeviceDisconnects[0].at;
      relay.restore();

      // Vuelve la red: reconexion, ONLINE y join automatico aceptado.
      await waitFor(() => tablet.joins.length === 1, 'rejoin');
      expect(tablet.joins[0].value).toMatchObject({ joined: true });
      expect(tablet.connects).toHaveLength(2);
      expect(monitor.presence.map((p) => p.value)).toEqual([false, true]);
      expect(harness.presence.connectionCount(HARNESS_DEVICE_ID)).toBe(1);

      // Pasado de sobra el vencimiento que habria tenido la gracia.
      await sleep(Math.max(0, detectedAt + GRACE_MS + 500 - Date.now()));

      expect(harness.sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);
      expect(harness.sessionRow(id).endedAt ?? null).toBeNull();
      expect(monitor.closed).toEqual([]);
      expect(technicianClosed).toEqual([]);
      expect(serverDeviceDisconnects).toHaveLength(1);
    });
  });

  describe('F. corte prolongado', () => {
    it('cierre SYSTEM al vencer la gracia contada desde la deteccion; una reconexion tardia no la reactiva', async () => {
      const { id, tablet, technicianClosed, monitor } = await activeSession({
        reconnect: true,
        autoRejoin: true,
      });
      const { supportRequestId } = harness.sessionRow(id);

      await atPhase(tablet, 100);
      relay.cut(BOTH_DIRECTIONS);

      await waitFor(() => serverDeviceDisconnects.length === 1, 'deteccion');
      const detectedAt = lastServerDisconnect().at;

      await waitFor(
        () => harness.sessionRow(id).status === RemoteSessionStatus.CLOSED,
        'cierre SYSTEM',
      );
      const closedAfter = Date.now() - detectedAt;

      expect(closedAfter).toBeGreaterThanOrEqual(GRACE_MS - 50);
      expect(closedAfter).toBeLessThanOrEqual(GRACE_MS + SCHEDULING_MARGIN_MS);

      const closed = harness.sessionRow(id);
      expect(closed.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
      expect(closed.endedAt).toBeInstanceOf(Date);
      expect(harness.requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );

      // Un unico aviso a cada tecnico (la tablet no lo puede recibir: sin red).
      await waitFor(() => monitor.closed.length === 1, 'aviso consola');
      await waitFor(() => technicianClosed.length === 1, 'aviso tecnico');

      // Reintento del cierre: no hay segunda transicion.
      const endedAt = closed.endedAt;
      await expect(
        harness.remoteSessionsService.closeBySystem(id, () => true),
      ).resolves.toBeNull();

      // Vuelve la red: la tablet reconecta (presencia ONLINE), pero su join a
      // la sesion vieja se rechaza y la sesion sigue CLOSED.
      relay.restore();

      await waitFor(() => tablet.joins.length === 1, 'join tardio');
      expect(tablet.joins[0].value).toEqual({
        joined: false,
        error: 'UNAUTHORIZED',
      });
      expect(monitor.presence.map((p) => p.value)).toEqual([false, true]);

      await sleep(500);
      expect(harness.sessionRow(id)).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
        endedAt,
      });
      expect(monitor.closed).toHaveLength(1);
      expect(technicianClosed).toHaveLength(1);
    });
  });

  describe('G. cortes repetidos', () => {
    it('tres cortes recuperables seguidos: una reconexion por corte, presencia alternada, sin eventos obsoletos', async () => {
      const { id, tablet, technicianClosed, monitor } = await activeSession({
        reconnect: true,
        autoRejoin: true,
      });

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        relay.cut(BOTH_DIRECTIONS);
        await waitFor(
          () => serverDeviceDisconnects.length === cycle,
          `deteccion ${cycle}`,
        );
        await sleep(200);
        relay.restore();
        await waitFor(() => tablet.joins.length === cycle, `rejoin ${cycle}`);
        expect(tablet.joins[cycle - 1].value).toMatchObject({ joined: true });
      }

      // Lo retenido de las conexiones viejas (cierres incluidos) ya se entrego;
      // nada de eso puede volver a poner la tablet OFFLINE.
      await sleep(2 * WORST_DETECTION_MS);

      expect(serverDeviceDisconnects.map((d) => d.value)).toEqual([
        'ping timeout',
        'ping timeout',
        'ping timeout',
      ]);
      expect(tablet.connects).toHaveLength(4);
      expect(monitor.presence.map((p) => p.value)).toEqual([
        false,
        true,
        false,
        true,
        false,
        true,
      ]);
      expect(harness.presence.isOnline(HARNESS_DEVICE_ID)).toBe(true);
      expect(harness.presence.connectionCount(HARNESS_DEVICE_ID)).toBe(1);
      expect(harness.sessionRow(id).status).toBe(RemoteSessionStatus.ACTIVE);
      expect(monitor.closed).toEqual([]);
      expect(technicianClosed).toEqual([]);
    });
  });
});
