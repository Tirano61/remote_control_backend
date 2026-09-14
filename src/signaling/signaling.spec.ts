import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { FindOperator, FindOptionsWhere, Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { DeviceAuthService } from '../devices/auth/device-auth.service';
import { DeviceCredentialsService } from '../devices/auth/device-credentials.service';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from '../devices/auth/interfaces/device-jwt-payload.interface';
import { DeviceCredential } from '../devices/entities/device-credential.entity';
import { Device } from '../devices/entities/device.entity';
import {
  DEVICES_NAMESPACE,
  DevicesGateway,
} from '../devices/gateway/devices.gateway';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import { RemoteSessionStatus } from '../remote-sessions/enums/remote-session-status.enum';
import {
  TECHNICIANS_NAMESPACE,
  TechniciansGateway,
} from './gateway/technicians.gateway';
import {
  JoinRemoteSessionAck,
  SignalingErrorCode,
  SignalingRelayAck,
} from './interfaces/signaling-ack.interface';
import { SignalingParticipant } from './interfaces/signaling-participant.interface';
import { SignalingRealtimeService } from './realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from './realtime/technician-realtime.service';
import {
  REMOTE_SESSION_JOIN_EVENT,
  WEBRTC_ANSWER_EVENT,
  WEBRTC_ICE_CANDIDATE_EVENT,
  WEBRTC_OFFER_EVENT,
  WebrtcIceCandidatePayload,
  WebrtcSdpPayload,
} from './signaling.events';
import { SignalingService } from './signaling.service';

/**
 * Signaling sobre conexiones Socket.IO reales.
 *
 * Los dos gateways, la autenticacion del Device JWT, la del JWT de usuario y el
 * relay son los de produccion: solo se sustituyen los repositorios de TypeORM
 * por dobles en memoria, porque estas pruebas no necesitan PostgreSQL.
 *
 * El objetivo es demostrar que la SDP y los candidatos ICE viajan unicamente
 * entre los dos participantes de una misma `RemoteSession` viva, y que conocer
 * un UUID no basta para nada.
 */
jest.setTimeout(20_000);

const DEVICE_JWT_SECRET = 'device-secret-for-tests';
const USER_JWT_SECRET = 'user-secret-for-tests';

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DEVICE_C_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const CREDENTIAL_OF: Record<string, string> = {
  [DEVICE_A_ID]: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  [DEVICE_B_ID]: 'b1f6d2f4-1f4a-4a2e-9d6e-2a0f7a5c9d31',
  [DEVICE_C_ID]: 'c3f1a2b4-5d6e-4f70-8a91-2b3c4d5e6f70',
};

const SESSION_A_ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const SESSION_B_ID = '2c8e7cde-ccfe-4c3e-8c6e-bc9efcce5cfe';
const SESSION_C_ID = '3d7f8def-ddaf-4d4f-9d7f-cdaf0ddf6daf';
const CLOSED_SESSION_ID = '4e6a9efa-eeba-4e5a-8e8a-deba1eea7eba';

const SDP =
  'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96';
const CANDIDATE = 'candidate:1 1 UDP 2130706431 192.168.1.10 54321 typ host';

const buildDevice = (id: string, publicId: string): Device =>
  ({
    id,
    publicId,
    name: `Tablet ${publicId}`,
    manufacturer: 'Samsung',
    model: 'SM-X210',
    androidVersion: '14',
    appVersion: '1.0.0',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as Device;

const buildUser = (fullName: string, roles: ValidRoles[]): User =>
  ({
    id: randomUUID(),
    email: `${fullName.toLowerCase().replace(/ /g, '.')}@acme.com`,
    password: 'hash-que-nunca-debe-salir',
    fullName,
    isActive: true,
    roles,
    created_at: new Date(),
    updated_at: new Date(),
  }) as User;

const technicianA = buildUser('Ana Tecnica', [ValidRoles.tecnico]);
const technicianB = buildUser('Beto Tecnico', [ValidRoles.tecnico]);
const admin = buildUser('Admin Total', [ValidRoles.admin]);
const plainUser = buildUser('Usuario Normal', [ValidRoles.user]);
const inactiveTechnician = buildUser('Inactiva Tecnica', [ValidRoles.tecnico]);
inactiveTechnician.isActive = false;

describe('Signaling WebRTC (Socket.IO)', () => {
  let app: INestApplication;
  let devicesUrl: string;
  let techniciansUrl: string;
  let presence: DevicePresenceService;
  let deviceJwt: JwtService;
  let userJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  const devices: Record<string, Device> = {};
  const users: Record<string, User> = {};
  let remoteSessions: RemoteSession[] = [];

  /** Cualquier escritura sobre `remote_sessions` seria un fallo del signaling. */
  let writes: string[] = [];

  const openClients: ClientSocket[] = [];

  /** Eventos de signaling recibidos por cada socket. */
  const received = new WeakMap<ClientSocket, Record<string, unknown[]>>();

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(devices[id] ?? null),
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      Promise.resolve({
        id: CREDENTIAL_OF[where.deviceId],
        deviceId: where.deviceId,
        secretHash: 'hash',
      }),
    update: () => Promise.resolve({ affected: 1 }),
  };

  const userRepository = {
    findOneBy: ({ id }: { id: string }) => Promise.resolve(users[id] ?? null),
  };

  /** Solo lectura: la pertenencia y el estado viajan en el WHERE. */
  const remoteSessionRepository = {
    findOne: ({ where }: { where: FindOptionsWhere<RemoteSession> }) => {
      const matchesStatus = (session: RemoteSession): boolean => {
        const condition = where.status;

        if (!(condition instanceof FindOperator)) return true;

        return (condition.value as unknown as RemoteSessionStatus[]).includes(
          session.status,
        );
      };

      const found = remoteSessions.find(
        (session) =>
          session.id === where.id &&
          (where.deviceId === undefined ||
            where.deviceId === session.deviceId) &&
          (where.technicianId === undefined ||
            where.technicianId === session.technicianId) &&
          matchesStatus(session),
      );

      return Promise.resolve(found ?? null);
    },
    save: () => {
      writes.push('save');
      return Promise.resolve(null);
    },
    insert: () => {
      writes.push('insert');
      return Promise.resolve(null);
    },
    update: () => {
      writes.push('update');
      return Promise.resolve(null);
    },
    createQueryBuilder: () => {
      writes.push('createQueryBuilder');
      throw new Error('El signaling no debe escribir en remote_sessions');
    },
  };

  const signDeviceToken = (deviceId: string): string =>
    deviceJwt.sign({
      sub: deviceId,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_OF[deviceId],
    } as DeviceJwtPayload);

  const signUserToken = (user: User): string => userJwt.sign({ id: user.id });

  /** Abre un socket real y resuelve solo si el servidor acepta la conexion. */
  const connect = (
    url: string,
    auth?: Record<string, unknown>,
  ): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth,
      });

      openClients.push(client);
      received.set(client, {
        [WEBRTC_OFFER_EVENT]: [],
        [WEBRTC_ANSWER_EVENT]: [],
        [WEBRTC_ICE_CANDIDATE_EVENT]: [],
      });

      for (const event of [
        WEBRTC_OFFER_EVENT,
        WEBRTC_ANSWER_EVENT,
        WEBRTC_ICE_CANDIDATE_EVENT,
      ])
        client.on(event, (payload: unknown) =>
          received.get(client)?.[event].push(payload),
        );

      client.once('connect', () => resolve(client));
      client.once('connect_error', (error: Error) => reject(error));
    });

  const connectTechnician = (user: User): Promise<ClientSocket> =>
    connect(techniciansUrl, { token: signUserToken(user) });

  const connectDevice = (deviceId: string): Promise<ClientSocket> =>
    connect(devicesUrl, { token: signDeviceToken(deviceId) });

  /** Emite y espera la respuesta (ACK) del servidor. */
  const emitWithAck = <T>(
    client: ClientSocket,
    event: string,
    payload: unknown,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout: ACK de ${event}`)),
        5_000,
      );

      client.emit(event, payload, (ack: T) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });

  const join = (
    client: ClientSocket,
    remoteSessionId: string,
  ): Promise<JoinRemoteSessionAck> =>
    emitWithAck(client, REMOTE_SESSION_JOIN_EVENT, { remoteSessionId });

  const sendOffer = (
    client: ClientSocket,
    remoteSessionId: string,
  ): Promise<SignalingRelayAck> =>
    emitWithAck(client, WEBRTC_OFFER_EVENT, { remoteSessionId, sdp: SDP });

  const sendAnswer = (
    client: ClientSocket,
    remoteSessionId: string,
  ): Promise<SignalingRelayAck> =>
    emitWithAck(client, WEBRTC_ANSWER_EVENT, { remoteSessionId, sdp: SDP });

  const sendCandidate = (
    client: ClientSocket,
    remoteSessionId: string,
    candidate: Record<string, unknown> = {
      candidate: CANDIDATE,
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  ): Promise<SignalingRelayAck> =>
    emitWithAck(client, WEBRTC_ICE_CANDIDATE_EVENT, {
      remoteSessionId,
      ...candidate,
    });

  const eventsOf = (client: ClientSocket, event: string): unknown[] =>
    received.get(client)?.[event] ?? [];

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

  /** Margen para que un mensaje que NO debe llegar tuviera tiempo de llegar. */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 100));

  const waitForEvent = async (
    client: ClientSocket,
    event: string,
  ): Promise<unknown> => {
    await waitFor(
      () => eventsOf(client, event).length > 0,
      `${event} en el destinatario`,
    );

    return eventsOf(client, event)[0];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // El JwtService del modulo es el de los dispositivos. El de usuarios va
        // aparte, dentro de AuthService: son dos secretos distintos y no deben
        // poder confundirse.
        JwtModule.register({
          secret: DEVICE_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      providers: [
        DevicesGateway,
        TechniciansGateway,
        SignalingService,
        SignalingRealtimeService,
        // El gateway de tecnicos tambien registra la salida de eventos de
        // dominio; aqui no se emite ninguno.
        TechnicianRealtimeService,
        DevicePresenceService,
        DeviceRealtimeService,
        DeviceAuthService,
        DeviceCredentialsService,
        {
          provide: AuthService,
          useFactory: () =>
            new AuthService(
              userRepository as unknown as Repository<User>,
              new JwtService({
                secret: USER_JWT_SECRET,
                signOptions: { expiresIn: '1h' },
              }),
            ),
        },
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
        {
          provide: getRepositoryToken(RemoteSession),
          useValue:
            remoteSessionRepository as unknown as Repository<RemoteSession>,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    presence = app.get(DevicePresenceService);
    deviceJwt = app.get(JwtService);
    userJwt = new JwtService({
      secret: USER_JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    });

    await app.listen(0);

    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;

    devicesUrl = `http://127.0.0.1:${port}${DEVICES_NAMESPACE}`;
    techniciansUrl = `http://127.0.0.1:${port}${TECHNICIANS_NAMESPACE}`;
  });

  beforeEach(() => {
    devices[DEVICE_A_ID] = buildDevice(DEVICE_A_ID, '384-729-142');
    devices[DEVICE_B_ID] = buildDevice(DEVICE_B_ID, '111-222-333');
    devices[DEVICE_C_ID] = buildDevice(DEVICE_C_ID, '555-666-777');

    for (const user of [
      technicianA,
      technicianB,
      admin,
      plainUser,
      inactiveTechnician,
    ])
      users[user.id] = user;

    remoteSessions = [
      {
        id: SESSION_A_ID,
        deviceId: DEVICE_A_ID,
        technicianId: technicianA.id,
        status: RemoteSessionStatus.CONNECTING,
      },
      {
        id: SESSION_B_ID,
        deviceId: DEVICE_B_ID,
        technicianId: technicianB.id,
        status: RemoteSessionStatus.CONNECTING,
      },
      // Segunda sesion del mismo tecnico, en otro dispositivo.
      {
        id: SESSION_C_ID,
        deviceId: DEVICE_C_ID,
        technicianId: technicianA.id,
        status: RemoteSessionStatus.CONNECTING,
      },
      // Sesion ya terminada del dispositivo A.
      {
        id: CLOSED_SESSION_ID,
        deviceId: DEVICE_A_ID,
        technicianId: technicianA.id,
        status: RemoteSessionStatus.CLOSED,
      },
    ] as RemoteSession[];

    writes = [];
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await waitFor(
      () =>
        [DEVICE_A_ID, DEVICE_B_ID, DEVICE_C_ID].every(
          (id) => presence.connectionCount(id) === 0,
        ),
      'presencia vacia entre pruebas',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  describe('autenticacion del namespace /technicians', () => {
    it('acepta el JWT de un tecnico activo', async () => {
      await expect(connectTechnician(technicianA)).resolves.toBeDefined();
    });

    it('acepta el JWT de un admin', async () => {
      await expect(connectTechnician(admin)).resolves.toBeDefined();
    });

    it('rechaza a un usuario autenticado sin rol de tecnico o admin', async () => {
      await expect(connectTechnician(plainUser)).rejects.toThrow(
        'Unauthorized',
      );
    });

    it('rechaza a un tecnico desactivado', async () => {
      await expect(connectTechnician(inactiveTechnician)).rejects.toThrow(
        'Unauthorized',
      );
    });

    it('rechaza un JWT invalido', async () => {
      await expect(
        connect(techniciansUrl, { token: 'not-a-jwt' }),
      ).rejects.toThrow('Unauthorized');
    });

    it('rechaza una conexion sin token', async () => {
      await expect(connect(techniciansUrl)).rejects.toThrow('Unauthorized');
    });

    it('rechaza un Device JWT en el namespace de tecnicos', async () => {
      await expect(
        connect(techniciansUrl, { token: signDeviceToken(DEVICE_A_ID) }),
      ).rejects.toThrow('Unauthorized');
    });

    it('sigue rechazando un JWT de usuario en el namespace de dispositivos', async () => {
      await expect(
        connect(devicesUrl, { token: signUserToken(technicianA) }),
      ).rejects.toThrow('Unauthorized');
    });

    it('no acepta identidad enviada en el handshake', async () => {
      // Sin token no hay identidad posible: un userId suelto no autentica.
      await expect(
        connect(techniciansUrl, {
          userId: technicianA.id,
          roles: [ValidRoles.tecnico],
        }),
      ).rejects.toThrow('Unauthorized');
    });
  });

  describe('remote-session:join', () => {
    it('une al tecnico dueno de una sesion CONNECTING', async () => {
      const technician = await connectTechnician(technicianA);

      expect(await join(technician, SESSION_A_ID)).toEqual({
        joined: true,
        remoteSessionId: SESSION_A_ID,
      });
    });

    it('une al dispositivo dueno de la sesion', async () => {
      const device = await connectDevice(DEVICE_A_ID);

      expect(await join(device, SESSION_A_ID)).toEqual({
        joined: true,
        remoteSessionId: SESSION_A_ID,
      });
    });

    it('rechaza al tecnico sobre la sesion de otro tecnico', async () => {
      const technician = await connectTechnician(technicianB);

      expect(await join(technician, SESSION_A_ID)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
    });

    it('rechaza al admin sobre la sesion de otro tecnico', async () => {
      const supervisor = await connectTechnician(admin);

      // Ser admin permite abrir el socket, no entrar en sesiones ajenas.
      expect(await join(supervisor, SESSION_A_ID)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
    });

    it('rechaza al dispositivo sobre la sesion de otro dispositivo', async () => {
      const device = await connectDevice(DEVICE_B_ID);

      expect(await join(device, SESSION_A_ID)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
    });

    it('rechaza una sesion CLOSED a sus dos participantes', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      expect(await join(technician, CLOSED_SESSION_ID)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(await join(device, CLOSED_SESSION_ID)).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
    });

    it('rechaza una sesion inexistente igual que una ajena', async () => {
      const technician = await connectTechnician(technicianA);

      expect(await join(technician, randomUUID())).toEqual({
        joined: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
    });

    it('rechaza un payload invalido sin tocar la sesion actual', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(technician, SESSION_A_ID);
      await join(device, SESSION_A_ID);

      expect(
        await emitWithAck(technician, REMOTE_SESSION_JOIN_EVENT, {
          remoteSessionId: 'not-a-uuid',
        }),
      ).toEqual({ joined: false, error: SignalingErrorCode.INVALID_PAYLOAD });

      // El join anterior sigue en pie.
      expect(await sendOffer(technician, SESSION_A_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_A_ID,
      });
      expect(await waitForEvent(device, WEBRTC_OFFER_EVENT)).toBeDefined();
    });

    it('mantiene una sola sesion por socket', async () => {
      const technician = await connectTechnician(technicianA);
      const deviceA = await connectDevice(DEVICE_A_ID);
      const deviceC = await connectDevice(DEVICE_C_ID);

      await join(deviceA, SESSION_A_ID);
      await join(deviceC, SESSION_C_ID);

      await join(technician, SESSION_A_ID);
      expect(await join(technician, SESSION_C_ID)).toEqual({
        joined: true,
        remoteSessionId: SESSION_C_ID,
      });

      // La sesion anterior quedo abandonada.
      expect(await sendOffer(technician, SESSION_A_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.NOT_JOINED,
      });

      expect(await sendOffer(technician, SESSION_C_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_C_ID,
      });

      await waitForEvent(deviceC, WEBRTC_OFFER_EVENT);
      expect(eventsOf(deviceA, WEBRTC_OFFER_EVENT)).toHaveLength(0);
    });
  });

  describe('relay de signaling', () => {
    it('entrega webrtc:offer solo al dispositivo de esa sesion', async () => {
      const technician = await connectTechnician(technicianA);
      const deviceA = await connectDevice(DEVICE_A_ID);
      const deviceB = await connectDevice(DEVICE_B_ID);
      const otherTechnician = await connectTechnician(technicianB);

      await join(technician, SESSION_A_ID);
      await join(deviceA, SESSION_A_ID);
      await join(deviceB, SESSION_B_ID);
      await join(otherTechnician, SESSION_B_ID);

      expect(await sendOffer(technician, SESSION_A_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_A_ID,
      });

      expect(await waitForEvent(deviceA, WEBRTC_OFFER_EVENT)).toEqual({
        remoteSessionId: SESSION_A_ID,
        from: SignalingParticipant.TECHNICIAN,
        sdp: SDP,
      } as WebrtcSdpPayload);

      await settle();

      // Ni el otro dispositivo, ni el otro tecnico, ni el propio emisor.
      expect(eventsOf(deviceB, WEBRTC_OFFER_EVENT)).toHaveLength(0);
      expect(eventsOf(otherTechnician, WEBRTC_OFFER_EVENT)).toHaveLength(0);
      expect(eventsOf(technician, WEBRTC_OFFER_EVENT)).toHaveLength(0);
    });

    it('entrega webrtc:answer solo al tecnico de esa sesion', async () => {
      const technician = await connectTechnician(technicianA);
      const otherTechnician = await connectTechnician(technicianB);
      const deviceA = await connectDevice(DEVICE_A_ID);
      const deviceB = await connectDevice(DEVICE_B_ID);

      await join(technician, SESSION_A_ID);
      await join(otherTechnician, SESSION_B_ID);
      await join(deviceA, SESSION_A_ID);
      await join(deviceB, SESSION_B_ID);

      expect(await sendAnswer(deviceA, SESSION_A_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_A_ID,
      });

      expect(await waitForEvent(technician, WEBRTC_ANSWER_EVENT)).toEqual({
        remoteSessionId: SESSION_A_ID,
        from: SignalingParticipant.DEVICE,
        sdp: SDP,
      } as WebrtcSdpPayload);

      await settle();

      expect(eventsOf(otherTechnician, WEBRTC_ANSWER_EVENT)).toHaveLength(0);
      expect(eventsOf(deviceA, WEBRTC_ANSWER_EVENT)).toHaveLength(0);
      expect(eventsOf(deviceB, WEBRTC_ANSWER_EVENT)).toHaveLength(0);
    });

    it('retransmite candidatos ICE en las dos direcciones', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(technician, SESSION_A_ID);
      await join(device, SESSION_A_ID);

      expect(await sendCandidate(technician, SESSION_A_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_A_ID,
      });

      expect(await waitForEvent(device, WEBRTC_ICE_CANDIDATE_EVENT)).toEqual({
        remoteSessionId: SESSION_A_ID,
        from: SignalingParticipant.TECHNICIAN,
        candidate: CANDIDATE,
        sdpMid: '0',
        sdpMLineIndex: 0,
      } as WebrtcIceCandidatePayload);

      // De vuelta, y con los nullable que WebRTC produce de verdad.
      expect(
        await sendCandidate(device, SESSION_A_ID, {
          candidate: CANDIDATE,
          sdpMid: null,
          sdpMLineIndex: 1,
        }),
      ).toEqual({ delivered: true, remoteSessionId: SESSION_A_ID });

      expect(
        await waitForEvent(technician, WEBRTC_ICE_CANDIDATE_EVENT),
      ).toEqual({
        remoteSessionId: SESSION_A_ID,
        from: SignalingParticipant.DEVICE,
        candidate: CANDIDATE,
        sdpMid: null,
        sdpMLineIndex: 1,
      } as WebrtcIceCandidatePayload);
    });

    it('aisla por completo dos sesiones simultaneas', async () => {
      const technicianOfA = await connectTechnician(technicianA);
      const technicianOfB = await connectTechnician(technicianB);
      const deviceA = await connectDevice(DEVICE_A_ID);
      const deviceB = await connectDevice(DEVICE_B_ID);

      await join(technicianOfA, SESSION_A_ID);
      await join(deviceA, SESSION_A_ID);
      await join(technicianOfB, SESSION_B_ID);
      await join(deviceB, SESSION_B_ID);

      await sendOffer(technicianOfA, SESSION_A_ID);
      await sendCandidate(deviceB, SESSION_B_ID);

      await waitForEvent(deviceA, WEBRTC_OFFER_EVENT);
      await waitForEvent(technicianOfB, WEBRTC_ICE_CANDIDATE_EVENT);

      await settle();

      expect(eventsOf(deviceB, WEBRTC_OFFER_EVENT)).toHaveLength(0);
      expect(eventsOf(technicianOfB, WEBRTC_OFFER_EVENT)).toHaveLength(0);
      expect(eventsOf(deviceA, WEBRTC_ICE_CANDIDATE_EVENT)).toHaveLength(0);
      expect(eventsOf(technicianOfA, WEBRTC_ICE_CANDIDATE_EVENT)).toHaveLength(
        0,
      );
    });
  });

  describe('signaling no autorizado', () => {
    it('rechaza webrtc:offer sin remote-session:join previo', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(device, SESSION_A_ID);

      expect(await sendOffer(technician, SESSION_A_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.NOT_JOINED,
      });

      await settle();

      expect(eventsOf(device, WEBRTC_OFFER_EVENT)).toHaveLength(0);
    });

    it('rechaza signaling de un dispositivo que no hizo join', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(technician, SESSION_A_ID);

      expect(await sendAnswer(device, SESSION_A_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.NOT_JOINED,
      });

      await settle();

      expect(eventsOf(technician, WEBRTC_ANSWER_EVENT)).toHaveLength(0);
    });

    it('rechaza un remoteSessionId distinto al de la sesion del socket', async () => {
      const technician = await connectTechnician(technicianA);
      const deviceC = await connectDevice(DEVICE_C_ID);

      await join(technician, SESSION_A_ID);
      await join(deviceC, SESSION_C_ID);

      // La sesion C tambien es suya, pero el socket esta unido a la A.
      expect(await sendOffer(technician, SESSION_C_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.NOT_JOINED,
      });

      await settle();

      expect(eventsOf(deviceC, WEBRTC_OFFER_EVENT)).toHaveLength(0);
    });

    it('corta el signaling en cuanto la sesion pasa a CLOSED', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(technician, SESSION_A_ID);
      await join(device, SESSION_A_ID);

      // Primer mensaje con la sesion viva.
      expect(await sendOffer(technician, SESSION_A_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_A_ID,
      });
      await waitForEvent(device, WEBRTC_OFFER_EVENT);

      // La sesion se cierra por REST mientras los sockets siguen abiertos.
      remoteSessions[0].status = RemoteSessionStatus.CLOSED;

      expect(await sendOffer(technician, SESSION_A_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(await sendCandidate(technician, SESSION_A_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });
      expect(await sendAnswer(device, SESSION_A_ID)).toEqual({
        delivered: false,
        error: SignalingErrorCode.UNAUTHORIZED,
      });

      await settle();

      // Solo llego el primero, el de la sesion viva.
      expect(eventsOf(device, WEBRTC_OFFER_EVENT)).toHaveLength(1);
      expect(eventsOf(device, WEBRTC_ICE_CANDIDATE_EVENT)).toHaveLength(0);
      expect(eventsOf(technician, WEBRTC_ANSWER_EVENT)).toHaveLength(0);
    });

    it('rechaza payloads mal formados o desmesurados', async () => {
      const technician = await connectTechnician(technicianA);

      await join(technician, SESSION_A_ID);

      const invalid: SignalingRelayAck = {
        delivered: false,
        error: SignalingErrorCode.INVALID_PAYLOAD,
      };

      // SDP vacia.
      expect(
        await emitWithAck(technician, WEBRTC_OFFER_EVENT, {
          remoteSessionId: SESSION_A_ID,
          sdp: '',
        }),
      ).toEqual(invalid);

      // SDP absurdamente grande.
      expect(
        await emitWithAck(technician, WEBRTC_OFFER_EVENT, {
          remoteSessionId: SESSION_A_ID,
          sdp: 'v'.repeat(40_000),
        }),
      ).toEqual(invalid);

      // Campo no declarado en el DTO.
      expect(
        await emitWithAck(technician, WEBRTC_OFFER_EVENT, {
          remoteSessionId: SESSION_A_ID,
          sdp: SDP,
          deviceId: DEVICE_B_ID,
        }),
      ).toEqual(invalid);

      // Candidato con tipos incorrectos.
      expect(
        await sendCandidate(technician, SESSION_A_ID, {
          candidate: CANDIDATE,
          sdpMLineIndex: 'cero',
        }),
      ).toEqual(invalid);

      // Sin payload.
      expect(await emitWithAck(technician, WEBRTC_OFFER_EVENT, null)).toEqual(
        invalid,
      );
    });
  });

  describe('desconexion y persistencia', () => {
    it('no cierra la sesion cuando un socket se desconecta', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(technician, SESSION_A_ID);
      await join(device, SESSION_A_ID);

      technician.close();

      await settle();

      // La sesion persistida sigue viva: el cliente puede reconectarse y volver
      // a unirse.
      expect(remoteSessions[0].status).toBe(RemoteSessionStatus.CONNECTING);

      const reconnected = await connectTechnician(technicianA);

      expect(await join(reconnected, SESSION_A_ID)).toEqual({
        joined: true,
        remoteSessionId: SESSION_A_ID,
      });

      expect(await sendOffer(reconnected, SESSION_A_ID)).toEqual({
        delivered: true,
        remoteSessionId: SESSION_A_ID,
      });
      await waitForEvent(device, WEBRTC_OFFER_EVENT);
    });

    it('no escribe nada en remote_sessions durante el signaling', async () => {
      const technician = await connectTechnician(technicianA);
      const device = await connectDevice(DEVICE_A_ID);

      await join(technician, SESSION_A_ID);
      await join(device, SESSION_A_ID);

      await sendOffer(technician, SESSION_A_ID);
      await sendAnswer(device, SESSION_A_ID);
      await sendCandidate(technician, SESSION_A_ID);
      await sendCandidate(device, SESSION_A_ID);

      await waitForEvent(device, WEBRTC_OFFER_EVENT);
      await waitForEvent(technician, WEBRTC_ANSWER_EVENT);

      // Ni SDP ni ICE se persisten, y la sesion no cambia de estado.
      expect(writes).toEqual([]);
      expect(remoteSessions[0].status).toBe(RemoteSessionStatus.CONNECTING);
    });
  });
});
