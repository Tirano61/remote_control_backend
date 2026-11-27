import { config as loadEnv } from 'dotenv';
import * as request from 'supertest';
import { User } from '../src/auth/entities/user.entity';
import { ValidRoles } from '../src/auth/interfaces/valid-roles';
import { DeviceCredential } from '../src/devices/entities/device-credential.entity';
import { deviceRoom } from '../src/devices/realtime/device-realtime.service';
import { RemoteSession } from '../src/remote-sessions/entities/remote-session.entity';
import { RemoteSessionEndedBy } from '../src/remote-sessions/enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from '../src/remote-sessions/enums/remote-session-status.enum';
import {
  REMOTE_SESSION_CLOSED_EVENT,
  RemoteSessionsService,
} from '../src/remote-sessions/remote-sessions.service';
import {
  REMOTE_SESSION_JOIN_EVENT,
  WEBRTC_ANSWER_EVENT,
  WEBRTC_ICE_CANDIDATE_EVENT,
  WEBRTC_OFFER_EVENT,
} from '../src/signaling/signaling.events';
import { SupportRequestStatus } from '../src/support-requests/enums/support-request-status.enum';
import {
  deferred,
  EnrolledDevice,
  RevocationApp,
  settle,
  startRevocationApp,
  Technician,
  TestSocket,
  waitFor,
} from './support/revocation-app';

/**
 * Revocacion de dispositivos y tecnicos frente a operaciones en vuelo.
 *
 * Todo con los modulos de produccion, PostgreSQL real (esquema temporal) y
 * clientes Socket.IO reales. Las carreras se reproducen de forma DETERMINISTA:
 * se retiene una lectura concreta (o la entrada en una room, o una fila con un
 * lock de PostgreSQL) hasta que la revocacion confirmo, y solo entonces se deja
 * continuar. No dependen de que una rafaga "acierte" la ventana; las rafagas
 * del final son una comprobacion adicional, no la prueba.
 *
 * NO forma parte de `npm test`: `npm run test:db` con un PostgreSQL local.
 */

loadEnv();

const SDP_OFFER = 'v=0 offer-de-prueba';
const SDP_ANSWER = 'v=0 answer-de-prueba';
const ICE = {
  candidate: 'candidate:1 1 UDP 2122252543 192.168.1.10 54400 typ host',
  sdpMid: '0',
  sdpMLineIndex: 0,
};

const DEVICE_AUTH_UNAUTHORIZED = 'DEVICE_AUTH_UNAUTHORIZED';

/** `true` solo si el ACK concede algo (`joined` o `delivered`). */
const granted = (ack: unknown, key: 'joined' | 'delivered'): boolean =>
  typeof ack === 'object' &&
  ack !== null &&
  (ack as Record<string, unknown>)[key] === true;

interface Hold {
  reached: Promise<void>;
  release(): void;
}

describe('revocacion frente a operaciones en vuelo (PostgreSQL + Socket.IO)', () => {
  let rc: RevocationApp;
  const restorers: Array<() => void | Promise<void>> = [];

  beforeAll(async () => {
    rc = await startRevocationApp();
  });

  afterEach(async () => {
    for (const restore of restorers.splice(0).reverse()) await restore();
    rc.closeClients();
    await settle(100);
  });

  afterAll(async () => {
    await rc?.close();
  });

  // ---------------------------------------------------------------------------
  // Retenciones deterministas
  // ---------------------------------------------------------------------------

  /**
   * Retiene la PROXIMA llamada a `method` del repositorio de `entity` que
   * cumpla `matches`.
   *
   * `after: true` deja que la consulta responda y retiene su RESULTADO (la
   * lectura ya vio el estado anterior a lo que pase durante la pausa);
   * `after: false` la retiene ANTES de enviarla (vera lo que se confirme
   * durante la pausa).
   */
  const holdRepository = <T extends object>(
    entity: new () => T,
    method: 'findOne' | 'findOneBy',
    matches: (options: unknown) => boolean,
    after: boolean,
  ): Hold => {
    const repository = rc.dataSource.getRepository(entity) as unknown as Record<
      string,
      (options: unknown) => Promise<unknown>
    >;
    // Se captura ANTES de espiar: despues, `repository[method]` es el espia.
    const real = repository[method];
    const original = (options: unknown): Promise<unknown> =>
      real.call(repository, options) as Promise<unknown>;
    const reached = deferred();
    const gate = deferred();
    let armed = true;

    const spy = jest
      .spyOn(repository, method)
      .mockImplementation(async (options: unknown) => {
        if (!armed || !matches(options)) return original(options);

        armed = false;

        if (!after) {
          reached.resolve();
          await gate.promise;
          return original(options);
        }

        const result = await original(options);
        reached.resolve();
        await gate.promise;
        return result;
      });

    restorers.push(() => spy.mockRestore());

    return { reached: reached.promise, release: () => gate.resolve() };
  };

  /**
   * La lectura de la credencial vigente del dispositivo, ya respondida.
   *
   * Es exactamente la ventana de C1: la validacion del handshake ya leyo el
   * dispositivo activo y su credencial vigente, y todavia no registro el
   * socket.
   */
  const holdCredentialLookup = (deviceId: string): Hold =>
    holdRepository(
      DeviceCredential,
      'findOne',
      (options) =>
        (options as { where?: { deviceId?: string } }).where?.deviceId ===
        deviceId,
      true,
    );

  /**
   * La lectura de la sesion que hace el signaling (join o relay), ya
   * respondida: vio la sesion viva.
   */
  const holdSignalingSessionRead = (remoteSessionId: string): Hold =>
    holdRepository(
      RemoteSession,
      'findOne',
      (options) => {
        const { where, select } = options as {
          where?: { id?: string };
          select?: Record<string, boolean>;
        };

        // La del signaling pide exactamente id/deviceId/technicianId/status.
        return (
          where?.id === remoteSessionId &&
          select?.status === true &&
          select?.createdAt === undefined
        );
      },
      true,
    );

  /** La lectura del usuario (revalidacion del tecnico), antes de enviarla. */
  const holdUserRead = (userId: string): Hold =>
    holdRepository(
      User,
      'findOneBy',
      (options) => (options as { id?: string }).id === userId,
      false,
    );

  /**
   * Retiene la entrada del PROXIMO socket del dispositivo en su room privada,
   * que es lo que `DevicesGateway.handleConnection` espera antes de registrar
   * la presencia. El handshake ya termino y el cliente ya recibio el CONNECT.
   */
  const holdDeviceRoomJoin = (deviceId: string): Hold => {
    const adapter = rc.io.of('/devices').adapter;
    type AddAll = typeof adapter.addAll;
    const original: AddAll = (id, rooms) =>
      (adapter.constructor.prototype as { addAll: AddAll }).addAll.call(
        adapter,
        id,
        rooms,
      ) as ReturnType<AddAll>;
    const reached = deferred();
    const gate = deferred();
    let armed = true;

    adapter.addAll = (id, rooms) => {
      if (armed && rooms.has(deviceRoom(deviceId))) {
        armed = false;
        reached.resolve();
        return gate.promise.then(() => original(id, rooms));
      }

      return original(id, rooms);
    };

    restorers.push(() => {
      // Vuelve a la del prototipo.
      delete (adapter as { addAll?: AddAll }).addAll;
    });

    return { reached: reached.promise, release: () => gate.resolve() };
  };

  /**
   * Bloquea filas con una transaccion propia (lock de PostgreSQL de verdad).
   * Quien intente tomarlas espera hasta `release()`.
   */
  const lockRows = async (sql: string, params: unknown[]) => {
    const runner = rc.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(sql, params);

    const release = async () => {
      if (!runner.isReleased) {
        if (runner.isTransactionActive) await runner.commitTransaction();
        await runner.release();
      }
    };

    restorers.push(release);

    return { release };
  };

  const waitForLockWaiters = (count: number) =>
    waitFor(
      async () => (await rc.lockWaiters()) >= count,
      `${count} transaccion(es) esperando un lock`,
    );

  // ---------------------------------------------------------------------------
  // Escenarios
  // ---------------------------------------------------------------------------

  interface OnlineTablet {
    admin: Technician;
    technician: Technician;
    tablet: EnrolledDevice;
    tabletSocket: TestSocket;
    supportRequestId: string;
  }

  /** Tablet ONLINE con una solicitud ACCEPTED del tecnico, sin sesion. */
  const onlineTablet = async (): Promise<OnlineTablet> => {
    const admin = await rc.seedTechnician([ValidRoles.admin]);
    const technician = await rc.seedTechnician();
    const tablet = await rc.enrollDevice();

    const tabletSocket = await connectedDevice(tablet.token);

    const supportRequest = await rc.seedAcceptedRequest(
      tablet.device.id,
      technician.user.id,
    );

    return {
      admin,
      technician,
      tablet,
      tabletSocket,
      supportRequestId: supportRequest.id,
    };
  };

  interface LiveSession extends OnlineTablet {
    sessionId: string;
    console: TestSocket;
  }

  /**
   * Tablet ONLINE, sesion CONNECTING creada por `POST /remote-sessions` y la
   * consola del tecnico unida al signaling. Con `tabletJoined`, la tablet
   * tambien.
   */
  const liveSession = async ({
    tabletJoined = false,
  } = {}): Promise<LiveSession> => {
    const base = await onlineTablet();
    const sessionId = await rc.createSession(
      base.technician,
      base.supportRequestId,
    );

    const console = await connectedTechnician(base.technician.token);
    expect(granted(await join(console, sessionId), 'joined')).toBe(true);

    if (tabletJoined)
      expect(granted(await join(base.tabletSocket, sessionId), 'joined')).toBe(
        true,
      );

    return { ...base, sessionId, console };
  };

  const connectedDevice = async (token: string): Promise<TestSocket> => {
    const socket = rc.connectDevice(token);
    expect(await socket.outcome).toEqual({ connected: true });
    await waitFor(
      () => socket.received('device:connected').length > 0,
      'device:connected',
    );
    return socket;
  };

  const connectedTechnician = async (token: string): Promise<TestSocket> => {
    const socket = rc.connectTechnician(token);
    expect(await socket.outcome).toEqual({ connected: true });
    // El servidor termina de meterlo en sus rooms tras el CONNECT.
    await settle(50);
    return socket;
  };

  const join = (socket: TestSocket, remoteSessionId: string) =>
    socket.emitWithAck(REMOTE_SESSION_JOIN_EVENT, { remoteSessionId });

  const offer = (socket: TestSocket, remoteSessionId: string) =>
    socket.emitWithAck(WEBRTC_OFFER_EVENT, { remoteSessionId, sdp: SDP_OFFER });

  const answer = (socket: TestSocket, remoteSessionId: string) =>
    socket.emitWithAck(WEBRTC_ANSWER_EVENT, {
      remoteSessionId,
      sdp: SDP_ANSWER,
    });

  const ice = (socket: TestSocket, remoteSessionId: string) =>
    socket.emitWithAck(WEBRTC_ICE_CANDIDATE_EVENT, { remoteSessionId, ...ICE });

  const patchDevice = (admin: Technician, deviceId: string, body: object) =>
    request(rc.http)
      .patch(`/devices/${deviceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send(body);

  const deactivateDevice = (admin: Technician, deviceId: string) =>
    patchDevice(admin, deviceId, { isActive: false }).expect(200);

  /** Desactivacion por fuera del backend: no existe ninguna operacion propia. */
  const deactivateUserBySql = (userId: string) =>
    rc.dataSource.query(
      `UPDATE "${rc.schema}"."users" SET "isActive" = false WHERE id = $1`,
      [userId],
    );

  const isOnline = async (admin: Technician, deviceId: string) => {
    const response = await request(rc.http)
      .get(`/devices/${deviceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    return (response.body as { isOnline: boolean }).isOnline;
  };

  const expectClosedBySystem = async (
    sessionId: string,
    supportRequestId: string,
  ) => {
    const session = await rc.sessionRow(sessionId);
    expect(session.status).toBe(RemoteSessionStatus.CLOSED);
    expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    expect(session.endedAt).toBeInstanceOf(Date);

    const supportRequest = await rc.requestRow(supportRequestId);
    expect(supportRequest.status).toBe(SupportRequestStatus.COMPLETED);
    expect(supportRequest.closedAt?.getTime()).toBe(session.endedAt?.getTime());
  };

  /**
   * La propiedad de seguridad despues de una revocacion confirmada del
   * dispositivo: el socket tardio no tiene acceso a nada, la tablet esta
   * OFFLINE y la sesion afectada termino con SYSTEM.
   */
  const expectNoAccessAfterRevocation = async (
    scenario: LiveSession,
    late: TestSocket,
  ): Promise<void> => {
    const { sessionId, console } = scenario;

    const joinAck = await join(late, sessionId);
    const offerAck = await offer(console, sessionId);
    const answerAck = await answer(late, sessionId);
    const iceAck = await ice(late, sessionId);

    await settle();

    expect(granted(joinAck, 'joined')).toBe(false);
    expect(granted(offerAck, 'delivered')).toBe(false);
    expect(late.received(WEBRTC_OFFER_EVENT)).toEqual([]);
    expect(granted(answerAck, 'delivered')).toBe(false);
    expect(granted(iceAck, 'delivered')).toBe(false);
    expect(console.received(WEBRTC_ANSWER_EVENT)).toEqual([]);
    expect(console.received(WEBRTC_ICE_CANDIDATE_EVENT)).toEqual([]);

    expect(late.client.connected).toBe(false);
    expect(await isOnline(scenario.admin, scenario.tablet.device.id)).toBe(
      false,
    );

    await expectClosedBySystem(sessionId, scenario.supportRequestId);
  };

  // ---------------------------------------------------------------------------
  // C1
  // ---------------------------------------------------------------------------

  describe('C1: handshake validado antes de una desactivacion confirmada', () => {
    it('pausa tras leer la credencial: el handshake se rechaza y no concede join ni signaling', async () => {
      const scenario = await liveSession();
      const hold = holdCredentialLookup(scenario.tablet.device.id);

      // 1-2. Empieza el handshake y la validacion lee dispositivo y credencial.
      const late = rc.connectDevice(scenario.tablet.token);
      // 3. Pausa antes del registro.
      await hold.reached;

      // 4-5. Desactivacion confirmada (200).
      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      // 6. Continua el handshake: lo leido es anterior a la revocacion.
      hold.release();
      expect(await late.outcome).toEqual({
        connected: false,
        code: DEVICE_AUTH_UNAUTHORIZED,
        message: 'Unauthorized',
      });

      // 7-8. Join y signaling.
      await expectNoAccessAfterRevocation(scenario, late);
    });

    it('pausa en la room del dispositivo: el socket ya conectado se cierra sin registrarse', async () => {
      const scenario = await liveSession();
      const hold = holdDeviceRoomJoin(scenario.tablet.device.id);

      const late = rc.connectDevice(scenario.tablet.token);
      await hold.reached;
      expect(await late.outcome).toEqual({ connected: true });

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      hold.release();
      expect(await late.disconnected).toBe('io server disconnect');
      expect(late.received('device:connected')).toEqual([]);

      await expectNoAccessAfterRevocation(scenario, late);
    });

    it('socket pendiente de registro: su join durante la pausa no entra en la sesion', async () => {
      const scenario = await liveSession();
      const hold = holdDeviceRoomJoin(scenario.tablet.device.id);

      const late = rc.connectDevice(scenario.tablet.token);
      await hold.reached;
      expect(await late.outcome).toEqual({ connected: true });

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      // El cliente ya recibio el CONNECT: intenta entrar mientras el servidor
      // todavia no termino de registrarlo.
      expect(granted(await join(late, scenario.sessionId), 'joined')).toBe(
        false,
      );

      hold.release();
      await late.disconnected;

      await expectNoAccessAfterRevocation(scenario, late);
    });

    it('rafaga: 25 handshakes reales simultaneos con la desactivacion en medio', async () => {
      const scenario = await liveSession();

      const burst = Array.from({ length: 25 }, () =>
        rc.connectDevice(scenario.tablet.token),
      );
      const deactivation = deactivateDevice(
        scenario.admin,
        scenario.tablet.device.id,
      );
      const more = Array.from({ length: 25 }, () =>
        rc.connectDevice(scenario.tablet.token),
      );

      await deactivation;
      await Promise.all([...burst, ...more].map((socket) => socket.outcome));
      await settle(300);

      // Despues de la confirmacion no queda ningun socket conectado, aunque
      // algunos hubieran llegado a conectar antes de ella.
      for (const socket of [...burst, ...more])
        expect(socket.client.connected).toBe(false);

      for (const socket of [...burst, ...more])
        expect(granted(await join(socket, scenario.sessionId), 'joined')).toBe(
          false,
        );

      expect(await isOnline(scenario.admin, scenario.tablet.device.id)).toBe(
        false,
      );
      await expectClosedBySystem(scenario.sessionId, scenario.supportRequestId);

      // Y un handshake posterior se rechaza (3, 11).
      expect(await rc.connectDevice(scenario.tablet.token).outcome).toEqual({
        connected: false,
        code: DEVICE_AUTH_UNAUTHORIZED,
        message: 'Unauthorized',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Desactivacion del dispositivo (A1)
  // ---------------------------------------------------------------------------

  describe('desactivacion del dispositivo', () => {
    it('sesion ACTIVE: CLOSED SYSTEM, solicitud COMPLETED, avisos a los dos extremos y todos los sockets fuera', async () => {
      const scenario = await liveSession({ tabletJoined: true });

      // ACTIVE por el flujo real.
      await request(rc.http)
        .post(`/remote-sessions/${scenario.sessionId}/activate`)
        .set('Authorization', `Bearer ${scenario.technician.token}`)
        .expect(200);

      // Segundo socket de la misma tablet, sin join (10).
      const second = await connectedDevice(scenario.tablet.token);

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      // Los dos sockets se cierran, el que estaba en la sala tambien (8).
      expect(await scenario.tabletSocket.disconnected).toBe(
        'io server disconnect',
      );
      expect(await second.disconnected).toBe('io server disconnect');

      await expectClosedBySystem(scenario.sessionId, scenario.supportRequestId);

      // El aviso llega a los dos extremos (a la tablet, antes del cierre).
      await waitFor(
        () => scenario.console.received(REMOTE_SESSION_CLOSED_EVENT).length > 0,
        'remote-session:closed al tecnico',
      );
      expect(scenario.console.received(REMOTE_SESSION_CLOSED_EVENT)).toEqual([
        {
          remoteSessionId: scenario.sessionId,
          endedBy: RemoteSessionEndedBy.SYSTEM,
        },
      ]);
      expect(
        scenario.tabletSocket.received(REMOTE_SESSION_CLOSED_EVENT),
      ).toEqual([
        {
          remoteSessionId: scenario.sessionId,
          endedBy: RemoteSessionEndedBy.SYSTEM,
        },
      ]);

      // Presencia (26) y signaling posterior (27).
      expect(await isOnline(scenario.admin, scenario.tablet.device.id)).toBe(
        false,
      );
      expect(
        granted(await offer(scenario.console, scenario.sessionId), 'delivered'),
      ).toBe(false);

      // REST con el mismo Device JWT: 401.
      await request(rc.http)
        .get('/device/remote-sessions/current')
        .set('Authorization', `Bearer ${scenario.tablet.token}`)
        .expect(401);
    });

    it('sesion CONNECTING: tambien se cierra con SYSTEM (18)', async () => {
      const scenario = await liveSession();

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      await expectClosedBySystem(scenario.sessionId, scenario.supportRequestId);
    });

    it('no toca las sesiones CLOSED historicas del dispositivo (20)', async () => {
      const scenario = await liveSession();

      await request(rc.http)
        .post(`/remote-sessions/${scenario.sessionId}/close`)
        .set('Authorization', `Bearer ${scenario.technician.token}`)
        .expect(200);

      const before = await rc.sessionRow(scenario.sessionId);
      const requestBefore = await rc.requestRow(scenario.supportRequestId);

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      expect(await rc.sessionRow(scenario.sessionId)).toEqual(before);
      expect(await rc.requestRow(scenario.supportRequestId)).toEqual(
        requestBefore,
      );
      expect(before.endedBy).toBe(RemoteSessionEndedBy.TECHNICIAN);
    });

    it('idempotente: una segunda desactivacion no escribe ni avisa nada (25)', async () => {
      const scenario = await liveSession();

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);
      const closed = await rc.sessionRow(scenario.sessionId);

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);
      await settle();

      expect(await rc.sessionRow(scenario.sessionId)).toEqual(closed);
      expect(
        scenario.console.received(REMOTE_SESSION_CLOSED_EVENT),
      ).toHaveLength(1);
    });

    it('no afecta a otro dispositivo ni a su sesion (28)', async () => {
      const affected = await liveSession({ tabletJoined: true });
      const other = await liveSession({ tabletJoined: true });

      await deactivateDevice(affected.admin, affected.tablet.device.id);
      await settle();

      expect(other.tabletSocket.client.connected).toBe(true);
      expect((await rc.sessionRow(other.sessionId)).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect(
        granted(await offer(other.console, other.sessionId), 'delivered'),
      ).toBe(true);
      await waitFor(
        () => other.tabletSocket.received(WEBRTC_OFFER_EVENT).length === 1,
        'offer en la otra tablet',
      );
      expect(other.console.received(REMOTE_SESSION_CLOSED_EVENT)).toEqual([]);
      expect(other.tabletSocket.received(REMOTE_SESSION_CLOSED_EVENT)).toEqual(
        [],
      );
    });

    it('reactivado, una asistencia nueva funciona y no hereda la sesion cerrada (29)', async () => {
      const scenario = await liveSession();
      const oldSessionId = scenario.sessionId;

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);
      await patchDevice(scenario.admin, scenario.tablet.device.id, {
        isActive: true,
      }).expect(200);

      // Login nuevo (la credencial no se revoco al desactivar).
      const token = await rc.loginDevice(
        scenario.tablet.device.id,
        scenario.tablet.deviceSecret,
      );
      const tablet = await connectedDevice(token);

      const supportRequest = await rc.seedAcceptedRequest(
        scenario.tablet.device.id,
        scenario.technician.user.id,
      );
      const sessionId = await rc.createSession(
        scenario.technician,
        supportRequest.id,
      );

      expect(granted(await join(scenario.console, sessionId), 'joined')).toBe(
        true,
      );
      expect(granted(await join(tablet, sessionId), 'joined')).toBe(true);
      expect(
        granted(await offer(scenario.console, sessionId), 'delivered'),
      ).toBe(true);
      expect(granted(await answer(tablet, sessionId), 'delivered')).toBe(true);

      // La sesion vieja sigue cerrada y no admite a nadie.
      expect(granted(await join(tablet, oldSessionId), 'joined')).toBe(false);
      expect((await rc.sessionRow(oldSessionId)).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
    });

    describe('simultanea con operaciones de signaling en vuelo', () => {
      it('join de la tablet que ya leyo la sesion viva (4)', async () => {
        const scenario = await liveSession();
        const hold = holdSignalingSessionRead(scenario.sessionId);

        const pending = join(scenario.tabletSocket, scenario.sessionId);
        await hold.reached;

        await deactivateDevice(scenario.admin, scenario.tablet.device.id);
        hold.release();

        expect(granted(await pending, 'joined')).toBe(false);
        await settle();
        expect(scenario.console.received('remote-session:peer-joined')).toEqual(
          [],
        );
        await expectClosedBySystem(
          scenario.sessionId,
          scenario.supportRequestId,
        );
      });

      it.each([
        ['offer', WEBRTC_OFFER_EVENT, offer],
        ['answer', WEBRTC_ANSWER_EVENT, answer],
        ['ICE', WEBRTC_ICE_CANDIDATE_EVENT, ice],
      ] as const)(
        '%s de la tablet que ya leyo la sesion viva no llega al tecnico (5-7)',
        async (_label, event, send) => {
          const scenario = await liveSession({ tabletJoined: true });
          const hold = holdSignalingSessionRead(scenario.sessionId);

          const pending = send(scenario.tabletSocket, scenario.sessionId);
          await hold.reached;

          await deactivateDevice(scenario.admin, scenario.tablet.device.id);
          hold.release();

          expect(granted(await pending, 'delivered')).toBe(false);
          await settle();
          expect(scenario.console.received(event)).toEqual([]);
        },
      );

      it('offer del tecnico en vuelo: no llega a ningun socket de la tablet revocada', async () => {
        const scenario = await liveSession({ tabletJoined: true });
        const hold = holdSignalingSessionRead(scenario.sessionId);

        const pending = offer(scenario.console, scenario.sessionId);
        await hold.reached;

        await deactivateDevice(scenario.admin, scenario.tablet.device.id);
        hold.release();
        await pending;
        await settle();

        expect(scenario.tabletSocket.received(WEBRTC_OFFER_EVENT)).toEqual([]);
        // Y el siguiente ya se rechaza: la sesion esta CLOSED.
        expect(
          granted(
            await offer(scenario.console, scenario.sessionId),
            'delivered',
          ),
        ).toBe(false);
      });
    });

    describe('concurrencia con otros cierres sobre la misma fila', () => {
      it.each([
        ['DEVICE primero', 'device-first'],
        ['SYSTEM primero', 'system-first'],
      ] as const)(
        'SYSTEM/DEVICE (%s llega antes al lock): una sola transicion y un solo aviso (23)',
        async (_label, order) => {
          const scenario = await liveSession();
          const blocker = await lockRows(
            `SELECT id FROM "${rc.schema}"."remote_sessions" WHERE id = $1 FOR UPDATE`,
            [scenario.sessionId],
          );

          const deviceClose = () =>
            request(rc.http)
              .post(`/device/remote-sessions/${scenario.sessionId}/close`)
              .set('Authorization', `Bearer ${scenario.tablet.token}`);

          let first: Promise<unknown>;
          let second: Promise<unknown>;

          if (order === 'device-first') {
            first = deviceClose().then((r) => r);
            await waitForLockWaiters(1);
            second = deactivateDevice(
              scenario.admin,
              scenario.tablet.device.id,
            );
          } else {
            first = deactivateDevice(scenario.admin, scenario.tablet.device.id);
            await waitForLockWaiters(1);
            second = deviceClose().then((r) => r);
          }

          await waitForLockWaiters(2).catch(() => undefined);
          await blocker.release();
          const [firstResult, secondResult] = await Promise.all([
            first,
            second,
          ]);

          // Al confirmar el bloqueador, PostgreSQL despierta a los dos y el lock
          // de la fila lo gana cualquiera: no es FIFO. Lo que se exige es una
          // sola transicion y que todo lo demas sea coherente con ella.
          const session = await rc.sessionRow(scenario.sessionId);
          expect(session.status).toBe(RemoteSessionStatus.CLOSED);
          expect([
            RemoteSessionEndedBy.DEVICE,
            RemoteSessionEndedBy.SYSTEM,
          ]).toContain(session.endedBy);

          const supportRequest = await rc.requestRow(scenario.supportRequestId);
          expect(supportRequest.status).toBe(SupportRequestStatus.COMPLETED);
          expect(supportRequest.closedAt?.getTime()).toBe(
            session.endedAt?.getTime(),
          );

          await settle();
          expect(
            scenario.console.received(REMOTE_SESSION_CLOSED_EVENT),
          ).toEqual([
            { remoteSessionId: scenario.sessionId, endedBy: session.endedBy },
          ]);

          // El cierre del dispositivo que pierde la carrera: o 200 idempotente
          // (llego antes del commit de la desactivacion) o 401 (su Device JWT
          // ya no autentica). Nunca 500.
          const deviceStatus = (
            (order === 'device-first' ? firstResult : secondResult) as {
              status: number;
            }
          ).status;
          expect([200, 401]).toContain(deviceStatus);
        },
      );

      it.each([
        ['TECHNICIAN primero', 'technician-first'],
        ['SYSTEM primero', 'system-first'],
      ] as const)(
        'SYSTEM/TECHNICIAN (%s llega antes al lock): una sola transicion (24)',
        async (_label, order) => {
          const scenario = await liveSession({ tabletJoined: true });
          const blocker = await lockRows(
            `SELECT id FROM "${rc.schema}"."remote_sessions" WHERE id = $1 FOR UPDATE`,
            [scenario.sessionId],
          );

          const technicianClose = () =>
            request(rc.http)
              .post(`/remote-sessions/${scenario.sessionId}/close`)
              .set('Authorization', `Bearer ${scenario.technician.token}`)
              .expect(200);

          let first: Promise<unknown>;
          let second: Promise<unknown>;

          if (order === 'technician-first') {
            first = technicianClose();
            await waitForLockWaiters(1);
            second = deactivateDevice(
              scenario.admin,
              scenario.tablet.device.id,
            );
          } else {
            first = deactivateDevice(scenario.admin, scenario.tablet.device.id);
            await waitForLockWaiters(1);
            second = technicianClose();
          }

          await waitForLockWaiters(2).catch(() => undefined);
          await blocker.release();
          await Promise.all([first, second]);

          // Mismo criterio: gana cualquiera de los dos, una sola vez.
          const session = await rc.sessionRow(scenario.sessionId);
          expect(session.status).toBe(RemoteSessionStatus.CLOSED);
          expect([
            RemoteSessionEndedBy.TECHNICIAN,
            RemoteSessionEndedBy.SYSTEM,
          ]).toContain(session.endedBy);
          expect((await rc.requestRow(scenario.supportRequestId)).status).toBe(
            SupportRequestStatus.COMPLETED,
          );

          await settle();
          // El tecnico no recibe aviso de su propio cierre; si gano SYSTEM,
          // recibe exactamente uno.
          expect(
            scenario.console.received(REMOTE_SESSION_CLOSED_EVENT),
          ).toEqual(
            session.endedBy === RemoteSessionEndedBy.SYSTEM
              ? [
                  {
                    remoteSessionId: scenario.sessionId,
                    endedBy: RemoteSessionEndedBy.SYSTEM,
                  },
                ]
              : [],
          );
          expect(session.endedAt?.getTime()).toBe(
            (
              await rc.requestRow(scenario.supportRequestId)
            ).closedAt?.getTime(),
          );
        },
      );
    });

    describe('POST /remote-sessions simultaneo con la desactivacion', () => {
      it('si la desactivacion llega antes, la creacion responde 409 y no queda sesion viva', async () => {
        const base = await onlineTablet();

        // La creacion espera en el lock de su solicitud.
        const blocker = await lockRows(
          `SELECT id FROM "${rc.schema}"."support_requests" WHERE id = $1 FOR UPDATE`,
          [base.supportRequestId],
        );

        const creation = request(rc.http)
          .post('/remote-sessions')
          .set('Authorization', `Bearer ${base.technician.token}`)
          .send({ supportRequestId: base.supportRequestId });
        const created = creation.then((r) => r);
        await waitForLockWaiters(1);

        await deactivateDevice(base.admin, base.tablet.device.id);
        await blocker.release();

        expect((await created).status).toBe(409);
        expect(
          await rc.dataSource.getRepository(RemoteSession).countBy({
            deviceId: base.tablet.device.id,
          }),
        ).toBe(0);
      });

      it('si la creacion llega antes, la desactivacion espera y cierra la sesion nueva', async () => {
        const base = await onlineTablet();
        const service = rc.app.get(RemoteSessionsService);

        // La creacion ya tiene la solicitud y el dispositivo (FOR SHARE)
        // bloqueados y se detiene justo antes de insertar.
        const reached = deferred();
        const gate = deferred();
        type Save = { save: (...args: unknown[]) => Promise<unknown> };
        const realSave = (RemoteSessionsService.prototype as unknown as Save)
          .save;
        const save = jest
          .spyOn(service as unknown as Save, 'save')
          .mockImplementation(async (...args: unknown[]) => {
            reached.resolve();
            await gate.promise;
            return realSave.apply(service, args) as Promise<unknown>;
          });
        restorers.push(() => save.mockRestore());

        const created = request(rc.http)
          .post('/remote-sessions')
          .set('Authorization', `Bearer ${base.technician.token}`)
          .send({ supportRequestId: base.supportRequestId })
          .then((r) => r);
        await reached.promise;

        const deactivation = deactivateDevice(
          base.admin,
          base.tablet.device.id,
        );
        await waitForLockWaiters(1);

        gate.resolve();
        expect((await created).status).toBe(201);
        await deactivation;

        const sessions = await rc.dataSource
          .getRepository(RemoteSession)
          .findBy({ deviceId: base.tablet.device.id });

        expect(sessions).toHaveLength(1);
        await expectClosedBySystem(sessions[0].id, base.supportRequestId);
      });
    });

    it('rollback de PostgreSQL: nada cambia, ni la barrera ni los sockets (30)', async () => {
      const scenario = await liveSession({ tabletJoined: true });

      // Falla la segunda escritura de la transaccion (completar la solicitud).
      await rc.dataSource.query(`
        CREATE FUNCTION "${rc.schema}".rc_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'fallo provocado'; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER rc_fail BEFORE UPDATE ON "${rc.schema}"."support_requests"
          FOR EACH ROW EXECUTE FUNCTION "${rc.schema}".rc_fail();
      `);
      restorers.push(async () => {
        await rc.dataSource.query(
          `DROP TRIGGER IF EXISTS rc_fail ON "${rc.schema}"."support_requests";
           DROP FUNCTION IF EXISTS "${rc.schema}".rc_fail();`,
        );
      });

      await patchDevice(scenario.admin, scenario.tablet.device.id, {
        isActive: false,
      }).expect(500);

      expect((await rc.deviceRow(scenario.tablet.device.id)).isActive).toBe(
        true,
      );
      expect((await rc.sessionRow(scenario.sessionId)).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect((await rc.requestRow(scenario.supportRequestId)).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );

      // Sin commit no hay revocacion: la tablet sigue conectada y su signaling
      // sigue funcionando.
      await settle();
      expect(scenario.tabletSocket.client.connected).toBe(true);
      expect(
        granted(
          await answer(scenario.tabletSocket, scenario.sessionId),
          'delivered',
        ),
      ).toBe(true);

      // Recuperado PostgreSQL, la desactivacion se completa entera.
      await rc.dataSource.query(
        `DROP TRIGGER rc_fail ON "${rc.schema}"."support_requests"`,
      );
      await deactivateDevice(scenario.admin, scenario.tablet.device.id);
      await expectClosedBySystem(scenario.sessionId, scenario.supportRequestId);
      expect(await scenario.tabletSocket.disconnected).toBe(
        'io server disconnect',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Re-enrolamiento
  // ---------------------------------------------------------------------------

  describe('re-enrolamiento', () => {
    it('un handshake con la credencial anterior en vuelo se rechaza; la nueva entra (12, 13)', async () => {
      const scenario = await liveSession();
      const otherDevice = await rc.enrollDevice();
      const otherSocket = await connectedDevice(otherDevice.token);

      const hold = holdCredentialLookup(scenario.tablet.device.id);
      const late = rc.connectDevice(scenario.tablet.token);
      await hold.reached;

      const newSecret = await rc.reEnroll(
        scenario.admin,
        scenario.tablet.device,
      );

      hold.release();
      expect(await late.outcome).toEqual({
        connected: false,
        code: DEVICE_AUTH_UNAUTHORIZED,
        message: 'Unauthorized',
      });

      // El socket que ya estaba conectado con la credencial anterior, fuera.
      expect(await scenario.tabletSocket.disconnected).toBe(
        'io server disconnect',
      );

      // Reconexion con la credencial revocada (11): rechazada, y su login tambien.
      expect(await rc.connectDevice(scenario.tablet.token).outcome).toEqual({
        connected: false,
        code: DEVICE_AUTH_UNAUTHORIZED,
        message: 'Unauthorized',
      });
      await request(rc.http)
        .post('/device-auth/login')
        .send({
          deviceId: scenario.tablet.device.id,
          deviceSecret: scenario.tablet.deviceSecret,
        })
        .expect(401);

      // La sesion autorizada desde la instalacion anterior termino.
      await expectClosedBySystem(scenario.sessionId, scenario.supportRequestId);

      // La credencial nueva entra por el flujo legitimo y no hereda nada.
      const newToken = await rc.loginDevice(
        scenario.tablet.device.id,
        newSecret,
      );
      const fresh = await connectedDevice(newToken);
      expect(granted(await join(fresh, scenario.sessionId), 'joined')).toBe(
        false,
      );

      // Otro dispositivo no se entero de nada.
      expect(otherSocket.client.connected).toBe(true);
      await rc.loginDevice(otherDevice.device.id, otherDevice.deviceSecret);
    });

    it('signaling en vuelo con la credencial anterior no se entrega', async () => {
      const scenario = await liveSession({ tabletJoined: true });
      const hold = holdSignalingSessionRead(scenario.sessionId);

      const pending = answer(scenario.tabletSocket, scenario.sessionId);
      await hold.reached;

      await rc.reEnroll(scenario.admin, scenario.tablet.device);
      hold.release();

      expect(granted(await pending, 'delivered')).toBe(false);
      await settle();
      expect(scenario.console.received(WEBRTC_ANSWER_EVENT)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Tecnico desactivado (A4). No hay operacion del backend: se hace por SQL.
  // ---------------------------------------------------------------------------

  describe('tecnico desactivado por fuera del backend', () => {
    it('con socket conectado: su siguiente mensaje se rechaza, se cierran sus sockets y su sesion (14, 15, 17)', async () => {
      const scenario = await liveSession({ tabletJoined: true });
      const secondTab = await connectedTechnician(scenario.technician.token);

      await deactivateUserBySql(scenario.technician.user.id);

      expect(
        granted(await offer(scenario.console, scenario.sessionId), 'delivered'),
      ).toBe(false);
      expect(scenario.tabletSocket.received(WEBRTC_OFFER_EVENT)).toEqual([]);

      // Todas sus pestanas, fuera.
      expect(await scenario.console.disconnected).toBe('io server disconnect');
      expect(await secondTab.disconnected).toBe('io server disconnect');

      // Su sesion termina con SYSTEM y la tablet lo sabe.
      await waitFor(
        async () =>
          (await rc.sessionRow(scenario.sessionId)).status ===
          RemoteSessionStatus.CLOSED,
        'sesion cerrada',
      );
      await expectClosedBySystem(scenario.sessionId, scenario.supportRequestId);
      await waitFor(
        () =>
          scenario.tabletSocket.received(REMOTE_SESSION_CLOSED_EVENT).length >
          0,
        'remote-session:closed en la tablet',
      );

      // Nuevo handshake con el mismo JWT: rechazado.
      expect(
        await rc.connectTechnician(scenario.technician.token).outcome,
      ).toMatchObject({ connected: false, message: 'Unauthorized' });

      // La tablet sigue conectada: su identidad no se revoco.
      expect(scenario.tabletSocket.client.connected).toBe(true);
    });

    it('durante su join: la revalidacion lee la desactivacion y lo rechaza (16)', async () => {
      const base = await onlineTablet();
      const sessionId = await rc.createSession(
        base.technician,
        base.supportRequestId,
      );
      const console = await connectedTechnician(base.technician.token);

      const hold = holdUserRead(base.technician.user.id);
      const pending = join(console, sessionId);
      await hold.reached;

      await deactivateUserBySql(base.technician.user.id);
      hold.release();

      expect(granted(await pending, 'joined')).toBe(false);
      expect(await console.disconnected).toBe('io server disconnect');
      await waitFor(
        async () =>
          (await rc.sessionRow(sessionId)).status ===
          RemoteSessionStatus.CLOSED,
        'sesion cerrada',
      );
      await expectClosedBySystem(sessionId, base.supportRequestId);
    });

    it('otra pestana en vuelo que ya habia leido al tecnico activo queda bloqueada por la barrera', async () => {
      const scenario = await liveSession({ tabletJoined: true });
      const secondTab = await connectedTechnician(scenario.technician.token);
      expect(granted(await join(secondTab, scenario.sessionId), 'joined')).toBe(
        true,
      );

      // La pestana 2 ya leyo sesion y usuario (activo) y espera.
      const hold = holdSignalingSessionRead(scenario.sessionId);
      const pending = offer(secondTab, scenario.sessionId);
      await hold.reached;

      await deactivateUserBySql(scenario.technician.user.id);

      // La pestana 1 lo detecta.
      expect(
        granted(
          await answer(scenario.console, scenario.sessionId),
          'delivered',
        ),
      ).toBe(false);

      hold.release();
      expect(granted(await pending, 'delivered')).toBe(false);
      await settle();
      expect(scenario.tabletSocket.received(WEBRTC_OFFER_EVENT)).toEqual([]);
    });

    it('sin rol de tecnico: mismo tratamiento', async () => {
      const scenario = await liveSession();

      await rc.dataSource.query(
        `UPDATE "${rc.schema}"."users" SET roles = '{user}' WHERE id = $1`,
        [scenario.technician.user.id],
      );

      expect(
        granted(await join(scenario.console, scenario.sessionId), 'joined'),
      ).toBe(false);
      expect(await scenario.console.disconnected).toBe('io server disconnect');
    });
  });
});
