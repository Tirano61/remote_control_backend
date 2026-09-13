import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import {
  DataSource,
  FindOperator,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import {
  ACTIVE_SUPPORT_REQUEST_INDEX,
  SupportRequest,
} from '../support-requests/entities/support-request.entity';
import {
  ACTIVE_SUPPORT_REQUEST_STATUSES,
  SupportRequestStatus,
} from '../support-requests/enums/support-request-status.enum';
import { SupportRequestsService } from '../support-requests/support-requests.service';
import {
  ACTIVE_REMOTE_SESSION_INDEX,
  REMOTE_SESSION_SUPPORT_REQUEST_INDEX,
  RemoteSession,
} from './entities/remote-session.entity';
import { RemoteSessionEndedBy } from './enums/remote-session-ended-by.enum';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from './enums/remote-session-status.enum';
import {
  REMOTE_SESSION_CLOSED_EVENT,
  REMOTE_SESSION_CREATED_EVENT,
  RemoteSessionsService,
} from './remote-sessions.service';

/**
 * Ciclo de vida de una sesion remota.
 *
 * `SupportRequestsService` es el de produccion: las solicitudes se llevan hasta
 * `ACCEPTED` por el flujo real (crear -> asignar -> aceptar) en lugar de
 * fabricar filas a mano, asi el encaje entre los dos dominios queda cubierto.
 *
 * Los repositorios de TypeORM se sustituyen por dobles en memoria que
 * reproducen lo que en produccion garantiza PostgreSQL:
 *
 * - los indices unicos (una sesion por solicitud, una sesion viva por
 *   dispositivo, una solicitud activa por dispositivo), que fallan con
 *   `unique_violation` (23505);
 * - el UPDATE condicionado al estado actual, que devuelve cuantas filas cambio
 *   y es lo que decide los cierres simultaneos.
 *
 * - el lock de fila (`SELECT ... FOR UPDATE`) que serializa abrir una sesion
 *   contra cancelar la solicitud, mediante una cola por id;
 * - el rollback de la transaccion, mediante un registro de deshacer.
 *
 * Lo que NO se prueba aqui es que PostgreSQL cree realmente esos indices ni su
 * semantica real de `FOR UPDATE` entre conexiones distintas: la cola reproduce
 * la INTENCION (quien llega segundo lee lo que dejo el primero), no el
 * aislamiento del motor. Eso hay que validarlo despues contra PostgreSQL.
 */

const DEVICE_A_ID = '550e8400-e29b-41d4-a716-446655440000';
const DEVICE_B_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** unique_violation */
const UNIQUE_VIOLATION = '23505';

const buildDevice = (id: string, publicId: string): Device => ({
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
});

const buildTechnician = (fullName: string): User =>
  ({
    id: randomUUID(),
    email: `${fullName.toLowerCase().replace(/\s/g, '.')}@acme.com`,
    password: 'hash-que-nunca-debe-salir',
    fullName,
    isActive: true,
    roles: [ValidRoles.tecnico],
    created_at: new Date(),
    updated_at: new Date(),
  }) as User;

/** Catalogos que resuelven las relaciones, como haria TypeORM. */
const devices: Record<string, Device> = {};
const technicians: Record<string, User> = {};

type WhereValue = string | FindOperator<string>;
type Row = SupportRequest | RemoteSession;

/** Deshace un cambio hecho dentro de una transaccion que acabo fallando. */
type UndoStep = () => void;

/** Estado vivo de una transaccion del doble de `DataSource`. */
interface TransactionScope {
  undo: UndoStep[];
  releases: (() => void)[];
}

/**
 * Locks de fila por id, en lugar de `SELECT ... FOR UPDATE`.
 *
 * Las transacciones se encolan en el orden en que piden la fila y la siguiente
 * no continua hasta que la anterior termina. Es lo que permite escribir la
 * carrera `cancel` contra `create` sin PostgreSQL.
 */
class RowLocks {
  private readonly tails = new Map<string, Promise<void>>();

  /** Espera el turno de la fila y devuelve la funcion que la libera. */
  async acquire(id: string): Promise<() => void> {
    const previous = this.tails.get(id) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // La cola se encadena antes de esperar: el orden lo fija quien pide antes.
    this.tails.set(
      id,
      previous.then(() => held),
    );

    await previous;

    return release;
  }
}

const uniqueViolation = (constraint: string): QueryFailedError =>
  new QueryFailedError('INSERT', [], {
    code: UNIQUE_VIOLATION,
    constraint,
  } as unknown as Error);

const matches = (row: Row, where: Record<string, WhereValue>): boolean =>
  Object.entries(where).every(([key, expected]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];

    if (expected instanceof FindOperator)
      return (expected.value as unknown as string[]).includes(actual as string);

    return actual === expected;
  });

/**
 * Cadena `update/set/where/andWhere/execute`, la unica que usan las
 * transiciones. La condicion se evalua al ejecutar, no al construir: es lo que
 * hace que dos transiciones simultaneas no puedan aplicarse las dos.
 */
const createUpdateBuilder = (
  resolveRows: (entity: unknown) => Row[],
  undo?: UndoStep[],
) => {
  let rows: Row[] = [];
  let changes: Record<string, unknown> = {};
  const params: Record<string, unknown> = {};

  const builder = {
    update: (entity: unknown) => {
      rows = resolveRows(entity);
      return builder;
    },
    set: (values: Record<string, unknown>) => {
      changes = values;
      return builder;
    },
    where: (_sql: string, parameters: Record<string, unknown>) => {
      Object.assign(params, parameters);
      return builder;
    },
    andWhere: (_sql: string, parameters: Record<string, unknown>) => {
      Object.assign(params, parameters);
      return builder;
    },
    execute: () => {
      const from = params.from as string[];
      const row = rows.find(
        (candidate) =>
          candidate.id === params.id && from.includes(candidate.status),
      );

      if (!row) return Promise.resolve({ affected: 0 });

      const previous = { ...row };

      undo?.push(() => Object.assign(row, previous));

      Object.assign(row, changes);

      return Promise.resolve({ affected: 1 });
    },
  };

  return builder;
};

/** Reproduce el indice unico parcial de solicitud activa por dispositivo. */
class FakeSupportRequestRepository {
  readonly rows: SupportRequest[] = [];

  create(partial: Partial<SupportRequest>): SupportRequest {
    return { ...partial } as SupportRequest;
  }

  save(entity: SupportRequest): Promise<SupportRequest> {
    const hasActive = this.rows.some(
      (row) =>
        row.deviceId === entity.deviceId &&
        row.id !== entity.id &&
        ACTIVE_SUPPORT_REQUEST_STATUSES.includes(row.status),
    );

    if (hasActive && ACTIVE_SUPPORT_REQUEST_STATUSES.includes(entity.status))
      return Promise.reject(uniqueViolation(ACTIVE_SUPPORT_REQUEST_INDEX));

    const row: SupportRequest = {
      ...entity,
      id: entity.id ?? randomUUID(),
      createdAt: entity.createdAt ?? new Date(),
    };

    this.rows.push(row);

    return Promise.resolve({ ...row });
  }

  findOne(options: {
    where: Record<string, WhereValue>;
    relations?: Record<string, boolean>;
  }): Promise<SupportRequest | null> {
    const row = this.rows.find((candidate) =>
      matches(candidate, options.where),
    );

    if (!row) return Promise.resolve(null);

    const hydrated: SupportRequest = { ...row };

    if (options.relations?.device) hydrated.device = devices[row.deviceId];

    if (options.relations?.technician)
      hydrated.technician = row.technicianId
        ? technicians[row.technicianId]
        : null;

    return Promise.resolve(hydrated);
  }

  createQueryBuilder() {
    return createUpdateBuilder(() => this.rows);
  }
}

/** Reproduce las dos unicidades de `remote_sessions`. */
class FakeRemoteSessionRepository {
  readonly rows: RemoteSession[] = [];

  create(partial: Partial<RemoteSession>): RemoteSession {
    return { ...partial } as RemoteSession;
  }

  save(entity: RemoteSession): Promise<RemoteSession> {
    const others = this.rows.filter((row) => row.id !== entity.id);

    if (others.some((row) => row.supportRequestId === entity.supportRequestId))
      return Promise.reject(
        uniqueViolation(REMOTE_SESSION_SUPPORT_REQUEST_INDEX),
      );

    const deviceIsBusy = others.some(
      (row) =>
        row.deviceId === entity.deviceId &&
        ACTIVE_REMOTE_SESSION_STATUSES.includes(row.status),
    );

    if (deviceIsBusy && ACTIVE_REMOTE_SESSION_STATUSES.includes(entity.status))
      return Promise.reject(uniqueViolation(ACTIVE_REMOTE_SESSION_INDEX));

    const row: RemoteSession = {
      ...entity,
      id: entity.id ?? randomUUID(),
      createdAt: entity.createdAt ?? new Date(),
    };

    this.rows.push(row);

    return Promise.resolve({ ...row });
  }

  findOne(options: {
    where: Record<string, WhereValue>;
    relations?: Record<string, boolean>;
  }): Promise<RemoteSession | null> {
    const row = this.rows.find((candidate) =>
      matches(candidate, options.where),
    );

    if (!row) return Promise.resolve(null);

    const hydrated: RemoteSession = { ...row };

    if (options.relations?.device) hydrated.device = devices[row.deviceId];

    if (options.relations?.technician)
      hydrated.technician = technicians[row.technicianId];

    return Promise.resolve(hydrated);
  }

  /** Lo usa la cancelacion para saber si la solicitud ya tiene sesion viva. */
  exists(options: { where: Record<string, WhereValue> }): Promise<boolean> {
    return Promise.resolve(
      this.rows.some((candidate) => matches(candidate, options.where)),
    );
  }
}

describe('RemoteSessionsService', () => {
  let service: RemoteSessionsService;
  let supportRequestsService: SupportRequestsService;
  let remoteSessions: FakeRemoteSessionRepository;
  let supportRequests: FakeSupportRequestRepository;
  let emitToDevice: jest.Mock;
  let online: Set<string>;

  let deviceA: Device;
  let deviceB: Device;
  let technicianA: User;
  let technicianB: User;

  /** Lleva una solicitud nueva hasta ACCEPTED por el flujo real. */
  const seedAcceptedRequest = async (
    device: Device,
    technician: User = technicianA,
  ): Promise<string> => {
    const { id } = await supportRequestsService.createForDevice(device);

    await supportRequestsService.assign(id, technician);
    await supportRequestsService.acceptByDevice(id, device);

    emitToDevice.mockClear();

    return id;
  };

  /** Solicitud ACCEPTED + sesion CONNECTING para `deviceA` / `technicianA`. */
  const seedSession = async (): Promise<{
    supportRequestId: string;
    remoteSessionId: string;
  }> => {
    const supportRequestId = await seedAcceptedRequest(deviceA);

    const { id } = await service.create({ supportRequestId }, technicianA);

    emitToDevice.mockClear();

    return { supportRequestId, remoteSessionId: id };
  };

  const sessionRow = (id: string): RemoteSession =>
    remoteSessions.rows.find((row) => row.id === id) as RemoteSession;

  const requestRow = (id: string): SupportRequest =>
    supportRequests.rows.find((row) => row.id === id) as SupportRequest;

  beforeEach(async () => {
    deviceA = buildDevice(DEVICE_A_ID, '384-729-142');
    deviceB = buildDevice(DEVICE_B_ID, '111-222-333');
    technicianA = buildTechnician('Ana Tecnica');
    technicianB = buildTechnician('Bruno Tecnico');

    for (const key of Object.keys(devices)) delete devices[key];
    for (const key of Object.keys(technicians)) delete technicians[key];

    devices[deviceA.id] = deviceA;
    devices[deviceB.id] = deviceB;
    technicians[technicianA.id] = technicianA;
    technicians[technicianB.id] = technicianB;

    remoteSessions = new FakeRemoteSessionRepository();
    supportRequests = new FakeSupportRequestRepository();
    emitToDevice = jest.fn().mockReturnValue(true);
    online = new Set<string>([deviceA.id, deviceB.id]);

    const rowLocks = new RowLocks();

    /**
     * `EntityManager` con lo justo que usan los dos servicios.
     *
     * Sin `scope` es el manager suelto del `DataSource` (transiciones que no
     * abren transaccion); con `scope` es el de una transaccion: pide los locks
     * y anota como deshacer cada escritura.
     */
    const buildManager = (scope?: TransactionScope) => ({
      createQueryBuilder: () =>
        createUpdateBuilder(
          (entity) =>
            entity === RemoteSession
              ? remoteSessions.rows
              : supportRequests.rows,
          scope?.undo,
        ),

      findOne: async (
        entity: unknown,
        options: {
          where: Record<string, WhereValue>;
          relations?: Record<string, boolean>;
          lock?: { mode: string };
        },
      ) => {
        // La fila se lee DESPUES de obtener el lock, igual que hace PostgreSQL
        // al reevaluar la fila bloqueada: quien espera ve lo que dejo el otro.
        if (options.lock)
          scope?.releases.push(
            await rowLocks.acquire(options.where.id as string),
          );

        return entity === RemoteSession
          ? remoteSessions.findOne(options)
          : supportRequests.findOne(options);
      },

      findOneByOrFail: (_entity: unknown, where: { id: string }) =>
        Promise.resolve(devices[where.id]),

      save: async (_entity: unknown, remoteSession: RemoteSession) => {
        const saved = await remoteSessions.save(remoteSession);

        scope?.undo.push(() => {
          const index = remoteSessions.rows.findIndex(
            (row) => row.id === saved.id,
          );

          if (index >= 0) remoteSessions.rows.splice(index, 1);
        });

        return saved;
      },

      exists: (
        _entity: unknown,
        options: { where: Record<string, WhereValue> },
      ) => remoteSessions.exists(options),
    });

    /** Commit o rollback, y siempre la liberacion de los locks al terminar. */
    const transaction = async (
      runInTransaction: (manager: unknown) => Promise<unknown>,
    ) => {
      const scope: TransactionScope = { undo: [], releases: [] };

      try {
        return await runInTransaction(buildManager(scope));
      } catch (error) {
        scope.undo.reverse().forEach((step) => step());

        throw error;
      } finally {
        scope.releases.forEach((release) => release());
      }
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RemoteSessionsService,
        SupportRequestsService,
        {
          provide: getRepositoryToken(RemoteSession),
          useValue: remoteSessions as unknown as Repository<RemoteSession>,
        },
        {
          provide: getRepositoryToken(SupportRequest),
          useValue: supportRequests as unknown as Repository<SupportRequest>,
        },
        {
          provide: DataSource,
          useValue: { manager: buildManager(), transaction },
        },
        {
          provide: DevicePresenceService,
          useValue: { isOnline: (deviceId: string) => online.has(deviceId) },
        },
        { provide: DeviceRealtimeService, useValue: { emitToDevice } },
      ],
    }).compile();

    service = moduleRef.get(RemoteSessionsService);
    supportRequestsService = moduleRef.get(SupportRequestsService);
  });

  describe('creacion por el tecnico', () => {
    it('crea la sesion en CONNECTING, sin conectar y sin cerrar', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      const created = await service.create({ supportRequestId }, technicianA);

      expect(created).toMatchObject({
        supportRequestId,
        status: RemoteSessionStatus.CONNECTING,
        connectedAt: null,
        endedAt: null,
        endedBy: null,
        device: {
          id: deviceA.id,
          publicId: deviceA.publicId,
          name: deviceA.name,
          isOnline: true,
        },
        technician: { id: technicianA.id, name: technicianA.fullName },
      });
      expect(created.id).toEqual(expect.any(String));
      expect(created.createdAt).toBeInstanceOf(Date);

      // El tecnico y el dispositivo salen de la solicitud y del token.
      expect(sessionRow(created.id)).toMatchObject({
        deviceId: deviceA.id,
        technicianId: technicianA.id,
      });
    });

    it('no publica datos sensibles del tecnico', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      const created = await service.create({ supportRequestId }, technicianA);

      expect(created.technician).not.toHaveProperty('email');
      expect(created.technician).not.toHaveProperty('roles');
      expect(created.technician).not.toHaveProperty('password');
    });

    it('deja la solicitud como estaba: solo cambia al cerrarse la sesion', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      await service.create({ supportRequestId }, technicianA);

      expect(requestRow(supportRequestId)).toMatchObject({
        status: SupportRequestStatus.ACCEPTED,
        closedAt: null,
      });
    });

    it.each([
      SupportRequestStatus.WAITING,
      SupportRequestStatus.ASSIGNED,
      SupportRequestStatus.REJECTED,
      SupportRequestStatus.CANCELLED,
      SupportRequestStatus.COMPLETED,
    ])('no crea sesion sobre una solicitud en %s', async (status) => {
      const supportRequestId = await seedAcceptedRequest(deviceA);
      requestRow(supportRequestId).status = status;

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(remoteSessions.rows).toHaveLength(0);
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('responde 404 sobre una solicitud que todavia no tiene tecnico', async () => {
      const { id } = await supportRequestsService.createForDevice(deviceA);

      await expect(
        service.create({ supportRequestId: id }, technicianA),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(remoteSessions.rows).toHaveLength(0);
    });

    it('responde 404 a un tecnico que no es el asignado', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA, technicianA);

      // 404 y no 403: conocer el UUID de una asistencia ajena no debe siquiera
      // confirmar que existe.
      await expect(
        service.create({ supportRequestId }, technicianB),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(remoteSessions.rows).toHaveLength(0);
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
    });

    it('responde 404 con un supportRequestId que no existe', async () => {
      await expect(
        service.create({ supportRequestId: randomUUID() }, technicianA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza con 409 si el dispositivo esta OFFLINE y no toca la solicitud', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);
      online.delete(deviceA.id);

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(remoteSessions.rows).toHaveLength(0);
      // Sigue ACCEPTED para que el tecnico reintente al reconectarse la tablet.
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('crea una sola sesion cuando dos peticiones simultaneas usan la misma solicitud', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      const results = await Promise.allSettled([
        service.create({ supportRequestId }, technicianA),
        service.create({ supportRequestId }, technicianA),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);

      const rejected = results.filter((result) => result.status === 'rejected');

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(remoteSessions.rows).toHaveLength(1);
      expect(emitToDevice).toHaveBeenCalledTimes(1);
    });

    it('no abre una segunda sesion viva para el mismo dispositivo', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      // Con la sesion viva, la API ya no deja cancelar. Se fuerza el estado a
      // mano solo para liberar el indice de solicitud activa y comprobar que el
      // de sesion viva por dispositivo sigue siendo la segunda linea de defensa.
      requestRow(supportRequestId).status = SupportRequestStatus.CANCELLED;

      const second = await seedAcceptedRequest(deviceA);

      await expect(
        service.create({ supportRequestId: second }, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(remoteSessions.rows).toHaveLength(1);
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });

    it('permite una sesion nueva cuando la anterior quedo cerrada', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByTechnician(remoteSessionId, technicianA);

      const supportRequestId = await seedAcceptedRequest(deviceA);

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });
    });

    it('no bloquea a un dispositivo por la sesion viva de otro', async () => {
      await seedSession();

      const supportRequestId = await seedAcceptedRequest(deviceB, technicianB);

      await expect(
        service.create({ supportRequestId }, technicianB),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });
    });
  });

  describe('remote-session:created', () => {
    it('avisa solo al dispositivo de la sesion y con datos minimos', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      const created = await service.create({ supportRequestId }, technicianA);

      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToDevice).toHaveBeenCalledWith(
        deviceA.id,
        REMOTE_SESSION_CREATED_EVENT,
        {
          remoteSessionId: created.id,
          supportRequestId,
          technician: { id: technicianA.id, name: technicianA.fullName },
        },
      );

      const [, , payload] = emitToDevice.mock.calls[0] as [
        string,
        string,
        { technician: Record<string, unknown> },
      ];

      expect(payload.technician).not.toHaveProperty('email');
      expect(payload.technician).not.toHaveProperty('roles');
      expect(payload.technician).not.toHaveProperty('password');
    });

    it('mantiene la sesion aunque la tablet ya no reciba el aviso', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      // La tablet se desconecto justo despues de comprobar la presencia.
      emitToDevice.mockReturnValue(false);

      const created = await service.create({ supportRequestId }, technicianA);

      // La sesion sigue siendo valida: la tablet la recupera por REST.
      expect(sessionRow(created.id).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });
  });

  describe('sesion actual del dispositivo', () => {
    it('devuelve remoteSession: null cuando no hay ninguna viva', async () => {
      await expect(service.findCurrentForDevice(deviceA.id)).resolves.toEqual({
        remoteSession: null,
      });
    });

    it('devuelve la sesion viva del propio dispositivo', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const { remoteSession } = await service.findCurrentForDevice(deviceA.id);

      expect(remoteSession).toMatchObject({
        id: remoteSessionId,
        supportRequestId,
        status: RemoteSessionStatus.CONNECTING,
        technician: { id: technicianA.id, name: technicianA.fullName },
        device: { id: deviceA.id, publicId: deviceA.publicId },
      });
    });

    it('no devuelve la sesion de otro dispositivo', async () => {
      await seedSession();

      await expect(service.findCurrentForDevice(deviceB.id)).resolves.toEqual({
        remoteSession: null,
      });
    });

    it('deja de devolverla cuando la sesion se cierra', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByDevice(remoteSessionId, deviceA);

      await expect(service.findCurrentForDevice(deviceA.id)).resolves.toEqual({
        remoteSession: null,
      });
    });

    it('calcula isOnline en el momento, sin persistirlo', async () => {
      await seedSession();
      online.delete(deviceA.id);

      const { remoteSession } = await service.findCurrentForDevice(deviceA.id);

      expect(remoteSession?.device.isOnline).toBe(false);
      expect(remoteSessions.rows[0]).not.toHaveProperty('isOnline');
    });
  });

  describe('consulta del tecnico', () => {
    it('devuelve la sesion a su tecnico', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.findOneForTechnician(remoteSessionId, technicianA),
      ).resolves.toMatchObject({ id: remoteSessionId });
    });

    it('responde 404 a un tecnico que no es el de la sesion', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.findOneForTechnician(remoteSessionId, technicianB),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('responde 404 con un id que no existe', async () => {
      await expect(
        service.findOneForTechnician(randomUUID(), technicianA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cierre desde el tecnico', () => {
    it('cierra la sesion y completa la solicitud', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const before = requestRow(supportRequestId);
      const respondedAt = before.respondedAt;
      const assignedAt = before.assignedAt;

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(closed).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
        connectedAt: null,
      });
      expect(closed.endedAt).toBeInstanceOf(Date);

      const request = requestRow(supportRequestId);

      expect(request.status).toBe(SupportRequestStatus.COMPLETED);
      expect(request.closedAt).toBeInstanceOf(Date);
      // El historial de la solicitud no se reescribe.
      expect(request.respondedAt).toBe(respondedAt);
      expect(request.assignedAt).toBe(assignedAt);
      expect(request.technicianId).toBe(technicianA.id);
    });

    it('avisa a la tablet con remote-session:closed', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByTechnician(remoteSessionId, technicianA);

      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToDevice).toHaveBeenCalledWith(
        deviceA.id,
        REMOTE_SESSION_CLOSED_EVENT,
        {
          remoteSessionId,
          endedBy: RemoteSessionEndedBy.TECHNICIAN,
        },
      );
    });

    it('responde 404 a otro tecnico y no cierra nada', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.closeByTechnician(remoteSessionId, technicianB),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('responde 409 al cerrar dos veces, sin alterar el primer cierre', async () => {
      const { remoteSessionId } = await seedSession();

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(sessionRow(remoteSessionId).endedAt).toEqual(closed.endedAt);
    });
  });

  describe('cierre desde el dispositivo', () => {
    it('cierra la sesion y completa la solicitud', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const closed = await service.closeByDevice(remoteSessionId, deviceA);

      expect(closed).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.DEVICE,
      });
      expect(closed.endedAt).toBeInstanceOf(Date);
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });

    it('no reenvia el evento a quien acaba de cerrar', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByDevice(remoteSessionId, deviceA);

      // La tablet ya recibe la sesion cerrada en la respuesta HTTP.
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('responde 404 a otro dispositivo y no cierra nada', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.closeByDevice(remoteSessionId, deviceB),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });
  });

  describe('cierre concurrente', () => {
    it('deja un unico cierre cuando tecnico y dispositivo coinciden', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const results = await Promise.allSettled([
        service.closeByTechnician(remoteSessionId, technicianA),
        service.closeByDevice(remoteSessionId, deviceA),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      const winner = (
        fulfilled[0] as PromiseFulfilledResult<{
          endedBy: RemoteSessionEndedBy | null;
          endedAt: Date | null;
        }>
      ).value;

      const row = sessionRow(remoteSessionId);

      expect(row.status).toBe(RemoteSessionStatus.CLOSED);
      expect(row.endedBy).toBe(winner.endedBy);
      expect(row.endedAt).toEqual(winner.endedAt);
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });
  });

  describe('cancelar la solicitud con la asistencia ya iniciada', () => {
    it('cancela mientras no exista sesion remota', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      await expect(
        supportRequestsService.cancelByDevice(supportRequestId, deviceA),
      ).resolves.toMatchObject({ status: SupportRequestStatus.CANCELLED });

      expect(remoteSessions.rows).toHaveLength(0);
    });

    it('responde 409 con la sesion en CONNECTING y no toca nada', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      await expect(
        supportRequestsService.cancelByDevice(supportRequestId, deviceA),
      ).rejects.toBeInstanceOf(ConflictException);

      // La asistencia ya empezo: se termina cerrando la sesion.
      expect(requestRow(supportRequestId)).toMatchObject({
        status: SupportRequestStatus.ACCEPTED,
        closedAt: null,
      });
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });

    it('responde 409 tambien con la sesion en ACTIVE', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      // Todavia no hay endpoint que produzca ACTIVE: llega con el signaling.
      sessionRow(remoteSessionId).status = RemoteSessionStatus.ACTIVE;

      await expect(
        supportRequestsService.cancelByDevice(supportRequestId, deviceA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
    });

    it('cerrar la sesion es la salida del usuario', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      await service.closeByDevice(remoteSessionId, deviceA);

      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });
  });

  describe('carrera entre cancelar y abrir la sesion', () => {
    /** La invariante del prompt: nunca CANCELLED con una sesion viva. */
    const expectConsistent = (supportRequestId: string): void => {
      const cancelled =
        requestRow(supportRequestId).status === SupportRequestStatus.CANCELLED;

      const live = remoteSessions.rows.some(
        (row) =>
          row.supportRequestId === supportRequestId &&
          ACTIVE_REMOTE_SESSION_STATUSES.includes(row.status),
      );

      expect(cancelled && live).toBe(false);
    };

    it('gana la cancelacion: solicitud CANCELLED y ninguna sesion', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      // Quien pide antes la fila obtiene antes el lock; el otro espera y lee
      // despues el estado que dejo el primero.
      const cancel = supportRequestsService.cancelByDevice(
        supportRequestId,
        deviceA,
      );
      const create = service.create({ supportRequestId }, technicianA);

      await expect(cancel).resolves.toMatchObject({
        status: SupportRequestStatus.CANCELLED,
      });
      await expect(create).rejects.toBeInstanceOf(ConflictException);

      expect(remoteSessions.rows).toHaveLength(0);
      expect(emitToDevice).not.toHaveBeenCalled();
      expectConsistent(supportRequestId);
    });

    it('gana la creacion: sesion CONNECTING y la cancelacion responde 409', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      const create = service.create({ supportRequestId }, technicianA);
      const cancel = supportRequestsService.cancelByDevice(
        supportRequestId,
        deviceA,
      );

      await expect(create).resolves.toMatchObject({
        status: RemoteSessionStatus.CONNECTING,
      });
      await expect(cancel).rejects.toBeInstanceOf(ConflictException);

      expect(requestRow(supportRequestId)).toMatchObject({
        status: SupportRequestStatus.ACCEPTED,
        closedAt: null,
      });
      expect(remoteSessions.rows).toHaveLength(1);
      expect(remoteSessions.rows[0].status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expectConsistent(supportRequestId);
    });
  });

  describe('cierre sobre un estado inconsistente', () => {
    it('aborta el cierre si la solicitud no puede pasar a COMPLETED', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      // Estado que las APIs ya no pueden producir: se fabrica a mano para
      // comprobar que el cierre no lo da por bueno.
      requestRow(supportRequestId).status = SupportRequestStatus.CANCELLED;

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      // Rollback completo: la sesion no queda CLOSED a medias.
      expect(sessionRow(remoteSessionId)).toMatchObject({
        status: RemoteSessionStatus.CONNECTING,
        endedAt: null,
        endedBy: null,
      });
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.CANCELLED,
      );
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('tampoco deja cerrar al dispositivo', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      requestRow(supportRequestId).status = SupportRequestStatus.CANCELLED;

      await expect(
        service.closeByDevice(remoteSessionId, deviceA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });
  });

  describe('despues de la asistencia', () => {
    it('el dispositivo puede abrir una solicitud nueva', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByTechnician(remoteSessionId, technicianA);

      // COMPLETED es terminal: deja de contar como solicitud activa.
      await expect(
        supportRequestsService.createForDevice(deviceA),
      ).resolves.toMatchObject({ status: SupportRequestStatus.WAITING });
    });

    it('la solicitud completada ya no aparece como activa', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByTechnician(remoteSessionId, technicianA);

      await expect(
        supportRequestsService.findCurrentForDevice(deviceA.id),
      ).resolves.toEqual({ supportRequest: null });
    });
  });
});
