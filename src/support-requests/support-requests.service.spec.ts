import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { FindOperator, QueryFailedError, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import {
  ACTIVE_SUPPORT_REQUEST_INDEX,
  SupportRequest,
} from './entities/support-request.entity';
import {
  ACTIVE_SUPPORT_REQUEST_STATUSES,
  SupportRequestStatus,
} from './enums/support-request-status.enum';
import {
  SUPPORT_ASSIGNED_EVENT,
  SupportRequestsService,
} from './support-requests.service';

/**
 * Reglas de negocio de las solicitudes de asistencia.
 *
 * El repositorio de TypeORM se sustituye por un doble en memoria que reproduce
 * las dos garantias que aqui importan y que en produccion las da PostgreSQL:
 *
 * - el indice unico parcial de una sola solicitud activa por dispositivo, que
 *   falla con `unique_violation` (23505);
 * - el UPDATE condicionado al estado actual, que devuelve cuantas filas
 *   cambiaron y es lo que decide las carreras entre dos tecnicos.
 *
 * Lo que NO se prueba aqui es que PostgreSQL cree realmente ese indice ni que
 * resuelva la concurrencia real entre conexiones: eso necesita el motor.
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

type WhereValue = string | FindOperator<SupportRequestStatus>;

/**
 * Repositorio en memoria con lo justo que usa el servicio.
 *
 * Las filas se guardan clonadas: quien las lee no puede modificar el
 * "almacenamiento" por referencia, igual que ocurre con una base de datos.
 */
class FakeSupportRequestRepository {
  readonly rows: SupportRequest[] = [];

  create(partial: Partial<SupportRequest>): SupportRequest {
    return { ...partial } as SupportRequest;
  }

  save(entity: SupportRequest): Promise<SupportRequest> {
    // Reproduce el indice unico parcial: una sola solicitud activa por dispositivo.
    const hasActive = this.rows.some(
      (row) =>
        row.deviceId === entity.deviceId &&
        row.id !== entity.id &&
        ACTIVE_SUPPORT_REQUEST_STATUSES.includes(row.status),
    );

    if (hasActive && ACTIVE_SUPPORT_REQUEST_STATUSES.includes(entity.status))
      return Promise.reject(
        new QueryFailedError('INSERT INTO support_requests', [], {
          code: UNIQUE_VIOLATION,
          constraint: ACTIVE_SUPPORT_REQUEST_INDEX,
        } as unknown as Error),
      );

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
      this.matches(candidate, options.where),
    );

    return Promise.resolve(row ? this.hydrate(row, options.relations) : null);
  }

  find(options: {
    where: Record<string, WhereValue>;
    relations?: Record<string, boolean>;
    order?: { createdAt: 'ASC' | 'DESC' };
  }): Promise<SupportRequest[]> {
    const rows = this.rows
      .filter((candidate) => this.matches(candidate, options.where))
      .sort(
        (a, b) =>
          (a.createdAt.getTime() - b.createdAt.getTime()) *
          (options.order?.createdAt === 'DESC' ? -1 : 1),
      );

    return Promise.resolve(
      rows.map((row) => this.hydrate(row, options.relations)),
    );
  }

  /** Solo la cadena que usa `applyTransition`: update/set/where/andWhere/execute. */
  createQueryBuilder() {
    let changes: Partial<SupportRequest> = {};
    const params: Record<string, unknown> = {};

    const builder = {
      update: () => builder,
      set: (values: Partial<SupportRequest>) => {
        changes = values;
        return builder;
      },
      where: (_condition: string, parameters: Record<string, unknown>) => {
        Object.assign(params, parameters);
        return builder;
      },
      andWhere: (_condition: string, parameters: Record<string, unknown>) => {
        Object.assign(params, parameters);
        return builder;
      },
      // La condicion se evalua al ejecutar, no al construir: es lo que hace
      // que dos transiciones simultaneas no puedan aplicarse las dos.
      execute: () => {
        const from = params.from as SupportRequestStatus[];
        const row = this.rows.find(
          (candidate) =>
            candidate.id === params.id && from.includes(candidate.status),
        );

        if (!row) return Promise.resolve({ affected: 0 });

        Object.assign(row, changes);

        return Promise.resolve({ affected: 1 });
      },
    };

    return builder;
  }

  private matches(
    row: SupportRequest,
    where: Record<string, WhereValue>,
  ): boolean {
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key as keyof SupportRequest];

      if (expected instanceof FindOperator)
        return (expected.value as unknown as SupportRequestStatus[]).includes(
          actual as SupportRequestStatus,
        );

      return actual === expected;
    });
  }

  /** Resuelve las relaciones como haria TypeORM al pedirlas. */
  private hydrate(
    row: SupportRequest,
    relations?: Record<string, boolean>,
  ): SupportRequest {
    const hydrated: SupportRequest = { ...row };

    if (relations?.device) hydrated.device = devices[row.deviceId];

    if (relations?.technician)
      hydrated.technician = row.technicianId
        ? technicians[row.technicianId]
        : null;

    return hydrated;
  }
}

const devices: Record<string, Device> = {};
const technicians: Record<string, User> = {};

describe('SupportRequestsService', () => {
  let service: SupportRequestsService;
  let repository: FakeSupportRequestRepository;
  let emitToDevice: jest.Mock;
  let online: Set<string>;

  let deviceA: Device;
  let deviceB: Device;
  let technicianA: User;
  let technicianB: User;

  /** Crea una solicitud y la deja en el estado pedido, como lo haria el flujo. */
  const seedRequest = async (
    device: Device,
    status: SupportRequestStatus = SupportRequestStatus.WAITING,
  ): Promise<string> => {
    const { id } = await service.createForDevice(device);

    if (status !== SupportRequestStatus.WAITING) {
      await service.assign(id, technicianA);

      if (status === SupportRequestStatus.ACCEPTED)
        await service.acceptByDevice(id, device);
    }

    emitToDevice.mockClear();

    return id;
  };

  const statusOf = (id: string): SupportRequestStatus | undefined =>
    repository.rows.find((row) => row.id === id)?.status;

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

    repository = new FakeSupportRequestRepository();
    emitToDevice = jest.fn().mockReturnValue(true);
    online = new Set<string>([deviceA.id, deviceB.id]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        SupportRequestsService,
        {
          provide: getRepositoryToken(SupportRequest),
          useValue: repository as unknown as Repository<SupportRequest>,
        },
        {
          provide: DevicePresenceService,
          useValue: { isOnline: (deviceId: string) => online.has(deviceId) },
        },
        { provide: DeviceRealtimeService, useValue: { emitToDevice } },
      ],
    }).compile();

    service = moduleRef.get(SupportRequestsService);
  });

  describe('creacion desde el dispositivo', () => {
    it('crea la solicitud en WAITING sin tecnico ni marcas de tiempo', async () => {
      const created = await service.createForDevice(deviceA);

      expect(created).toMatchObject({
        deviceId: deviceA.id,
        status: SupportRequestStatus.WAITING,
        technicianId: null,
        technician: null,
        assignedAt: null,
        respondedAt: null,
        closedAt: null,
      });
      expect(created.id).toEqual(expect.any(String));
      expect(created.createdAt).toBeInstanceOf(Date);
    });

    it('rechaza con 409 una segunda solicitud mientras haya una activa', async () => {
      await service.createForDevice(deviceA);

      await expect(service.createForDevice(deviceA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(repository.rows).toHaveLength(1);
    });

    it('permite una solicitud nueva cuando la anterior quedo cerrada', async () => {
      const id = await seedRequest(deviceA);
      await service.cancelByDevice(id, deviceA);

      await expect(service.createForDevice(deviceA)).resolves.toMatchObject({
        status: SupportRequestStatus.WAITING,
      });
    });

    it('no bloquea a un dispositivo por la solicitud activa de otro', async () => {
      await service.createForDevice(deviceA);

      await expect(service.createForDevice(deviceB)).resolves.toMatchObject({
        deviceId: deviceB.id,
        status: SupportRequestStatus.WAITING,
      });
    });
  });

  describe('solicitud activa del dispositivo', () => {
    it('devuelve supportRequest: null cuando no hay ninguna activa', async () => {
      await expect(service.findCurrentForDevice(deviceA.id)).resolves.toEqual({
        supportRequest: null,
      });
    });

    it('devuelve la solicitud activa con el tecnico asignado', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);

      const { supportRequest } = await service.findCurrentForDevice(deviceA.id);

      expect(supportRequest).toMatchObject({
        id,
        status: SupportRequestStatus.ASSIGNED,
        technician: { id: technicianA.id, name: technicianA.fullName },
      });
      expect(supportRequest?.technician).not.toHaveProperty('email');
      expect(supportRequest?.technician).not.toHaveProperty('roles');
    });

    it('no devuelve la solicitud de otro dispositivo', async () => {
      await seedRequest(deviceA);

      await expect(service.findCurrentForDevice(deviceB.id)).resolves.toEqual({
        supportRequest: null,
      });
    });

    it('deja de devolverla cuando llega a un estado terminal', async () => {
      const id = await seedRequest(deviceA);
      await service.cancelByDevice(id, deviceA);

      await expect(service.findCurrentForDevice(deviceA.id)).resolves.toEqual({
        supportRequest: null,
      });
    });
  });

  describe('pertenencia de la solicitud', () => {
    it('no deja que un dispositivo acepte la solicitud de otro', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);

      await expect(service.acceptByDevice(id, deviceB)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.ASSIGNED);
    });

    it('no deja que un dispositivo rechace la solicitud de otro', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);

      await expect(service.rejectByDevice(id, deviceB)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.ASSIGNED);
    });

    it('no deja que un dispositivo cancele la solicitud de otro', async () => {
      const id = await seedRequest(deviceA);

      await expect(service.cancelByDevice(id, deviceB)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.WAITING);
    });
  });

  describe('asignacion por el tecnico', () => {
    it('pasa de WAITING a ASSIGNED con el tecnico autenticado', async () => {
      const id = await seedRequest(deviceA);

      const assigned = await service.assign(id, technicianA);

      expect(assigned).toMatchObject({
        id,
        status: SupportRequestStatus.ASSIGNED,
        technicianId: technicianA.id,
        technician: { id: technicianA.id, name: technicianA.fullName },
        respondedAt: null,
        closedAt: null,
      });
      expect(assigned.assignedAt).toBeInstanceOf(Date);
      expect(assigned.device).toMatchObject({
        publicId: deviceA.publicId,
        isOnline: true,
      });
    });

    it('avisa a la tablet con support:assigned y datos minimos del tecnico', async () => {
      const id = await seedRequest(deviceA);

      await service.assign(id, technicianA);

      expect(emitToDevice).toHaveBeenCalledTimes(1);
      expect(emitToDevice).toHaveBeenCalledWith(
        deviceA.id,
        SUPPORT_ASSIGNED_EVENT,
        {
          supportRequestId: id,
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

    it('rechaza con 409 si el dispositivo esta OFFLINE y la deja en WAITING', async () => {
      const id = await seedRequest(deviceA);
      online.delete(deviceA.id);

      await expect(service.assign(id, technicianA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.WAITING);
      expect(repository.rows[0].technicianId).toBeNull();
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('solo deja que un tecnico gane cuando dos asignan a la vez', async () => {
      const id = await seedRequest(deviceA);

      const results = await Promise.allSettled([
        service.assign(id, technicianA),
        service.assign(id, technicianB),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      const winner = (
        fulfilled[0] as PromiseFulfilledResult<{ technicianId: string | null }>
      ).value.technicianId;

      expect([technicianA.id, technicianB.id]).toContain(winner);
      expect(repository.rows[0].technicianId).toBe(winner);
      expect(emitToDevice).toHaveBeenCalledTimes(1);
    });

    it('no deja que un segundo tecnico se apropie de una solicitud ya asignada', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);

      await expect(service.assign(id, technicianB)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(repository.rows[0].technicianId).toBe(technicianA.id);
      expect(emitToDevice).not.toHaveBeenCalled();
    });

    it('no asigna una solicitud ya cerrada', async () => {
      const id = await seedRequest(deviceA);
      await service.cancelByDevice(id, deviceA);

      await expect(service.assign(id, technicianA)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('devuelve 404 con un id que no existe', async () => {
      await expect(
        service.assign(randomUUID(), technicianA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('respuesta del usuario del dispositivo', () => {
    it('acepta: ASSIGNED -> ACCEPTED con respondedAt y sin cerrar', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);

      const accepted = await service.acceptByDevice(id, deviceA);

      expect(accepted).toMatchObject({
        status: SupportRequestStatus.ACCEPTED,
        technicianId: technicianA.id,
        closedAt: null,
      });
      expect(accepted.respondedAt).toBeInstanceOf(Date);
    });

    it('no acepta una solicitud que todavia esta en WAITING', async () => {
      const id = await seedRequest(deviceA);

      await expect(service.acceptByDevice(id, deviceA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.WAITING);
    });

    it('rechaza: ASSIGNED -> REJECTED con respondedAt y closedAt', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);

      const rejected = await service.rejectByDevice(id, deviceA);

      expect(rejected.status).toBe(SupportRequestStatus.REJECTED);
      expect(rejected.respondedAt).toBeInstanceOf(Date);
      expect(rejected.closedAt).toBeInstanceOf(Date);
    });

    it('no vuelve a modificar una solicitud ya rechazada', async () => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ASSIGNED);
      await service.rejectByDevice(id, deviceA);

      await expect(service.cancelByDevice(id, deviceA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.REJECTED);
    });
  });

  describe('cancelacion desde el dispositivo', () => {
    it.each(ACTIVE_SUPPORT_REQUEST_STATUSES)(
      'cancela una solicitud en %s y la cierra',
      async (status) => {
        const id = await seedRequest(deviceA, status);

        const cancelled = await service.cancelByDevice(id, deviceA);

        expect(cancelled.status).toBe(SupportRequestStatus.CANCELLED);
        expect(cancelled.closedAt).toBeInstanceOf(Date);
      },
    );

    it('no cancela dos veces la misma solicitud', async () => {
      const id = await seedRequest(deviceA);
      await service.cancelByDevice(id, deviceA);

      await expect(service.cancelByDevice(id, deviceA)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('estado COMPLETED', () => {
    /**
     * `COMPLETED` lo escribe unicamente el cierre de una `RemoteSession`, en su
     * propia transaccion: ningun metodo de este servicio lo produce y no hay
     * endpoint que lo permita. Aqui solo se comprueba que, una vez escrito, se
     * comporta como estado terminal.
     */
    const seedCompleted = async (): Promise<string> => {
      const id = await seedRequest(deviceA, SupportRequestStatus.ACCEPTED);

      repository.rows[0].status = SupportRequestStatus.COMPLETED;

      return id;
    };

    it('no deja cancelar una solicitud ya completada', async () => {
      const id = await seedCompleted();

      await expect(service.cancelByDevice(id, deviceA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(statusOf(id)).toBe(SupportRequestStatus.COMPLETED);
    });

    it('no deja reasignar una solicitud ya completada', async () => {
      const id = await seedCompleted();

      await expect(service.assign(id, technicianB)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(repository.rows[0].technicianId).toBe(technicianA.id);
    });

    it('deja de contar como activa y el dispositivo puede abrir otra', async () => {
      await seedCompleted();

      await expect(service.findCurrentForDevice(deviceA.id)).resolves.toEqual({
        supportRequest: null,
      });

      await expect(service.createForDevice(deviceA)).resolves.toMatchObject({
        status: SupportRequestStatus.WAITING,
      });
    });
  });

  describe('consultas del tecnico', () => {
    it('lista filtrando por estado y de la mas antigua a la mas nueva', async () => {
      const first = await seedRequest(deviceA);
      // createdAt propio para que el orden no dependa de la resolucion del reloj.
      repository.rows[0].createdAt = new Date('2026-01-01T10:00:00.000Z');

      const second = await seedRequest(deviceB);
      repository.rows[1].createdAt = new Date('2026-01-01T11:00:00.000Z');

      await service.assign(second, technicianA);

      const waiting = await service.findAll({
        status: SupportRequestStatus.WAITING,
      });

      expect(waiting.map((request) => request.id)).toEqual([first]);

      const all = await service.findAll({});

      expect(all.map((request) => request.id)).toEqual([first, second]);
    });

    it('incluye el dispositivo con su presencia calculada, no persistida', async () => {
      const id = await seedRequest(deviceA);
      online.delete(deviceA.id);

      const [listed] = await service.findAll({});

      expect(listed.device).toEqual({
        id: deviceA.id,
        publicId: deviceA.publicId,
        name: deviceA.name,
        manufacturer: deviceA.manufacturer,
        model: deviceA.model,
        isOnline: false,
      });

      expect(repository.rows.find((row) => row.id === id)).not.toHaveProperty(
        'isOnline',
      );
    });

    it('devuelve 404 al consultar una solicitud inexistente', async () => {
      await expect(service.findOne(randomUUID())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
