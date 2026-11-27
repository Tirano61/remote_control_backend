import { config as loadEnv } from 'dotenv';
import * as request from 'supertest';
import { ValidRoles } from '../src/auth/interfaces/valid-roles';
import { DeviceCredential } from '../src/devices/entities/device-credential.entity';
import { deviceRoom } from '../src/devices/realtime/device-realtime.service';
import { RemoteSessionEndedBy } from '../src/remote-sessions/enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from '../src/remote-sessions/enums/remote-session-status.enum';
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
 * se retiene una lectura concreta (o la entrada en una room) hasta que la
 * revocacion confirmo, y solo entonces se deja continuar. No dependen de que
 * una rafaga "acierte" la ventana.
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

interface Hold {
  reached: Promise<void>;
  release(): void;
}

describe('revocacion frente a operaciones en vuelo (PostgreSQL + Socket.IO)', () => {
  let rc: RevocationApp;
  const restorers: Array<() => void> = [];

  beforeAll(async () => {
    rc = await startRevocationApp();
  });

  afterEach(async () => {
    for (const restore of restorers.splice(0)) restore();
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
   * Retiene la PROXIMA lectura de la credencial vigente del dispositivo: la
   * consulta ya respondio (con la credencial vigente y, antes, el dispositivo
   * activo), pero el resultado no vuelve al llamador hasta `release()`.
   *
   * Es exactamente la ventana de C1: la validacion del handshake ya leyo el
   * estado previo a la desactivacion y todavia no registro el socket.
   */
  const holdCredentialLookup = (deviceId: string): Hold => {
    const repository = rc.dataSource.getRepository(DeviceCredential);
    const original = repository.findOne.bind(repository);
    const reached = deferred();
    const gate = deferred();
    let armed = true;

    const spy = jest
      .spyOn(repository, 'findOne')
      .mockImplementation(async (options) => {
        const result = await original(options);
        const where = options.where as { deviceId?: string } | undefined;

        if (armed && where?.deviceId === deviceId) {
          armed = false;
          reached.resolve();
          await gate.promise;
        }

        return result;
      });

    restorers.push(() => spy.mockRestore());

    return { reached: reached.promise, release: () => gate.resolve() };
  };

  /**
   * Retiene la entrada del PROXIMO socket del dispositivo en su room privada,
   * que es lo que `DevicesGateway.handleConnection` espera antes de registrar
   * la presencia. El handshake ya termino y el cliente ya recibio el CONNECT.
   */
  const holdDeviceRoomJoin = (deviceId: string): Hold => {
    const adapter = rc.io.of('/devices').adapter;
    const original = adapter.addAll.bind(adapter);
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
      adapter.addAll = original;
    });

    return { reached: reached.promise, release: () => gate.resolve() };
  };

  // ---------------------------------------------------------------------------
  // Escenario comun
  // ---------------------------------------------------------------------------

  interface LiveSession {
    admin: Technician;
    technician: Technician;
    tablet: EnrolledDevice;
    sessionId: string;
    supportRequestId: string;
    tabletSocket: TestSocket;
    console: TestSocket;
  }

  /**
   * Tablet ONLINE, sesion CONNECTING creada por `POST /remote-sessions` y la
   * consola del tecnico unida al signaling de la sesion.
   */
  const liveSession = async (): Promise<LiveSession> => {
    const admin = await rc.seedTechnician([ValidRoles.admin]);
    const technician = await rc.seedTechnician();
    const tablet = await rc.enrollDevice();

    const tabletSocket = rc.connectDevice(tablet.token);
    expect(await tabletSocket.outcome).toEqual({ connected: true });
    await waitFor(
      () => tabletSocket.received('device:connected').length > 0,
      'device:connected',
    );

    const request_ = await rc.seedAcceptedRequest(
      tablet.device.id,
      technician.user.id,
    );
    const sessionId = await rc.createSession(technician, request_.id);

    const console = rc.connectTechnician(technician.token);
    expect(await console.outcome).toEqual({ connected: true });
    expect(
      await console.emitWithAck(REMOTE_SESSION_JOIN_EVENT, {
        remoteSessionId: sessionId,
      }),
    ).toMatchObject({ joined: true });

    return {
      admin,
      technician,
      tablet,
      sessionId,
      supportRequestId: request_.id,
      tabletSocket,
      console,
    };
  };

  const deactivateDevice = (admin: Technician, deviceId: string) =>
    request(rc.http)
      .patch(`/devices/${deviceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ isActive: false })
      .expect(200);

  const isOnline = async (admin: Technician, deviceId: string) => {
    const response = await request(rc.http)
      .get(`/devices/${deviceId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    return (response.body as { isOnline: boolean }).isOnline;
  };

  /**
   * La propiedad de seguridad despues de una revocacion confirmada: el socket
   * tardio no tiene acceso a nada y la sesion afectada termino.
   */
  const expectNoAccessAfterRevocation = async (
    scenario: LiveSession,
    late: TestSocket,
  ): Promise<void> => {
    const { sessionId, console } = scenario;

    const joinAck = await late.emitWithAck(REMOTE_SESSION_JOIN_EVENT, {
      remoteSessionId: sessionId,
    });

    const offerAck = await console.emitWithAck(WEBRTC_OFFER_EVENT, {
      remoteSessionId: sessionId,
      sdp: SDP_OFFER,
    });

    const answerAck = await late.emitWithAck(WEBRTC_ANSWER_EVENT, {
      remoteSessionId: sessionId,
      sdp: SDP_ANSWER,
    });

    const iceAck = await late.emitWithAck(WEBRTC_ICE_CANDIDATE_EVENT, {
      remoteSessionId: sessionId,
      ...ICE,
    });

    await settle();

    expect(joinAck).not.toMatchObject({ joined: true });
    expect(offerAck).not.toMatchObject({ delivered: true });
    expect(late.received(WEBRTC_OFFER_EVENT)).toEqual([]);
    expect(answerAck).not.toMatchObject({ delivered: true });
    expect(iceAck).not.toMatchObject({ delivered: true });
    expect(console.received(WEBRTC_ANSWER_EVENT)).toEqual([]);
    expect(console.received(WEBRTC_ICE_CANDIDATE_EVENT)).toEqual([]);

    expect(late.client.connected).toBe(false);
    expect(await isOnline(scenario.admin, scenario.tablet.device.id)).toBe(
      false,
    );

    const session = await rc.sessionRow(sessionId);
    expect(session.status).toBe(RemoteSessionStatus.CLOSED);
    expect(session.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);
    expect(session.endedAt).toBeInstanceOf(Date);

    expect((await rc.requestRow(scenario.supportRequestId)).status).toBe(
      SupportRequestStatus.COMPLETED,
    );
  };

  // ---------------------------------------------------------------------------
  // C1
  // ---------------------------------------------------------------------------

  describe('C1: handshake validado antes de una desactivacion confirmada', () => {
    it('pausa tras leer la credencial: el handshake no completa ni concede join ni signaling', async () => {
      const scenario = await liveSession();
      const hold = holdCredentialLookup(scenario.tablet.device.id);

      // 1-2. Empieza el handshake y la validacion lee dispositivo y credencial.
      const late = rc.connectDevice(scenario.tablet.token);
      // 3. Pausa antes del registro.
      await hold.reached;

      // 4-5. Desactivacion confirmada (200).
      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      // 6. Continua el handshake.
      hold.release();
      const outcome = await late.outcome;

      if (outcome.connected) await settle();

      // 7-8. Join y signaling.
      await expectNoAccessAfterRevocation(scenario, late);
    });

    it('pausa en la room del dispositivo: el socket ya conectado no queda registrado ni concede nada', async () => {
      const scenario = await liveSession();
      const hold = holdDeviceRoomJoin(scenario.tablet.device.id);

      const late = rc.connectDevice(scenario.tablet.token);
      await hold.reached;

      await deactivateDevice(scenario.admin, scenario.tablet.device.id);

      hold.release();
      await late.outcome;
      await settle();

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
      const pendingJoin = late.emitWithAck(REMOTE_SESSION_JOIN_EVENT, {
        remoteSessionId: scenario.sessionId,
      });

      expect(await pendingJoin).not.toMatchObject({ joined: true });

      hold.release();
      await settle();

      await expectNoAccessAfterRevocation(scenario, late);
    });
  });
});
