import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
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
import { TechnicianRealtimeService } from '../signaling/realtime/technician-realtime.service';
import { SupportRequestsService } from '../support-requests/support-requests.service';
import {
  ACTIVE_REMOTE_SESSION_INDEX,
  ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX,
  REMOTE_SESSION_SUPPORT_REQUEST_INDEX,
  RemoteSession,
} from './entities/remote-session.entity';
import { RemoteSessionEndedBy } from './enums/remote-session-ended-by.enum';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from './enums/remote-session-status.enum';
import {
  REMOTE_SESSION_ACTIVE_EVENT,
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
 *   dispositivo, una sesion viva por tecnico, una solicitud activa por
 *   dispositivo), que fallan con `unique_violation` (23505);
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

const buildTechnician = (
  fullName: string,
  roles: ValidRoles[] = [ValidRoles.tecnico],
): User =>
  ({
    id: randomUUID(),
    email: `${fullName.toLowerCase().replace(/\s/g, '.')}@acme.com`,
    password: 'hash-que-nunca-debe-salir',
    fullName,
    isActive: true,
    roles,
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

/** Reproduce las tres unicidades de `remote_sessions`. */
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

    const isLive = ACTIVE_REMOTE_SESSION_STATUSES.includes(entity.status);

    const deviceIsBusy = others.some(
      (row) =>
        row.deviceId === entity.deviceId &&
        ACTIVE_REMOTE_SESSION_STATUSES.includes(row.status),
    );

    if (deviceIsBusy && isLive)
      return Promise.reject(uniqueViolation(ACTIVE_REMOTE_SESSION_INDEX));

    const technicianIsBusy = others.some(
      (row) =>
        row.technicianId === entity.technicianId &&
        ACTIVE_REMOTE_SESSION_STATUSES.includes(row.status),
    );

    if (technicianIsBusy && isLive)
      return Promise.reject(
        uniqueViolation(ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX),
      );

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
    order?: { createdAt?: 'ASC' | 'DESC' };
  }): Promise<RemoteSession | null> {
    const found = this.rows.filter((candidate) =>
      matches(candidate, options.where),
    );

    // El orden forma parte de la consulta, asi que el doble tambien tiene que
    // aplicarlo aunque hoy no pueda haber dos sesiones vivas del mismo tecnico.
    if (options.order?.createdAt)
      found.sort((a, b) =>
        options.order?.createdAt === 'DESC'
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.createdAt.getTime() - b.createdAt.getTime(),
      );

    const row = found[0];

    if (!row) return Promise.resolve(null);

    const hydrated: RemoteSession = { ...row };

    if (options.relations?.device) hydrated.device = devices[row.deviceId];

    if (options.relations?.technician)
      hydrated.technician = technicians[row.technicianId];

    return Promise.resolve(hydrated);
  }

  /** Lo usa el cierre automatico para reconciliar las sesiones vivas. */
  find(options: {
    where: Record<string, WhereValue>;
  }): Promise<RemoteSession[]> {
    return Promise.resolve(
      this.rows
        .filter((candidate) => matches(candidate, options.where))
        .map((row) => ({ ...row })),
    );
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
  let emitToTechnician: jest.Mock;
  let online: Set<string>;

  /**
   * Filas pedidas con `SELECT ... FOR UPDATE`, como `<entidad>:<id>`.
   *
   * Sirve para comprobar que una transicion se hace de verdad sobre la fila
   * bloqueada y no sobre una lectura suelta.
   */
  let lockedRows: string[];

  let deviceA: Device;
  let deviceB: Device;
  let technicianA: User;
  let technicianB: User;
  let adminUser: User;

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
    emitToTechnician.mockClear();

    return { supportRequestId, remoteSessionId: id };
  };

  /** Solicitud ACCEPTED + sesion CONNECTING sobre el dispositivo indicado. */
  const seedSessionFor = async (
    device: Device,
    technician: User,
  ): Promise<string> => {
    const supportRequestId = await seedAcceptedRequest(device, technician);

    const { id } = await service.create({ supportRequestId }, technician);

    emitToDevice.mockClear();
    emitToTechnician.mockClear();

    return id;
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
    adminUser = buildTechnician('Admin Total', [ValidRoles.admin]);

    for (const key of Object.keys(devices)) delete devices[key];
    for (const key of Object.keys(technicians)) delete technicians[key];

    devices[deviceA.id] = deviceA;
    devices[deviceB.id] = deviceB;
    technicians[technicianA.id] = technicianA;
    technicians[technicianB.id] = technicianB;
    technicians[adminUser.id] = adminUser;

    remoteSessions = new FakeRemoteSessionRepository();
    supportRequests = new FakeSupportRequestRepository();
    emitToDevice = jest.fn().mockReturnValue(true);
    emitToTechnician = jest.fn().mockReturnValue(true);
    online = new Set<string>([deviceA.id, deviceB.id]);
    lockedRows = [];

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

        const row =
          entity === RemoteSession
            ? await remoteSessions.findOne(options)
            : await supportRequests.findOne(options);

        // Se anota la fila realmente bloqueada: si el WHERE no encuentra
        // ninguna (por ejemplo porque es de otro tecnico), PostgreSQL tampoco
        // bloquea nada.
        if (options.lock && row)
          lockedRows.push(
            `${entity === RemoteSession ? 'RemoteSession' : 'SupportRequest'}:${
              options.where.id as string
            }`,
          );

        return row;
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
        {
          provide: TechnicianRealtimeService,
          // La cola comun no es lo que se prueba aqui.
          useValue: { emitToTechnician, emitToAllTechnicians: () => true },
        },
      ],
    }).compile();

    service = moduleRef.get(RemoteSessionsService);
    supportRequestsService = moduleRef.get(SupportRequestsService);
  });

  describe('creacion por el tecnico', () => {
    it('escribe createdAt desde Node, con el mismo reloj que connectedAt y endedAt', async () => {
      // Si se dejara al `DEFAULT now()` de PostgreSQL, el TTL de CONNECTING se
      // calcularia sobre otro reloj (ver test/remote-sessions.db-spec.ts).
      const save = jest.spyOn(remoteSessions, 'save');
      const supportRequestId = await seedAcceptedRequest(deviceA);

      const before = Date.now();
      const created = await service.create({ supportRequestId }, technicianA);
      const after = Date.now();

      const inserted = save.mock.calls[0][0];

      expect(inserted.createdAt).toBeInstanceOf(Date);
      expect(inserted.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(inserted.createdAt.getTime()).toBeLessThanOrEqual(after);
      expect(created.createdAt).toEqual(inserted.createdAt);
    });

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

  describe('una sola sesion viva por tecnico', () => {
    it('crea la sesion cuando el tecnico no tiene ninguna viva', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });
    });

    it('rechaza una segunda sesion con una CONNECTING, aunque sea de otro dispositivo', async () => {
      const { remoteSessionId } = await seedSession();

      const supportRequestId = await seedAcceptedRequest(deviceB, technicianA);

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(remoteSessions.rows).toHaveLength(1);
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      // La solicitud del segundo dispositivo no se toca: sigue ACCEPTED y el
      // tecnico puede iniciarla en cuanto cierre la que tiene abierta.
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('rechaza una segunda sesion con una ACTIVE', async () => {
      const { remoteSessionId } = await seedSession();

      // Todavia no hay ningun camino que escriba ACTIVE: se fuerza la fila para
      // comprobar que el estado tambien cuenta como vivo.
      sessionRow(remoteSessionId).status = RemoteSessionStatus.ACTIVE;

      const supportRequestId = await seedAcceptedRequest(deviceB, technicianA);

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(remoteSessions.rows).toHaveLength(1);
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
    });

    it('deja crear otra en cuanto la anterior queda CLOSED', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByTechnician(remoteSessionId, technicianA);

      const supportRequestId = await seedAcceptedRequest(deviceB, technicianA);

      // Sin ninguna limpieza intermedia: una fila CLOSED queda fuera del indice
      // unico parcial.
      await expect(
        service.create({ supportRequestId }, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });

      expect(remoteSessions.rows).toHaveLength(2);
    });

    it('no impide que otro tecnico abra la suya sobre otro dispositivo', async () => {
      await seedSession();

      const supportRequestId = await seedAcceptedRequest(deviceB, technicianB);

      await expect(
        service.create({ supportRequestId }, technicianB),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });

      expect(remoteSessions.rows).toHaveLength(2);
    });

    it('crea una sola cuando el mismo tecnico lanza dos simultaneas sobre dispositivos distintos', async () => {
      const first = await seedAcceptedRequest(deviceA, technicianA);
      const second = await seedAcceptedRequest(deviceB, technicianA);

      // Dos solicitudes distintas: no compiten por la misma fila, asi que el
      // lock no las ordena y las dos pasan la comprobacion previa. Lo unico que
      // decide es el indice unico parcial por tecnico.
      const results = await Promise.allSettled([
        service.create({ supportRequestId: first }, technicianA),
        service.create({ supportRequestId: second }, technicianA),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);

      const rejected = results.filter((result) => result.status === 'rejected');

      expect(rejected).toHaveLength(1);
      // La violacion de la restriccion sale como 409, no como un 500 con el
      // QueryFailedError dentro.
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      expect(
        remoteSessions.rows.filter(
          (row) =>
            row.technicianId === technicianA.id &&
            ACTIVE_REMOTE_SESSION_STATUSES.includes(row.status),
        ),
      ).toHaveLength(1);
      expect(emitToDevice).toHaveBeenCalledTimes(1);
    });

    it('no convierte en 409 un 23505 de otra restriccion', async () => {
      const supportRequestId = await seedAcceptedRequest(deviceA);

      jest
        .spyOn(remoteSessions, 'save')
        .mockRejectedValueOnce(uniqueViolation('IDX_de_otra_tabla'));

      // Un unique_violation que no es ninguno de los tres indices de esta tabla
      // no puede anunciarse como "ya hay una sesion": es un fallo que no
      // sabemos interpretar.
      await expect(
        service.create({ supportRequestId }, technicianA),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
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

  describe('sesion actual del tecnico', () => {
    it('devuelve remoteSession: null cuando no tiene ninguna viva', async () => {
      await expect(
        service.findCurrentForTechnician(technicianA.id),
      ).resolves.toEqual({ remoteSession: null });
    });

    it('devuelve su sesion CONNECTING', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const { remoteSession } = await service.findCurrentForTechnician(
        technicianA.id,
      );

      expect(remoteSession).toMatchObject({
        id: remoteSessionId,
        supportRequestId,
        status: RemoteSessionStatus.CONNECTING,
        technician: { id: technicianA.id, name: technicianA.fullName },
        device: { id: deviceA.id, publicId: deviceA.publicId },
      });
    });

    it('devuelve tambien una sesion ACTIVE', async () => {
      const { remoteSessionId } = await seedSession();

      // Todavia no hay ningun camino que escriba ACTIVE, asi que se fuerza la
      // fila: lo que se comprueba es que el estado cuenta como vivo.
      sessionRow(remoteSessionId).status = RemoteSessionStatus.ACTIVE;

      const { remoteSession } = await service.findCurrentForTechnician(
        technicianA.id,
      );

      expect(remoteSession).toMatchObject({
        id: remoteSessionId,
        status: RemoteSessionStatus.ACTIVE,
      });
    });

    it('no devuelve una sesion CLOSED', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByTechnician(remoteSessionId, technicianA);

      await expect(
        service.findCurrentForTechnician(technicianA.id),
      ).resolves.toEqual({ remoteSession: null });
    });

    it('no devuelve la sesion viva de otro tecnico', async () => {
      await seedSession();

      await expect(
        service.findCurrentForTechnician(technicianB.id),
      ).resolves.toEqual({ remoteSession: null });
    });

    it('filtra por tecnico en la consulta y no despues de traerla', async () => {
      await seedSession();

      const findOne = jest.spyOn(remoteSessions, 'findOne');

      await service.findCurrentForTechnician(technicianB.id);

      const [options] = findOne.mock.calls[0];

      findOne.mockRestore();

      // La pertenencia viaja en el WHERE: una sesion ajena no llega a leerse
      // para descartarla despues.
      expect(options.where.technicianId).toBe(technicianB.id);
    });

    it('devuelve al admin la sesion de la que el mismo es tecnico', async () => {
      const remoteSessionId = await seedSessionFor(deviceA, adminUser);

      const { remoteSession } = await service.findCurrentForTechnician(
        adminUser.id,
      );

      expect(remoteSession).toMatchObject({ id: remoteSessionId });
    });

    it('no le da al admin la sesion de otro tecnico', async () => {
      await seedSession();

      // Ser admin no es un takeover: no supervisa las sesiones ajenas.
      await expect(
        service.findCurrentForTechnician(adminUser.id),
      ).resolves.toEqual({ remoteSession: null });
    });

    it('no puede tener mas de una viva que devolver', async () => {
      const { remoteSessionId } = await seedSession();

      // Intentar abrir una segunda, sobre otro dispositivo, no deja al tecnico
      // con dos sesiones entre las que elegir: responde 409.
      const supportRequestId = await seedAcceptedRequest(deviceB, technicianA);

      await expect(
        service.create({ supportRequestId }, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(
        remoteSessions.rows.filter(
          (row) =>
            row.technicianId === technicianA.id &&
            ACTIVE_REMOTE_SESSION_STATUSES.includes(row.status),
        ),
      ).toHaveLength(1);

      const { remoteSession } = await service.findCurrentForTechnician(
        technicianA.id,
      );

      expect(remoteSession).toMatchObject({ id: remoteSessionId });
    });

    it('devuelve la sesion nueva despues de cerrar la anterior', async () => {
      const { remoteSessionId: closed } = await seedSession();

      await service.closeByTechnician(closed, technicianA);

      const supportRequestId = await seedAcceptedRequest(deviceB, technicianA);
      const { id: current } = await service.create(
        { supportRequestId },
        technicianA,
      );

      const { remoteSession } = await service.findCurrentForTechnician(
        technicianA.id,
      );

      expect(remoteSession).toMatchObject({ id: current });
    });

    it('calcula isOnline en el momento, sin persistirlo', async () => {
      await seedSession();
      online.delete(deviceA.id);

      const { remoteSession } = await service.findCurrentForTechnician(
        technicianA.id,
      );

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

  describe('activacion por el tecnico', () => {
    it('lleva la sesion de CONNECTING a ACTIVE', async () => {
      const { remoteSessionId } = await seedSession();

      const activated = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(activated).toMatchObject({
        id: remoteSessionId,
        status: RemoteSessionStatus.ACTIVE,
        endedAt: null,
        endedBy: null,
        device: { id: deviceA.id, publicId: deviceA.publicId },
        technician: { id: technicianA.id, name: technicianA.fullName },
      });
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
    });

    it('fija connectedAt con la hora del backend', async () => {
      const { remoteSessionId } = await seedSession();

      expect(sessionRow(remoteSessionId).connectedAt).toBeNull();

      const before = Date.now();

      const activated = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      const after = Date.now();

      expect(activated.connectedAt).toBeInstanceOf(Date);
      // La hora la genera el backend: cae dentro de la ventana de la llamada, y
      // no hay ningun camino por el que el cliente pueda proponerla.
      expect(activated.connectedAt?.getTime()).toBeGreaterThanOrEqual(before);
      expect(activated.connectedAt?.getTime()).toBeLessThanOrEqual(after);
      expect(sessionRow(remoteSessionId).connectedAt).toEqual(
        activated.connectedAt,
      );
    });

    it('bloquea la fila de la sesion para hacer la transicion', async () => {
      const { remoteSessionId } = await seedSession();

      lockedRows = [];

      await service.activateByTechnician(remoteSessionId, technicianA);

      // `SELECT ... FOR UPDATE` sobre la propia sesion: es lo que serializa la
      // activacion con el cierre.
      expect(lockedRows).toContain(`RemoteSession:${remoteSessionId}`);
    });

    it('no toca la solicitud de asistencia', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const before = { ...requestRow(supportRequestId) };

      await service.activateByTechnician(remoteSessionId, technicianA);

      // La solicitud sigue asociada a la asistencia hasta que la sesion cierre:
      // COMPLETED es cosa del cierre, no de la activacion.
      expect(requestRow(supportRequestId)).toMatchObject({
        status: SupportRequestStatus.ACCEPTED,
        closedAt: null,
        respondedAt: before.respondedAt,
        assignedAt: before.assignedAt,
        technicianId: before.technicianId,
      });
    });

    it('no publica datos sensibles del tecnico', async () => {
      const { remoteSessionId } = await seedSession();

      const activated = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(activated.technician).not.toHaveProperty('email');
      expect(activated.technician).not.toHaveProperty('roles');
      expect(activated.technician).not.toHaveProperty('password');
    });

    it('es idempotente: un segundo activate devuelve la misma sesion ACTIVE', async () => {
      const { remoteSessionId } = await seedSession();

      const first = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      // El caso real: la respuesta se perdio por red y el cliente reintenta.
      const second = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(second).toMatchObject({
        id: remoteSessionId,
        status: RemoteSessionStatus.ACTIVE,
      });
      expect(second.connectedAt).toEqual(first.connectedAt);
      expect(sessionRow(remoteSessionId).connectedAt).toEqual(
        first.connectedAt,
      );
    });

    it('conserva el connectedAt original tras varios reintentos', async () => {
      const { remoteSessionId } = await seedSession();

      const { connectedAt } = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      await service.activateByTechnician(remoteSessionId, technicianA);
      await service.activateByTechnician(remoteSessionId, technicianA);

      expect(sessionRow(remoteSessionId).connectedAt).toEqual(connectedAt);
    });

    it('responde 409 sobre una sesion CLOSED y no la reabre', async () => {
      const { remoteSessionId } = await seedSession();

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      // CLOSED es terminal: ni el estado ni el cierre se alteran.
      expect(sessionRow(remoteSessionId)).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedAt: closed.endedAt,
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
        connectedAt: null,
      });
    });

    it('responde 409 tambien sobre una sesion que estuvo ACTIVE y se cerro', async () => {
      const { remoteSessionId } = await seedSession();

      const { connectedAt } = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      await service.closeByTechnician(remoteSessionId, technicianA);

      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
      // El historial de la sesion no se reescribe.
      expect(sessionRow(remoteSessionId).connectedAt).toEqual(connectedAt);
    });

    it('responde 404 a un tecnico que no es el de la sesion', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.activateByTechnician(remoteSessionId, technicianB),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect(sessionRow(remoteSessionId).connectedAt).toBeNull();
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('responde 404 al admin sobre una sesion ajena: no hay takeover', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.activateByTechnician(remoteSessionId, adminUser),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });

    it('deja al admin activar la sesion de la que el mismo es tecnico', async () => {
      const remoteSessionId = await seedSessionFor(deviceA, adminUser);

      await expect(
        service.activateByTechnician(remoteSessionId, adminUser),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.ACTIVE });
    });

    it('responde 404 con un id que no existe', async () => {
      await expect(
        service.activateByTechnician(randomUUID(), technicianA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('filtra por tecnico en la consulta bloqueante y no despues', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.activateByTechnician(remoteSessionId, technicianB),
      ).rejects.toBeInstanceOf(NotFoundException);

      // La sesion ajena ni siquiera se bloquea: la pertenencia viaja en el
      // WHERE, no en un `if` posterior.
      expect(lockedRows).not.toContain(`RemoteSession:${remoteSessionId}`);
    });

    it('la sesion ACTIVE sigue siendo la actual de los dos extremos', async () => {
      const { remoteSessionId } = await seedSession();

      await service.activateByTechnician(remoteSessionId, technicianA);

      await expect(
        service.findCurrentForTechnician(technicianA.id),
      ).resolves.toMatchObject({
        remoteSession: {
          id: remoteSessionId,
          status: RemoteSessionStatus.ACTIVE,
        },
      });

      await expect(
        service.findCurrentForDevice(deviceA.id),
      ).resolves.toMatchObject({
        remoteSession: {
          id: remoteSessionId,
          status: RemoteSessionStatus.ACTIVE,
        },
      });
    });

    it('se puede cerrar una sesion ya activa, conservando connectedAt', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const { connectedAt } = await service.activateByTechnician(
        remoteSessionId,
        technicianA,
      );

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(closed).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
        connectedAt,
      });
      expect(sessionRow(remoteSessionId).connectedAt).toEqual(connectedAt);
      // El flujo existente no cambia: cerrar sigue completando la solicitud.
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });

    it('tambien puede cerrarla el dispositivo estando ACTIVE', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      await service.activateByTechnician(remoteSessionId, technicianA);

      await expect(
        service.closeByDevice(remoteSessionId, deviceA),
      ).resolves.toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.DEVICE,
      });
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });
  });

  describe('remote-session:active', () => {
    it('avisa a los dos extremos con el payload minimo', async () => {
      const { remoteSessionId } = await seedSession();

      await service.activateByTechnician(remoteSessionId, technicianA);

      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToDevice).toHaveBeenCalledWith(
        deviceA.id,
        REMOTE_SESSION_ACTIVE_EVENT,
        { remoteSessionId },
      );

      expect(emitToTechnician).toHaveBeenCalledTimes(1);
      expect(emitToTechnician).toHaveBeenCalledWith(
        technicianA.id,
        REMOTE_SESSION_ACTIVE_EVENT,
        { remoteSessionId },
      );
    });

    it('no lleva nada mas que el id de la sesion', async () => {
      const { remoteSessionId } = await seedSession();

      await service.activateByTechnician(remoteSessionId, technicianA);

      const [, , payload] = emitToDevice.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];

      // REST es la fuente de verdad: el evento es un disparador, no el estado.
      expect(Object.keys(payload)).toEqual(['remoteSessionId']);
    });

    it('no vuelve a emitir cuando la sesion ya estaba ACTIVE', async () => {
      const { remoteSessionId } = await seedSession();

      await service.activateByTechnician(remoteSessionId, technicianA);

      emitToDevice.mockClear();
      emitToTechnician.mockClear();

      await service.activateByTechnician(remoteSessionId, technicianA);

      // Solo la transicion real avisa; un reintento no.
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('no emite cuando la activacion falla', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByTechnician(remoteSessionId, technicianA);
      emitToDevice.mockClear();

      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('mantiene la activacion aunque falle el aviso a la tablet', async () => {
      const { remoteSessionId } = await seedSession();

      emitToDevice.mockImplementation(() => {
        throw new Error('transporte caido');
      });

      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.ACTIVE });

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
      expect(sessionRow(remoteSessionId).connectedAt).toBeInstanceOf(Date);
      // Un extremo caido no puede dejar al otro sin enterarse.
      expect(emitToTechnician).toHaveBeenCalledTimes(1);
    });

    it('mantiene la activacion aunque falle el aviso al tecnico', async () => {
      const { remoteSessionId } = await seedSession();

      emitToTechnician.mockImplementation(() => {
        throw new Error('transporte caido');
      });

      // La persistencia es la fuente de verdad: el aviso no la deshace ni
      // convierte una activacion correcta en un 500.
      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.ACTIVE });

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
      expect(emitToDevice).toHaveBeenCalledTimes(1);
    });
  });

  describe('carrera entre activar y cerrar', () => {
    /** Ningun final puede dejar la sesion fuera de estos estados. */
    const expectConsistent = (
      remoteSessionId: string,
      supportRequestId: string,
    ): void => {
      const row = sessionRow(remoteSessionId);

      expect([
        RemoteSessionStatus.ACTIVE,
        RemoteSessionStatus.CLOSED,
      ]).toContain(row.status);

      if (row.status === RemoteSessionStatus.CLOSED) {
        expect(row.endedAt).toBeInstanceOf(Date);
        expect(row.endedBy).not.toBeNull();
        expect(requestRow(supportRequestId).status).toBe(
          SupportRequestStatus.COMPLETED,
        );

        // Si llego a activarse, la conexion siempre es anterior al cierre.
        if (row.connectedAt)
          expect(row.connectedAt.getTime()).toBeLessThanOrEqual(
            (row.endedAt as Date).getTime(),
          );
      } else {
        expect(row.connectedAt).toBeInstanceOf(Date);
        expect(row.endedAt).toBeNull();
        expect(requestRow(supportRequestId).status).toBe(
          SupportRequestStatus.ACCEPTED,
        );
      }
    };

    it('cerrar antes deja el activate en 409 y la sesion CLOSED', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(sessionRow(remoteSessionId).endedAt).toEqual(closed.endedAt);
      expectConsistent(remoteSessionId, supportRequestId);
    });

    it('activar antes deja que el cierre haga ACTIVE -> CLOSED', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      await service.activateByTechnician(remoteSessionId, technicianA);

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CLOSED });

      expectConsistent(remoteSessionId, supportRequestId);
    });

    it('activate y close simultaneos no dejan un estado imposible', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const results = await Promise.allSettled([
        service.activateByTechnician(remoteSessionId, technicianA),
        service.closeByDevice(remoteSessionId, deviceA),
      ]);

      const [activate] = results;

      // Perder la carrera es 409, nunca un 500 ni una sesion reabierta.
      if (activate.status === 'rejected')
        expect(activate.reason).toBeInstanceOf(ConflictException);

      expectConsistent(remoteSessionId, supportRequestId);
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
    });

    it('tampoco al revés: cerrar y activar a la vez', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const results = await Promise.allSettled([
        service.closeByDevice(remoteSessionId, deviceA),
        service.activateByTechnician(remoteSessionId, technicianA),
      ]);

      const [, activate] = results;

      if (activate.status === 'rejected')
        expect(activate.reason).toBeInstanceOf(ConflictException);

      expectConsistent(remoteSessionId, supportRequestId);
      // CLOSED es terminal: una activacion que llegue tarde no lo deshace.
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
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

    it('no le devuelve el eco a quien acaba de cerrar', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByTechnician(remoteSessionId, technicianA);

      // La web ya recibe la sesion cerrada en la respuesta HTTP.
      expect(emitToTechnician).not.toHaveBeenCalled();
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
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('cerrar dos veces confirma el primer cierre sin alterarlo', async () => {
      const { remoteSessionId } = await seedSession();

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).resolves.toEqual(closed);

      expect(sessionRow(remoteSessionId).endedAt).toEqual(closed.endedAt);
    });

    it('bloquea la fila de la sesion antes de cerrar', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByTechnician(remoteSessionId, technicianA);

      expect(lockedRows).toContain(`RemoteSession:${remoteSessionId}`);
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

    it('avisa al tecnico dueno con remote-session:closed', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByDevice(remoteSessionId, deviceA);

      expect(emitToTechnician).toHaveBeenCalledTimes(1);
      expect(emitToTechnician).toHaveBeenCalledWith(
        technicianA.id,
        REMOTE_SESSION_CLOSED_EVENT,
        {
          remoteSessionId,
          endedBy: RemoteSessionEndedBy.DEVICE,
        },
      );
    });

    it('mantiene el cierre aunque el aviso al tecnico falle', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      emitToTechnician.mockImplementation(() => {
        throw new Error('transporte caido');
      });

      // La persistencia es la fuente de verdad: el aviso no puede deshacerla
      // ni convertir un cierre correcto en un 500.
      await expect(
        service.closeByDevice(remoteSessionId, deviceA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CLOSED });

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });

    it('responde 404 a otro dispositivo y no cierra nada', async () => {
      const { remoteSessionId } = await seedSession();

      await expect(
        service.closeByDevice(remoteSessionId, deviceB),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('no avisa dos veces si la sesion ya estaba cerrada', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByDevice(remoteSessionId, deviceA);
      emitToTechnician.mockClear();

      await expect(
        service.closeByDevice(remoteSessionId, deviceA),
      ).resolves.toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.DEVICE,
      });

      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('bloquea la fila de la sesion antes de cerrar', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeByDevice(remoteSessionId, deviceA);

      expect(lockedRows).toContain(`RemoteSession:${remoteSessionId}`);
    });
  });

  describe('cierre concurrente', () => {
    it('deja un unico cierre cuando tecnico y dispositivo coinciden', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      // Los dos piden la fila a la vez: el lock los ordena, el primero cierra y
      // el segundo, al obtenerla, lee CLOSED y confirma ese mismo cierre.
      const [byTechnician, byDevice] = await Promise.all([
        service.closeByTechnician(remoteSessionId, technicianA),
        service.closeByDevice(remoteSessionId, deviceA),
      ]);

      const row = sessionRow(remoteSessionId);

      expect(row.status).toBe(RemoteSessionStatus.CLOSED);
      // Ganó el primero que pidió la fila, y los dos responden lo mismo.
      expect(row.endedBy).toBe(RemoteSessionEndedBy.TECHNICIAN);
      expect(byTechnician).toEqual(byDevice);
      expect(byDevice).toMatchObject({
        endedBy: row.endedBy,
        endedAt: row.endedAt,
      });
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );

      // Un solo cierre real, un solo aviso: a la tablet, porque gano el tecnico.
      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToTechnician).not.toHaveBeenCalled();
    });
  });

  describe('cierre idempotente', () => {
    const always = () => true;

    /** Todo lo que un cierre puede haber escrito, para comparar antes/despues. */
    const snapshotOf = (remoteSessionId: string, supportRequestId: string) => ({
      session: { ...sessionRow(remoteSessionId) },
      request: { ...requestRow(supportRequestId) },
    });

    it('el tecnico repite: 200 con el cierre original, sin escribir ni avisar', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const first = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );
      const before = snapshotOf(remoteSessionId, supportRequestId);
      emitToDevice.mockClear();
      const listener = jest.fn();
      service.onSessionChanged(listener);

      const again = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(again).toEqual(first);
      expect(again).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
        endedAt: first.endedAt,
      });
      expect(snapshotOf(remoteSessionId, supportRequestId)).toEqual(before);
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('el dispositivo repite: 200 con el cierre original, sin escribir ni avisar', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const first = await service.closeByDevice(remoteSessionId, deviceA);
      const before = snapshotOf(remoteSessionId, supportRequestId);
      emitToTechnician.mockClear();

      const again = await service.closeByDevice(remoteSessionId, deviceA);

      expect(again).toEqual(first);
      expect(again.endedBy).toBe(RemoteSessionEndedBy.DEVICE);
      expect(snapshotOf(remoteSessionId, supportRequestId)).toEqual(before);
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('cierra el tecnico y despues el dispositivo: confirma TECHNICIAN, no DEVICE', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const first = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );
      const before = snapshotOf(remoteSessionId, supportRequestId);
      emitToDevice.mockClear();

      const late = await service.closeByDevice(remoteSessionId, deviceA);

      // El solicitante tardio no se atribuye el cierre.
      expect(late).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
        endedAt: first.endedAt,
      });
      expect(snapshotOf(remoteSessionId, supportRequestId)).toEqual(before);
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('cierra el dispositivo y despues el tecnico: confirma DEVICE, no TECHNICIAN', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const first = await service.closeByDevice(remoteSessionId, deviceA);
      const before = snapshotOf(remoteSessionId, supportRequestId);
      emitToTechnician.mockClear();

      const late = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );

      expect(late).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.DEVICE,
        endedAt: first.endedAt,
      });
      expect(snapshotOf(remoteSessionId, supportRequestId)).toEqual(before);
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('despues de SYSTEM, un POST antiguo de cualquiera conserva SYSTEM', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const bySystem = await service.closeBySystem(remoteSessionId, always);
      const before = snapshotOf(remoteSessionId, supportRequestId);
      emitToDevice.mockClear();
      emitToTechnician.mockClear();

      const fromTechnician = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );
      const fromDevice = await service.closeByDevice(remoteSessionId, deviceA);

      for (const late of [fromTechnician, fromDevice])
        expect(late).toMatchObject({
          status: RemoteSessionStatus.CLOSED,
          endedBy: RemoteSessionEndedBy.SYSTEM,
          endedAt: bySystem?.endedAt,
        });
      expect(snapshotOf(remoteSessionId, supportRequestId)).toEqual(before);
      // SYSTEM ya aviso a los dos al cerrar; los reintentos no repiten nada.
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('la solicitud pasa a COMPLETED una sola vez y su closedAt no cambia', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      await service.closeByTechnician(remoteSessionId, technicianA);
      const completed = { ...requestRow(supportRequestId) };

      await service.closeByTechnician(remoteSessionId, technicianA);
      await service.closeByDevice(remoteSessionId, deviceA);

      expect(requestRow(supportRequestId)).toEqual(completed);
      expect(completed).toMatchObject({
        status: SupportRequestStatus.COMPLETED,
        closedAt: sessionRow(remoteSessionId).endedAt,
      });
    });

    it('un reintento que llega en plena carrera espera al lock y confirma al ganador', async () => {
      const { remoteSessionId } = await seedSession();

      // Tres actores a la vez, cada uno con su propio reintento.
      const results = await Promise.all([
        service.closeByDevice(remoteSessionId, deviceA),
        service.closeByTechnician(remoteSessionId, technicianA),
        service.closeBySystem(remoteSessionId, always),
        service.closeByTechnician(remoteSessionId, technicianA),
        service.closeByDevice(remoteSessionId, deviceA),
      ]);

      const row = sessionRow(remoteSessionId);

      expect(row.endedBy).toBe(RemoteSessionEndedBy.DEVICE);
      // SYSTEM no cerro: devuelve null y no avisa.
      expect(results[2]).toBeNull();
      for (const index of [0, 1, 3, 4])
        expect(results[index]).toMatchObject({
          endedBy: RemoteSessionEndedBy.DEVICE,
          endedAt: row.endedAt,
        });
      // Un unico aviso, el del cierre real del dispositivo hacia el tecnico.
      expect(emitToTechnician).toHaveBeenCalledTimes(1);
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('responde 404 a una sesion inexistente', async () => {
      await expect(
        service.closeByTechnician(randomUUID(), technicianA),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.closeByDevice(randomUUID(), deviceA),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('una sesion CLOSED de otro tecnico sigue siendo 404 y no se bloquea', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByTechnician(remoteSessionId, technicianA);
      lockedRows = [];

      // Ni el tecnico ajeno ni un admin: estar CLOSED no hace visible nada.
      for (const stranger of [technicianB, adminUser])
        await expect(
          service.closeByTechnician(remoteSessionId, stranger),
        ).rejects.toBeInstanceOf(NotFoundException);

      expect(lockedRows).toEqual([]);
    });

    it('una sesion CLOSED de otro dispositivo sigue siendo 404', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByDevice(remoteSessionId, deviceA);
      lockedRows = [];

      await expect(
        service.closeByDevice(remoteSessionId, deviceB),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(lockedRows).toEqual([]);
    });

    it('el 404 no distingue una sesion ajena de una inexistente', async () => {
      const { remoteSessionId } = await seedSession();
      await service.closeByTechnician(remoteSessionId, technicianA);

      const foreign = await service
        .closeByTechnician(remoteSessionId, technicianB)
        .catch((error: NotFoundException) => error.getResponse());
      const missing = await service
        .closeByTechnician(randomUUID(), technicianB)
        .catch((error: NotFoundException) => error.getResponse());

      expect(foreign).toMatchObject({ statusCode: 404, error: 'Not Found' });
      expect(Object.keys(foreign as object)).toEqual(
        Object.keys(missing as object),
      );
      // Nada de la sesion (estado, endedBy, participantes) en el error.
      expect(JSON.stringify(foreign)).not.toMatch(
        /CLOSED|TECHNICIAN|DEVICE|Ana|384-729-142/,
      );
    });

    it('un POST antiguo sobre una sesion historica no toca la sesion nueva', async () => {
      const old = await seedSession();
      await service.closeByTechnician(old.remoteSessionId, technicianA);

      // Nueva asistencia: mismo dispositivo y mismo tecnico.
      const current = await seedSessionFor(deviceA, technicianA);
      await service.activateByTechnician(current, technicianA);
      const liveBefore = { ...sessionRow(current) };
      emitToDevice.mockClear();
      emitToTechnician.mockClear();

      // Reintentos retrasados de los dos lados sobre la sesion vieja.
      await expect(
        service.closeByTechnician(old.remoteSessionId, technicianA),
      ).resolves.toMatchObject({ id: old.remoteSessionId, status: 'CLOSED' });
      await expect(
        service.closeByDevice(old.remoteSessionId, deviceA),
      ).resolves.toMatchObject({ id: old.remoteSessionId, status: 'CLOSED' });

      expect(sessionRow(current)).toEqual(liveBefore);
      expect(sessionRow(current).status).toBe(RemoteSessionStatus.ACTIVE);
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
      await expect(
        service.findCurrentForTechnician(technicianA.id),
      ).resolves.toMatchObject({ remoteSession: { id: current } });
    });

    it('si la base falla en mitad del cierre, no queda nada escrito ni avisado', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      type FindOne = FakeRemoteSessionRepository['findOne'];
      const original = remoteSessions.findOne.bind(remoteSessions) as FindOne;
      let calls = 0;

      // 1a lectura: el SELECT ... FOR UPDATE. 2a: la relectura posterior al
      // UPDATE. Falla la segunda, con los UPDATE ya ejecutados.
      const failing = jest
        .spyOn(remoteSessions, 'findOne')
        .mockImplementation((options: Parameters<FindOne>[0]) =>
          ++calls === 2
            ? Promise.reject(new QueryFailedError('SELECT', [], new Error()))
            : original(options),
        );

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(QueryFailedError);

      // Rollback: la sesion sigue viva y la solicitud ACCEPTED.
      expect(sessionRow(remoteSessionId)).toMatchObject({
        status: RemoteSessionStatus.CONNECTING,
        endedAt: null,
        endedBy: null,
      });
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
      expect(emitToDevice).not.toHaveBeenCalled();

      // Y el reintento del cliente cierra de verdad, una sola vez.
      failing.mockRestore();

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).resolves.toMatchObject({ endedBy: RemoteSessionEndedBy.TECHNICIAN });
      expect(emitToDevice).toHaveBeenCalledTimes(1);
    });

    it('un aviso a la tablet que falla no convierte el cierre en un error', async () => {
      const { remoteSessionId } = await seedSession();

      emitToDevice.mockImplementation(() => {
        throw new Error('transporte caido');
      });

      await expect(
        service.closeByTechnician(remoteSessionId, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CLOSED });
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CLOSED,
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

  describe('cierre del sistema (SYSTEM)', () => {
    const always = () => true;

    it('cierra con endedBy SYSTEM y completa la solicitud en la misma transaccion', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();

      const closed = await service.closeBySystem(remoteSessionId, always);

      expect(closed).toMatchObject({
        id: remoteSessionId,
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });
      expect(sessionRow(remoteSessionId)).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });

      const request = requestRow(supportRequestId);

      expect(request.status).toBe(SupportRequestStatus.COMPLETED);
      expect(request.closedAt).toEqual(sessionRow(remoteSessionId).endedAt);
    });

    it('bloquea la fila de la sesion antes de decidir', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeBySystem(remoteSessionId, always);

      expect(lockedRows).toContain(`RemoteSession:${remoteSessionId}`);
    });

    it('avisa a LOS DOS extremos con el mismo payload', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeBySystem(remoteSessionId, always);

      const payload = {
        remoteSessionId,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      };

      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToDevice).toHaveBeenCalledWith(
        deviceA.id,
        REMOTE_SESSION_CLOSED_EVENT,
        payload,
      );
      expect(emitToTechnician).toHaveBeenCalledTimes(1);
      expect(emitToTechnician).toHaveBeenCalledWith(
        technicianA.id,
        REMOTE_SESSION_CLOSED_EVENT,
        payload,
      );
    });

    it('decide con la sesion bloqueada y no toca nada si ya no corresponde', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      const decide = jest.fn().mockReturnValue(false);

      await expect(
        service.closeBySystem(remoteSessionId, decide),
      ).resolves.toBeNull();

      expect(decide).toHaveBeenCalledWith(
        expect.objectContaining({
          id: remoteSessionId,
          status: RemoteSessionStatus.CONNECTING,
        }),
        expect.any(Date),
      );
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('una sesion CLOSED no se modifica: ni decide, ni escribe, ni avisa', async () => {
      const { remoteSessionId } = await seedSession();
      const closed = await service.closeByTechnician(
        remoteSessionId,
        technicianA,
      );
      emitToDevice.mockClear();
      const decide = jest.fn().mockReturnValue(true);

      await expect(
        service.closeBySystem(remoteSessionId, decide),
      ).resolves.toBeNull();

      expect(decide).not.toHaveBeenCalled();
      expect(sessionRow(remoteSessionId)).toMatchObject({
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
        endedAt: closed.endedAt,
      });
      expect(emitToDevice).not.toHaveBeenCalled();
      expect(emitToTechnician).not.toHaveBeenCalled();
    });

    it('un cierre SYSTEM repetido solo hace una transicion y un aviso', async () => {
      const { remoteSessionId } = await seedSession();

      const results = await Promise.all([
        service.closeBySystem(remoteSessionId, always),
        service.closeBySystem(remoteSessionId, always),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToTechnician).toHaveBeenCalledTimes(1);
    });

    it('una sesion inexistente responde null', async () => {
      await expect(
        service.closeBySystem(randomUUID(), always),
      ).resolves.toBeNull();
    });

    it.each([
      ['el tecnico', 'technician'],
      ['el dispositivo', 'device'],
    ])(
      'SYSTEM y %s cierran a la vez: una sola transicion, endedBy del ganador',
      async (_label, who) => {
        const { remoteSessionId, supportRequestId } = await seedSession();

        const manual =
          who === 'technician'
            ? service.closeByTechnician(remoteSessionId, technicianA)
            : service.closeByDevice(remoteSessionId, deviceA);

        const [system, manualResult] = await Promise.allSettled([
          service.closeBySystem(remoteSessionId, always),
          manual,
        ]);

        const systemWon =
          system.status === 'fulfilled' && system.value !== null;
        const manualWon = manualResult.status === 'fulfilled';

        // Exactamente uno gana; el otro no reescribe nada.
        expect(Number(systemWon) + Number(manualWon)).toBe(1);

        const row = sessionRow(remoteSessionId);
        const manualEndedBy =
          who === 'technician'
            ? RemoteSessionEndedBy.TECHNICIAN
            : RemoteSessionEndedBy.DEVICE;
        const expectedEndedBy = systemWon
          ? RemoteSessionEndedBy.SYSTEM
          : manualEndedBy;

        expect(row.endedBy).toBe(expectedEndedBy);
        expect(requestRow(supportRequestId).closedAt).toEqual(row.endedAt);

        // Ningun aviso contradictorio: todos llevan el endedBy ganador.
        const calls = [
          ...(emitToDevice.mock.calls as unknown[][]),
          ...(emitToTechnician.mock.calls as unknown[][]),
        ];

        for (const call of calls)
          expect(call[2]).toEqual({
            remoteSessionId,
            endedBy: expectedEndedBy,
          });
      },
    );

    it('el vencimiento de CONNECTING no toca una sesion que ya se activo', async () => {
      const { remoteSessionId } = await seedSession();
      const onlyIfConnecting = (session: { status: RemoteSessionStatus }) =>
        session.status === RemoteSessionStatus.CONNECTING;

      // activate toma el lock primero; el vencimiento lee la fila ya ACTIVE.
      const [activated, expired] = await Promise.all([
        service.activateByTechnician(remoteSessionId, technicianA),
        service.closeBySystem(remoteSessionId, onlyIfConnecting),
      ]);

      expect(activated.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(expired).toBeNull();
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
    });

    it('si vence primero, activate responde 409 y la sesion queda CLOSED/SYSTEM', async () => {
      const { remoteSessionId } = await seedSession();

      await service.closeBySystem(remoteSessionId, always);

      await expect(
        service.activateByTechnician(remoteSessionId, technicianA),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(sessionRow(remoteSessionId).endedBy).toBe(
        RemoteSessionEndedBy.SYSTEM,
      );
    });

    it('un fallo al avisar a un extremo no revierte el cierre ni impide el otro aviso', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      emitToDevice.mockImplementation(() => {
        throw new Error('transporte caido');
      });

      const closed = await service.closeBySystem(remoteSessionId, always);

      expect(closed?.status).toBe(RemoteSessionStatus.CLOSED);
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
      expect(requestRow(supportRequestId).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
      expect(emitToTechnician).toHaveBeenCalledTimes(1);
    });

    it('aborta sin cerrar si la solicitud no puede completarse', async () => {
      const { remoteSessionId, supportRequestId } = await seedSession();
      requestRow(supportRequestId).status = SupportRequestStatus.CANCELLED;

      await expect(
        service.closeBySystem(remoteSessionId, always),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(sessionRow(remoteSessionId).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
      expect(emitToDevice).not.toHaveBeenCalled();
    });
  });

  describe('avisos internos de cambio de estado', () => {
    it('informa de creacion, activacion y cierre con una copia minima', async () => {
      const statuses: RemoteSessionStatus[] = [];
      const keys: string[][] = [];
      service.onSessionChanged((snapshot) => {
        statuses.push(snapshot.status);
        keys.push(Object.keys(snapshot).sort());
      });

      const { remoteSessionId } = await seedSession();
      await service.activateByTechnician(remoteSessionId, technicianA);
      await service.closeByTechnician(remoteSessionId, technicianA);

      expect(statuses).toEqual([
        RemoteSessionStatus.CONNECTING,
        RemoteSessionStatus.ACTIVE,
        RemoteSessionStatus.CLOSED,
      ]);
      expect(keys[0]).toEqual(
        [
          'connectedAt',
          'createdAt',
          'deviceId',
          'id',
          'status',
          'supportRequestId',
          'technicianId',
        ].sort(),
      );
    });

    it('no informa de un activate repetido ni de un cierre repetido', async () => {
      const { remoteSessionId } = await seedSession();
      await service.activateByTechnician(remoteSessionId, technicianA);
      const listener = jest.fn();
      service.onSessionChanged(listener);

      await service.activateByTechnician(remoteSessionId, technicianA);
      await service.closeByDevice(remoteSessionId, deviceA);
      await service.closeByTechnician(remoteSessionId, technicianA);
      await service.closeByDevice(remoteSessionId, deviceA);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('un listener que falla no convierte la operacion en un error', async () => {
      service.onSessionChanged(() => {
        throw new Error('boom');
      });

      await expect(seedSession()).resolves.toBeDefined();
    });

    it('findLiveSessions devuelve solo las sesiones vivas', async () => {
      const first = await seedSessionFor(deviceA, technicianA);
      const second = await seedSessionFor(deviceB, technicianB);
      await service.closeByTechnician(second, technicianB);

      const live = await service.findLiveSessions();

      expect(live.map((session) => session.id)).toEqual([first]);
      await expect(service.findLiveSession(second)).resolves.toBeNull();
      await expect(service.findLiveSession(first)).resolves.toMatchObject({
        id: first,
      });
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
