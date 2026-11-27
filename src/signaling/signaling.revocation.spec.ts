import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import { RemoteSessionStatus } from '../remote-sessions/enums/remote-session-status.enum';
import { SignalingErrorCode } from './interfaces/signaling-ack.interface';
import {
  SignalingIdentity,
  SignalingParticipant,
  SignalingSocket,
} from './interfaces/signaling-participant.interface';
import { SessionParticipationService } from './participation/session-participation.service';
import { SignalingRealtimeService } from './realtime/signaling-realtime.service';
import {
  REMOTE_SESSION_PEER_JOINED_EVENT,
  remoteSessionRoom,
  WEBRTC_ANSWER_EVENT,
} from './signaling.events';
import { SignalingService } from './signaling.service';

/**
 * `SignalingService` frente a una revocacion que confirma MIENTRAS espera a
 * PostgreSQL o al transporte.
 *
 * Unitario y determinista: cada `await` del servicio queda en manos de la
 * prueba, que revoca la identidad (la barrera pasa a "no admisible") justo en
 * medio. Lo que se comprueba es que ninguna lectura anterior a la revocacion
 * produzca un efecto despues de ella. La version de punta a punta, con
 * PostgreSQL y Socket.IO reales, esta en `test/revocation.db-spec.ts`.
 */

const SESSION_ID = '3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10';
const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const TECHNICIAN_ID = '9b2f1d7e-4c3a-4e5f-8a6b-1c2d3e4f5a6b';

const liveSession = {
  id: SESSION_ID,
  deviceId: DEVICE_ID,
  technicianId: TECHNICIAN_ID,
  status: RemoteSessionStatus.ACTIVE,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe('SignalingService frente a revocaciones en vuelo', () => {
  let findOne: jest.Mock;
  let hasParticipantInSession: jest.Mock;
  let emitToParticipantSession: jest.Mock;
  let participation: SessionParticipationService;
  let service: SignalingService;
  let socket: SignalingSocket & { join: jest.Mock; leave: jest.Mock };
  let current: boolean;
  let revalidate: jest.Mock;
  let identity: SignalingIdentity;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    findOne = jest.fn().mockResolvedValue({ ...liveSession });
    hasParticipantInSession = jest.fn().mockResolvedValue(true);
    emitToParticipantSession = jest.fn().mockReturnValue(true);
    participation = new SessionParticipationService();

    service = new SignalingService(
      { findOne } as unknown as Repository<RemoteSession>,
      {
        hasParticipantInSession,
        emitToParticipantSession,
      } as unknown as SignalingRealtimeService,
      participation,
    );

    socket = {
      id: 'socket-tablet',
      data: {},
      disconnected: false,
      join: jest.fn(),
      leave: jest.fn(),
    };

    current = true;
    revalidate = jest.fn().mockResolvedValue(true);
    identity = {
      participant: SignalingParticipant.DEVICE,
      id: DEVICE_ID,
      revalidate,
      isCurrent: () => current,
    };
  });

  afterEach(() => jest.restoreAllMocks());

  const joinPayload = { remoteSessionId: SESSION_ID };
  const answerPayload = { remoteSessionId: SESSION_ID, sdp: 'v=0 answer' };

  /** Socket ya unido a la sesion por un join valido. */
  const joined = async () => {
    expect(await service.join(socket, identity, joinPayload)).toMatchObject({
      joined: true,
    });
    emitToParticipantSession.mockClear();
  };

  describe('remote-session:join', () => {
    it('identidad ya revocada: ni siquiera consulta PostgreSQL', async () => {
      current = false;

      expect(await service.join(socket, identity, joinPayload)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(findOne).not.toHaveBeenCalled();
      expect(revalidate).not.toHaveBeenCalled();
    });

    it('la revalidacion de la identidad rechaza: UNAUTHORIZED, sin entrar en la room', async () => {
      revalidate.mockResolvedValue(false);

      expect(await service.join(socket, identity, joinPayload)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(socket.join).not.toHaveBeenCalled();
      expect(
        participation.isPresent(SESSION_ID, SignalingParticipant.DEVICE),
      ).toBe(false);
    });

    it('revocado mientras se leia la sesion: la lectura anterior no concede la entrada', async () => {
      const read = deferred<typeof liveSession>();
      findOne.mockReturnValue(read.promise);

      const pending = service.join(socket, identity, joinPayload);

      // La revocacion confirma con la lectura ya hecha (sesion viva).
      current = false;
      read.resolve({ ...liveSession });

      expect(await pending).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(
        participation.isPresent(SESSION_ID, SignalingParticipant.DEVICE),
      ).toBe(false);
      expect(socket.data.remoteSessionId).toBeUndefined();
      // Si llego a entrar en la room, salio.
      if (socket.join.mock.calls.length > 0)
        expect(socket.leave).toHaveBeenCalledWith(
          remoteSessionRoom(SESSION_ID),
        );
    });

    it('revocado mientras se consultaba al peer: no se anuncia ni queda participando', async () => {
      // 1a llamada: ownSideWasPresent; 2a: peerJoined (retenida).
      const peer = deferred<boolean>();
      hasParticipantInSession
        .mockResolvedValueOnce(false)
        .mockReturnValueOnce(peer.promise);

      const pending = service.join(socket, identity, joinPayload);

      await new Promise((resolve) => setImmediate(resolve));
      expect(
        participation.isPresent(SESSION_ID, SignalingParticipant.DEVICE),
      ).toBe(true);

      current = false;
      peer.resolve(true);

      expect(await pending).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(emitToParticipantSession).not.toHaveBeenCalledWith(
        SignalingParticipant.TECHNICIAN,
        SESSION_ID,
        REMOTE_SESSION_PEER_JOINED_EVENT,
        expect.anything(),
      );
      expect(
        participation.isPresent(SESSION_ID, SignalingParticipant.DEVICE),
      ).toBe(false);
      expect(socket.data.remoteSessionId).toBeNull();
      expect(socket.leave).toHaveBeenCalledWith(remoteSessionRoom(SESSION_ID));
    });

    it('PostgreSQL falla al revalidar: el error sale tal cual, no es una revocacion', async () => {
      revalidate.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.join(socket, identity, joinPayload)).rejects.toThrow(
        'ECONNREFUSED',
      );
      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('webrtc:*', () => {
    it('sin revocacion, retransmite al peer', async () => {
      await joined();

      expect(
        await service.relayAnswer(socket, identity, answerPayload),
      ).toEqual({ delivered: true, remoteSessionId: SESSION_ID });
      expect(emitToParticipantSession).toHaveBeenCalledWith(
        SignalingParticipant.TECHNICIAN,
        SESSION_ID,
        WEBRTC_ANSWER_EVENT,
        expect.objectContaining({ sdp: 'v=0 answer' }),
      );
    });

    it('pertenecer a la room no basta: identidad revocada, ni lectura ni envio', async () => {
      await joined();
      findOne.mockClear();
      current = false;

      expect(
        await service.relayAnswer(socket, identity, answerPayload),
      ).toEqual({ delivered: false, error: SignalingErrorCode.UNAUTHORIZED });
      expect(findOne).not.toHaveBeenCalled();
      expect(emitToParticipantSession).not.toHaveBeenCalled();
    });

    it('la revalidacion rechaza (dispositivo inactivo, credencial revocada): no se envia', async () => {
      await joined();
      revalidate.mockResolvedValue(false);

      expect(
        await service.relayAnswer(socket, identity, answerPayload),
      ).toEqual({ delivered: false, error: SignalingErrorCode.UNAUTHORIZED });
      expect(emitToParticipantSession).not.toHaveBeenCalled();
    });

    it('revocado mientras se revalidaba: lo leido antes no autoriza el envio', async () => {
      await joined();
      const check = deferred<boolean>();
      revalidate.mockReturnValue(check.promise);

      const pending = service.relayIceCandidate(socket, identity, {
        remoteSessionId: SESSION_ID,
        candidate: 'candidate:1 1 UDP 1 192.168.1.10 54400 typ host',
      });

      current = false;
      check.resolve(true);

      expect(await pending).toEqual({
        delivered: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(emitToParticipantSession).not.toHaveBeenCalled();
    });

    it('socket desconectado (barrido) mientras se leia la sesion: no se envia', async () => {
      await joined();
      const read = deferred<typeof liveSession>();
      findOne.mockReturnValue(read.promise);

      const pending = service.relayOffer(socket, identity, {
        remoteSessionId: SESSION_ID,
        sdp: 'v=0 offer',
      });

      (socket as { disconnected: boolean }).disconnected = true;
      read.resolve({ ...liveSession });

      expect(await pending).toEqual({
        delivered: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(emitToParticipantSession).not.toHaveBeenCalled();
    });

    it('sesion cerrada (la cerro la revocacion): UNAUTHORIZED aunque la identidad siguiera valida', async () => {
      await joined();
      findOne.mockResolvedValue(null);

      expect(
        await service.relayAnswer(socket, identity, answerPayload),
      ).toEqual({ delivered: false, error: SignalingErrorCode.UNAUTHORIZED });
    });
  });
});
