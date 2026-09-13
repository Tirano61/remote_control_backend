import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { Namespace } from 'socket.io';
import { io, Socket as ClientSocket } from 'socket.io-client';
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
import {
  DeviceRealtimeService,
  deviceRoom,
} from '../realtime/device-realtime.service';
import {
  DEVICE_CONNECTED_EVENT,
  DEVICES_NAMESPACE,
  DevicesGateway,
} from './devices.gateway';

/**
 * Conexiones Socket.IO reales contra la aplicacion.
 *
 * El gateway, la autenticacion del Device JWT (firma incluida) y la presencia
 * son los de produccion; solo se sustituyen los repositorios de TypeORM por
 * dobles en memoria, porque estas pruebas no necesitan PostgreSQL.
 */
jest.setTimeout(20_000);

const DEVICE_JWT_SECRET = 'device-secret-for-tests';
const USER_JWT_SECRET = 'user-secret-for-tests';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';
const PUBLIC_ID = '384-729-142';
const CREDENTIAL_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('DevicesGateway (Socket.IO)', () => {
  let app: INestApplication;
  let url: string;
  let namespace: Namespace;
  let presence: DevicePresenceService;
  let devicesService: DevicesService;
  let deviceJwt: JwtService;
  let userJwt: JwtService;

  /** Estado en memoria que reemplaza a PostgreSQL. */
  let device: Device;
  let activeCredentialId: string | null;

  const openClients: ClientSocket[] = [];

  /** Confirmaciones recibidas, guardadas desde que se crea cada socket. */
  const confirmations = new WeakMap<ClientSocket, Record<string, unknown>>();

  const deviceRepository = {
    findOneBy: ({ id }: { id: string }) =>
      Promise.resolve(id === device.id ? device : null),
    find: () => Promise.resolve([device]),
    preload: ({ id, ...changes }: Partial<Device> & { id: string }) =>
      Promise.resolve(
        id === device.id ? ({ ...device, ...changes } as Device) : undefined,
      ),
    save: (updated: Device) => {
      device = { ...device, ...updated };
      return Promise.resolve(device);
    },
  };

  const deviceCredentialRepository = {
    findOne: ({ where }: { where: { deviceId: string } }) =>
      Promise.resolve(
        activeCredentialId && where.deviceId === device.id
          ? { id: activeCredentialId, deviceId: device.id, secretHash: 'hash' }
          : null,
      ),
    update: () => Promise.resolve({ affected: 1 }),
  };

  const signDeviceToken = (payload: Partial<DeviceJwtPayload> = {}): string =>
    deviceJwt.sign({
      sub: DEVICE_ID,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId: CREDENTIAL_ID,
      ...payload,
    });

  /** Abre un socket real y resuelve solo si el servidor acepta la conexion. */
  const connect = (auth?: Record<string, unknown>): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = io(url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth,
      });

      openClients.push(client);

      // Se escucha antes de que la conexion se establezca: el servidor confirma
      // en cuanto acepta el socket y el evento puede llegar junto al `connect`.
      client.on(DEVICE_CONNECTED_EVENT, (payload: Record<string, unknown>) =>
        confirmations.set(client, payload),
      );

      client.once('connect', () => resolve(client));
      client.once('connect_error', (error: Error) => reject(error));
    });

  /** Espera a que el servidor termine de procesar el evento correspondiente. */
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

  const waitForConfirmation = async (
    client: ClientSocket,
  ): Promise<Record<string, unknown> | undefined> => {
    await waitFor(
      () => confirmations.has(client),
      `confirmacion ${DEVICE_CONNECTED_EVENT}`,
    );

    return confirmations.get(client);
  };

  const waitForDisconnect = (client: ClientSocket): Promise<string> =>
    new Promise((resolve) => client.once('disconnect', resolve));

  beforeAll(async () => {
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
        { provide: getRepositoryToken(Device), useValue: deviceRepository },
        {
          provide: getRepositoryToken(DeviceCredential),
          useValue: deviceCredentialRepository,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();

    presence = app.get(DevicePresenceService);
    devicesService = app.get(DevicesService);
    deviceJwt = app.get(JwtService);
    userJwt = new JwtService({ secret: USER_JWT_SECRET });

    // El namespace solo lo conoce el gateway: se intercepta la inicializacion
    // para capturarlo y poder comprobar desde fuera en que room quedo cada
    // socket. Despues de capturarlo corre el `afterInit` real, que es quien
    // registra el middleware de autenticacion.
    const gateway = app.get(DevicesGateway);
    const afterInit = jest.spyOn(gateway, 'afterInit');

    afterInit.mockImplementation((initialized) => {
      namespace = initialized;
      afterInit.mockRestore();
      gateway.afterInit(initialized);
    });

    await app.listen(0);

    const httpServer = app.getHttpServer() as Server;
    const { port } = httpServer.address() as AddressInfo;
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
  });

  afterEach(async () => {
    while (openClients.length > 0) openClients.pop()?.close();

    await waitFor(
      () => presence.connectionCount(DEVICE_ID) === 0,
      'presencia vacia entre pruebas',
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('acepta un Device JWT valido, lo une a su room y lo marca ONLINE', async () => {
    const client = await connect({ token: signDeviceToken() });

    expect(await waitForConfirmation(client)).toEqual({
      deviceId: DEVICE_ID,
      publicId: PUBLIC_ID,
    });

    await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');

    const inRoom = await namespace.in(deviceRoom(DEVICE_ID)).fetchSockets();

    expect(inRoom).toHaveLength(1);
    expect(inRoom[0].id).toBe(client.id);
  });

  it('rechaza un token invalido y no registra presencia', async () => {
    await expect(connect({ token: 'not-a-jwt' })).rejects.toThrow(
      'Unauthorized',
    );

    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });

  it('rechaza un JWT de usuario/tecnico', async () => {
    const userToken = userJwt.sign({ id: 'a-user-id', email: 'tech@acme.com' });

    await expect(connect({ token: userToken })).rejects.toThrow('Unauthorized');

    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });

  it('rechaza una conexion sin token', async () => {
    await expect(connect()).rejects.toThrow('Unauthorized');

    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });

  it('rechaza un token cuya credencial ya no es la vigente', async () => {
    activeCredentialId = 'b1f6d2f4-1f4a-4a2e-9d6e-2a0f7a5c9d31';

    await expect(connect({ token: signDeviceToken() })).rejects.toThrow(
      'Unauthorized',
    );

    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });

  it('rechaza un dispositivo administrativamente inactivo', async () => {
    device = { ...device, isActive: false };

    await expect(connect({ token: signDeviceToken() })).rejects.toThrow(
      'Unauthorized',
    );

    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });

  it('pasa a OFFLINE cuando se desconecta el unico socket', async () => {
    const client = await connect({ token: signDeviceToken() });

    await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');

    client.close();

    await waitFor(() => !presence.isOnline(DEVICE_ID), 'dispositivo OFFLINE');
  });

  it('sigue ONLINE mientras quede alguna de sus conexiones', async () => {
    const socketA = await connect({ token: signDeviceToken() });
    const socketB = await connect({ token: signDeviceToken() });

    await waitFor(
      () => presence.connectionCount(DEVICE_ID) === 2,
      'dos sockets registrados',
    );

    socketA.close();

    await waitFor(
      () => presence.connectionCount(DEVICE_ID) === 1,
      'socket A dado de baja',
    );
    expect(presence.isOnline(DEVICE_ID)).toBe(true);

    socketB.close();

    await waitFor(() => !presence.isOnline(DEVICE_ID), 'dispositivo OFFLINE');
  });

  it('expone isOnline en la API administrativa, separado de isActive', async () => {
    expect(await devicesService.findOne(DEVICE_ID)).toMatchObject({
      publicId: PUBLIC_ID,
      isActive: true,
      isOnline: false,
    });

    const client = await connect({ token: signDeviceToken() });
    await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');

    expect(await devicesService.findOne(DEVICE_ID)).toMatchObject({
      isActive: true,
      isOnline: true,
    });

    const [listed] = await devicesService.findAll();
    expect(listed).toMatchObject({ id: DEVICE_ID, isOnline: true });

    client.close();
  });

  it('cierra las conexiones abiertas al desactivar el dispositivo', async () => {
    const client = await connect({ token: signDeviceToken() });

    await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');

    const disconnected = waitForDisconnect(client);

    const updated = await devicesService.update(DEVICE_ID, { isActive: false });

    expect(updated).toMatchObject({ isActive: false, isOnline: false });
    expect(await disconnected).toBe('io server disconnect');
    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });

  it('cierra las conexiones cuando se revoca la credencial (re-enrolamiento)', async () => {
    const client = await connect({ token: signDeviceToken() });

    await waitFor(() => presence.isOnline(DEVICE_ID), 'dispositivo ONLINE');

    // Mismo mecanismo que usa el enrolamiento al emitir una credencial nueva.
    expect(presence.disconnectDevice(DEVICE_ID)).toBe(1);

    expect(await waitForDisconnect(client)).toBe('io server disconnect');
    expect(presence.isOnline(DEVICE_ID)).toBe(false);
  });
});
