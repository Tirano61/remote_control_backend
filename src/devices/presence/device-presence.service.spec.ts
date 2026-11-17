import { Logger } from '@nestjs/common';
import { TechnicianRealtimeService } from '../../signaling/realtime/technician-realtime.service';
import {
  DEVICE_PRESENCE_UPDATED_EVENT,
  DevicePresenceService,
  PresenceSocket,
} from './device-presence.service';

/**
 * Transiciones de presencia y aviso `device:presence-updated`.
 *
 * El aviso sale solo cuando la presencia EFECTIVA cambia (OFFLINE -> ONLINE al
 * registrar el primer socket, ONLINE -> OFFLINE al quitar el ultimo), una vez
 * por transicion, y siempre con el registro ya actualizado.
 */
const DEVICE_A = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

type TestSocket = PresenceSocket & { disconnect: jest.Mock<void, [boolean?]> };

/** Socket de prueba que, al cerrarse, se comporta como el gateway real. */
const buildSocket = (
  id: string,
  onDisconnect: (socket: PresenceSocket) => void = () => undefined,
): TestSocket => {
  const socket: TestSocket = {
    id,
    disconnect: jest.fn<void, [boolean?]>(),
  };

  socket.disconnect.mockImplementation(() => onDisconnect(socket));

  return socket;
};

describe('DevicePresenceService', () => {
  let presence: DevicePresenceService;
  let emitToAllTechnicians: jest.Mock;

  /** Estado que REST veria en el instante exacto de cada emision. */
  let onlineWhenEmitted: Record<string, boolean>[];

  let logError: jest.SpyInstance;

  const presenceEvents = (): unknown[][] =>
    (emitToAllTechnicians.mock.calls as unknown[][]).filter(
      ([event]) => event === DEVICE_PRESENCE_UPDATED_EVENT,
    );

  beforeEach(() => {
    onlineWhenEmitted = [];

    emitToAllTechnicians = jest.fn(
      (_event: string, payload: { deviceId: string }) => {
        onlineWhenEmitted.push({
          [payload.deviceId]: presence.isOnline(payload.deviceId),
        });
        return true;
      },
    );

    presence = new DevicePresenceService({
      emitToAllTechnicians,
    } as unknown as TechnicianRealtimeService);

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('ONLINE', () => {
    it('primera conexion (0 -> 1): un aviso, y REST ya ve ONLINE al emitir', () => {
      expect(presence.register(DEVICE_A, buildSocket('a'))).toBe(true);

      expect(presenceEvents()).toEqual([
        [DEVICE_PRESENCE_UPDATED_EVENT, { deviceId: DEVICE_A }],
      ]);
      expect(onlineWhenEmitted).toEqual([{ [DEVICE_A]: true }]);
      expect(presence.isOnline(DEVICE_A)).toBe(true);
    });

    it('segunda conexion (1 -> 2): sigue ONLINE y no avisa otra vez', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      emitToAllTechnicians.mockClear();

      expect(presence.register(DEVICE_A, buildSocket('b'))).toBe(false);

      expect(presence.connectionCount(DEVICE_A)).toBe(2);
      expect(emitToAllTechnicians).not.toHaveBeenCalled();
    });

    it('registrar dos veces el mismo socket no avisa dos veces', () => {
      const socket = buildSocket('a');

      presence.register(DEVICE_A, socket);
      presence.register(DEVICE_A, socket);

      expect(presence.connectionCount(DEVICE_A)).toBe(1);
      expect(presenceEvents()).toHaveLength(1);
    });
  });

  describe('OFFLINE', () => {
    it('desconexion parcial (2 -> 1): sigue ONLINE y no avisa', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      presence.register(DEVICE_A, buildSocket('b'));
      emitToAllTechnicians.mockClear();

      expect(presence.unregister(DEVICE_A, 'a')).toBe(false);

      expect(presence.isOnline(DEVICE_A)).toBe(true);
      expect(emitToAllTechnicians).not.toHaveBeenCalled();
    });

    it('ultima desconexion (1 -> 0): un aviso, y REST ya ve OFFLINE al emitir', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      emitToAllTechnicians.mockClear();
      onlineWhenEmitted = [];

      expect(presence.unregister(DEVICE_A, 'a')).toBe(true);

      expect(presenceEvents()).toEqual([
        [DEVICE_PRESENCE_UPDATED_EVENT, { deviceId: DEVICE_A }],
      ]);
      expect(onlineWhenEmitted).toEqual([{ [DEVICE_A]: false }]);
      expect(presence.isOnline(DEVICE_A)).toBe(false);
    });

    it('desconexion duplicada con 0 sockets: no avisa', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      presence.unregister(DEVICE_A, 'a');
      emitToAllTechnicians.mockClear();

      expect(presence.unregister(DEVICE_A, 'a')).toBe(false);
      expect(presence.unregister(DEVICE_A, 'a')).toBe(false);

      expect(emitToAllTechnicians).not.toHaveBeenCalled();
    });

    it('baja de un dispositivo que nunca conecto: no avisa', () => {
      expect(presence.unregister(DEVICE_A, 'fantasma')).toBe(false);
      expect(emitToAllTechnicians).not.toHaveBeenCalled();
    });

    it('baja de un socket desconocido con el dispositivo ONLINE: no avisa ni lo saca', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      emitToAllTechnicians.mockClear();

      expect(presence.unregister(DEVICE_A, 'otro')).toBe(false);

      expect(presence.isOnline(DEVICE_A)).toBe(true);
      expect(emitToAllTechnicians).not.toHaveBeenCalled();
    });
  });

  describe('reconexion', () => {
    it('A conectado, B conecta, A desconecta tarde: sigue ONLINE y sin avisos falsos', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      presence.register(DEVICE_A, buildSocket('b'));
      presence.unregister(DEVICE_A, 'a');

      expect(presence.isOnline(DEVICE_A)).toBe(true);
      // Solo el ONLINE inicial: ni OFFLINE falso ni ONLINE repetido.
      expect(presenceEvents()).toHaveLength(1);

      presence.unregister(DEVICE_A, 'b');

      expect(presenceEvents()).toHaveLength(2);
      expect(onlineWhenEmitted).toEqual([
        { [DEVICE_A]: true },
        { [DEVICE_A]: false },
      ]);
    });

    it('A cae del todo y vuelve como B: OFFLINE y ONLINE, uno de cada', () => {
      presence.register(DEVICE_A, buildSocket('a'));
      presence.unregister(DEVICE_A, 'a');
      presence.register(DEVICE_A, buildSocket('b'));

      expect(onlineWhenEmitted).toEqual([
        { [DEVICE_A]: true },
        { [DEVICE_A]: false },
        { [DEVICE_A]: true },
      ]);
    });
  });

  describe('disconnectDevice (desactivacion y re-enrolamiento)', () => {
    it('ONLINE con dos sockets -> OFFLINE: exactamente un aviso pese a los dos cierres', () => {
      // Como el gateway real: cerrar el socket dispara `handleDisconnect`, que
      // llama a `unregister`.
      const closeLikeGateway = (socket: PresenceSocket) =>
        presence.unregister(DEVICE_A, socket.id);

      const a = buildSocket('a', closeLikeGateway);
      const b = buildSocket('b', closeLikeGateway);

      presence.register(DEVICE_A, a);
      presence.register(DEVICE_A, b);
      emitToAllTechnicians.mockClear();
      onlineWhenEmitted = [];

      expect(presence.disconnectDevice(DEVICE_A)).toBe(2);

      expect(a.disconnect).toHaveBeenCalledWith(true);
      expect(b.disconnect).toHaveBeenCalledWith(true);
      expect(presenceEvents()).toEqual([
        [DEVICE_PRESENCE_UPDATED_EVENT, { deviceId: DEVICE_A }],
      ]);
      expect(onlineWhenEmitted).toEqual([{ [DEVICE_A]: false }]);
    });

    it('dispositivo ya OFFLINE: no cierra nada ni avisa', () => {
      expect(presence.disconnectDevice(DEVICE_A)).toBe(0);
      expect(emitToAllTechnicians).not.toHaveBeenCalled();
    });

    it('re-enrolamiento: OFFLINE por el cierre, disconnect tardio sin efecto, ONLINE con la credencial nueva', () => {
      const old = buildSocket('viejo');

      presence.register(DEVICE_A, old);
      emitToAllTechnicians.mockClear();
      onlineWhenEmitted = [];

      // La activacion confirmada cierra los sockets de la credencial revocada.
      presence.disconnectDevice(DEVICE_A);

      // La tablet reconecta con la credencial nueva antes de que el servidor
      // procese el `disconnect` del socket viejo.
      presence.register(DEVICE_A, buildSocket('nuevo'));
      presence.unregister(DEVICE_A, old.id);

      expect(presence.isOnline(DEVICE_A)).toBe(true);
      expect(onlineWhenEmitted).toEqual([
        { [DEVICE_A]: false },
        { [DEVICE_A]: true },
      ]);

      // Un segundo cierre no repite nada sobre un dispositivo ya OFFLINE.
      presence.disconnectDevice(DEVICE_A);
      presence.disconnectDevice(DEVICE_A);

      expect(onlineWhenEmitted).toEqual([
        { [DEVICE_A]: false },
        { [DEVICE_A]: true },
        { [DEVICE_A]: false },
      ]);
    });
  });

  describe('varios dispositivos', () => {
    it('la presencia de A no produce avisos de B', () => {
      presence.register(DEVICE_B, buildSocket('b1'));
      emitToAllTechnicians.mockClear();

      presence.register(DEVICE_A, buildSocket('a1'));
      presence.register(DEVICE_A, buildSocket('a2'));
      presence.unregister(DEVICE_A, 'a1');
      presence.unregister(DEVICE_A, 'a2');
      presence.disconnectDevice(DEVICE_A);

      expect(presenceEvents()).toEqual([
        [DEVICE_PRESENCE_UPDATED_EVENT, { deviceId: DEVICE_A }],
        [DEVICE_PRESENCE_UPDATED_EVENT, { deviceId: DEVICE_A }],
      ]);
      expect(presence.isOnline(DEVICE_B)).toBe(true);
    });

    it('el mismo id de socket en dos dispositivos no se mezcla', () => {
      presence.register(DEVICE_A, buildSocket('mismo'));
      presence.register(DEVICE_B, buildSocket('mismo'));
      emitToAllTechnicians.mockClear();

      presence.unregister(DEVICE_A, 'mismo');

      expect(presence.isOnline(DEVICE_B)).toBe(true);
      expect(presenceEvents()).toEqual([
        [DEVICE_PRESENCE_UPDATED_EVENT, { deviceId: DEVICE_A }],
      ]);
    });
  });

  describe('payload', () => {
    it('lleva solo el deviceId: ni estado, ni sockets, ni credenciales', () => {
      presence.register(DEVICE_A, buildSocket('socket-secreto'));

      const [[, payload]] = presenceEvents();

      expect(payload).toEqual({ deviceId: DEVICE_A });
      expect(Object.keys(payload as object)).toEqual(['deviceId']);
    });
  });

  describe('si el aviso falla', () => {
    beforeEach(() => {
      emitToAllTechnicians.mockImplementation(() => {
        throw new Error('transporte caido');
      });
    });

    it('register registra igual, no lanza y lo deja en el log', () => {
      expect(presence.register(DEVICE_A, buildSocket('a'))).toBe(true);

      expect(presence.isOnline(DEVICE_A)).toBe(true);
      expect(logError).toHaveBeenCalledTimes(1);
    });

    it('unregister da de baja igual y no lanza', () => {
      presence.register(DEVICE_A, buildSocket('a'));

      expect(presence.unregister(DEVICE_A, 'a')).toBe(true);
      expect(presence.isOnline(DEVICE_A)).toBe(false);
    });

    it('disconnectDevice cierra los sockets igual y no lanza', () => {
      const socket = buildSocket('a');

      presence.register(DEVICE_A, socket);

      expect(presence.disconnectDevice(DEVICE_A)).toBe(1);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(presence.isOnline(DEVICE_A)).toBe(false);
    });
  });

  it('sin transporte de tecnicos (false) la presencia funciona igual', () => {
    emitToAllTechnicians.mockReturnValue(false);

    expect(presence.register(DEVICE_A, buildSocket('a'))).toBe(true);
    expect(presence.unregister(DEVICE_A, 'a')).toBe(true);
    expect(presence.isOnline(DEVICE_A)).toBe(false);
  });
});
