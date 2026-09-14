import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { config as loadEnv } from 'dotenv';
import { DataSource, QueryRunner } from 'typeorm';
import { User } from '../src/auth/entities/user.entity';
import { ValidRoles } from '../src/auth/interfaces/valid-roles';
import { resolveDatabaseSsl } from '../src/config/database.config';
import { Device } from '../src/devices/entities/device.entity';
import { DevicePresenceService } from '../src/devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../src/devices/realtime/device-realtime.service';
import {
  ACTIVE_REMOTE_SESSION_INDEX,
  ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX,
  RemoteSession,
} from '../src/remote-sessions/entities/remote-session.entity';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from '../src/remote-sessions/enums/remote-session-status.enum';
import { RemoteSessionsService } from '../src/remote-sessions/remote-sessions.service';
import { TechnicianRealtimeService } from '../src/signaling/realtime/technician-realtime.service';
import { SupportRequest } from '../src/support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../src/support-requests/enums/support-request-status.enum';

/**
 * Invariantes de `remote_sessions` contra PostgreSQL de verdad.
 *
 * Las pruebas de `src/remote-sessions/*.spec.ts` sustituyen los repositorios
 * por dobles en memoria: reproducen la INTENCION de los indices unicos, pero no
 * demuestran que PostgreSQL los cree ni que serialice dos INSERT simultaneos.
 * Eso es exactamente lo que se comprueba aqui, porque la regla "un tecnico, una
 * sola sesion viva" no la sostiene el `SELECT` previo del servicio sino el
 * motor.
 *
 * NO forma parte de `npm test`: necesita red y una base real. Se ejecuta con
 * `npm run test:db` y usa la misma `DATABASE_URL` que la aplicacion.
 *
 * AISLAMIENTO: todo ocurre en un esquema temporal propio (`rc_test_<uuid>`) que
 * se crea al empezar y se borra al terminar. No se lee, no se escribe y no se
 * borra nada del esquema `public` de la aplicacion.
 *
 * `dotenv` se usa directamente porque es lo que `@nestjs/config` emplea para
 * leer el mismo `.env`; este fichero esta excluido de `tsconfig.build.json` y
 * nunca llega a `dist`.
 */

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL?.trim();

/** Esquema temporal: distinto en cada ejecucion, borrado al terminar. */
const TEST_SCHEMA = `rc_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** unique_violation */
const UNIQUE_VIOLATION = '23505';

/** Forma minima del error del driver, igual que en el servicio. */
interface PostgresError {
  code?: string;
  constraint?: string;
}

const postgresError = (error: unknown): PostgresError => {
  const driverError = (error as { driverError?: PostgresError }).driverError;

  return driverError ?? (error as PostgresError);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('remote_sessions contra PostgreSQL', () => {
  let dataSource: DataSource;
  let service: RemoteSessionsService;

  beforeAll(async () => {
    if (!DATABASE_URL)
      throw new Error(
        'DATABASE_URL no esta definido: `npm run test:db` necesita una base PostgreSQL real',
      );

    const ssl = resolveDatabaseSsl(DATABASE_URL);

    // TypeORM no crea el esquema por si solo: `synchronize` construye tablas e
    // indices, pero dentro de un esquema que ya tiene que existir.
    const bootstrap = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      ssl,
    });

    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    await bootstrap.destroy();

    dataSource = new DataSource({
      type: 'postgres',
      url: DATABASE_URL,
      ssl,
      schema: TEST_SCHEMA,
      // Solo las entidades que intervienen y las que cierran sus claves ajenas.
      entities: [User, Device, SupportRequest, RemoteSession],
      // Aqui si es seguro: el esquema acaba de nacer y se borra entero al
      // final. Es ademas lo que crea el indice que se esta comprobando.
      synchronize: true,
    });

    await dataSource.initialize();

    const moduleRef = await Test.createTestingModule({
      providers: [
        RemoteSessionsService,
        {
          provide: getRepositoryToken(RemoteSession),
          useValue: dataSource.getRepository(RemoteSession),
        },
        { provide: DataSource, useValue: dataSource },
        // La presencia y el transporte no son lo que se prueba aqui.
        { provide: DevicePresenceService, useValue: { isOnline: () => true } },
        {
          provide: DeviceRealtimeService,
          useValue: { emitToDevice: () => true },
        },
        {
          provide: TechnicianRealtimeService,
          useValue: { emitToTechnician: () => true },
        },
      ],
    }).compile();

    service = moduleRef.get(RemoteSessionsService);
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;

    // Se borra el esquema entero, nunca filas sueltas: nada de lo que hay aqui
    // pertenece a la aplicacion.
    await dataSource.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await dataSource.destroy();
  });

  // ---------------------------------------------------------------------------
  // Semillas
  // ---------------------------------------------------------------------------

  const seedTechnician = (): Promise<User> => {
    const users = dataSource.getRepository(User);

    return users.save(
      users.create({
        email: `tecnico-${randomUUID()}@test.local`,
        // No es una credencial: en este esquema efimero no se autentica nadie.
        password: 'not-a-credential',
        fullName: 'Tecnica de prueba',
        isActive: true,
        roles: [ValidRoles.tecnico],
      }),
    );
  };

  const seedDevice = (): Promise<Device> => {
    const devices = dataSource.getRepository(Device);

    return devices.save(
      devices.create({
        publicId: randomUUID(),
        name: 'Tablet de prueba',
        isActive: true,
      }),
    );
  };

  /**
   * Solicitud del tecnico sobre un dispositivo nuevo.
   *
   * `ACCEPTED` es lo unico que autoriza a `RemoteSessionsService.create`. Las
   * pruebas que insertan filas a pelo piden `COMPLETED`: solo necesitan una
   * fila que cierre la clave ajena, y asi no chocan con el indice unico parcial
   * de solicitud activa por dispositivo.
   */
  const seedRequest = async (
    technician: User,
    status: SupportRequestStatus = SupportRequestStatus.ACCEPTED,
    device?: Device,
  ): Promise<SupportRequest> => {
    const requests = dataSource.getRepository(SupportRequest);

    return requests.save(
      requests.create({
        deviceId: (device ?? (await seedDevice())).id,
        technicianId: technician.id,
        status,
        assignedAt: new Date(),
        respondedAt: new Date(),
        closedAt: null,
      }),
    );
  };

  const liveSessionsOfTechnician = (technicianId: string): Promise<number> =>
    dataSource
      .getRepository(RemoteSession)
      .createQueryBuilder('session')
      .where('session."technicianId" = :technicianId', { technicianId })
      .andWhere('session.status IN (:...live)', {
        live: [...ACTIVE_REMOTE_SESSION_STATUSES],
      })
      .getCount();

  /** INSERT directo, sin pasar por el servicio: solo lo decide el motor. */
  const insertLiveSession = (
    runner: QueryRunner,
    request: SupportRequest,
  ): Promise<unknown> =>
    runner.manager.insert(RemoteSession, {
      supportRequestId: request.id,
      deviceId: request.deviceId,
      technicianId: request.technicianId as string,
      status: RemoteSessionStatus.CONNECTING,
      connectedAt: null,
      endedAt: null,
      endedBy: null,
    });

  // ---------------------------------------------------------------------------
  // El indice
  // ---------------------------------------------------------------------------

  describe('indices de la tabla', () => {
    const indexes = (): Promise<{ indexname: string; indexdef: string }[]> =>
      dataSource.query(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE schemaname = $1 AND tablename = 'remote_sessions'`,
        [TEST_SCHEMA],
      );

    it('crea el unico parcial de sesion viva por tecnico', async () => {
      const index = (await indexes()).find(
        (row) => row.indexname === ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX,
      );

      expect(index).toBeDefined();
      expect(index?.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index?.indexdef).toContain('"technicianId"');

      // La condicion sale del enum, asi que se comprueba contra el enum.
      for (const status of ACTIVE_REMOTE_SESSION_STATUSES)
        expect(index?.indexdef).toContain(status);

      // Una sesion cerrada no ocupa sitio: por eso cerrar habilita otra sin
      // ninguna limpieza.
      expect(index?.indexdef).not.toContain(RemoteSessionStatus.CLOSED);
    });

    it('mantiene el unico parcial de sesion viva por dispositivo', async () => {
      const index = (await indexes()).find(
        (row) => row.indexname === ACTIVE_REMOTE_SESSION_INDEX,
      );

      expect(index).toBeDefined();
      expect(index?.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index?.indexdef).toContain('"deviceId"');
    });

    it('conserva el indice normal de technicianId para el historial', async () => {
      const normal = (await indexes()).filter(
        (row) =>
          row.indexdef.includes('"technicianId"') &&
          !row.indexdef.includes('UNIQUE'),
      );

      // El parcial solo cubre las sesiones vivas, que son una minoria de las
      // filas: consultar las cerradas de un tecnico sigue necesitando este.
      expect(normal).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // La carrera
  // ---------------------------------------------------------------------------

  describe('dos sesiones vivas simultaneas del mismo tecnico', () => {
    it('el motor bloquea la segunda hasta que la primera confirma y la rechaza con 23505', async () => {
      const technician = await seedTechnician();
      const first = await seedRequest(
        technician,
        SupportRequestStatus.COMPLETED,
      );
      const second = await seedRequest(
        technician,
        SupportRequestStatus.COMPLETED,
      );

      const a = dataSource.createQueryRunner();
      const b = dataSource.createQueryRunner();

      await a.connect();
      await b.connect();

      try {
        await a.startTransaction();
        await b.startTransaction();

        await insertLiveSession(a, first);

        // B no falla todavia ni pasa: PostgreSQL la deja esperando sobre el
        // indice unico hasta saber que hace A. Ninguna comprobacion de
        // aplicacion podria producir esto.
        let settled = false;
        const blocked = insertLiveSession(b, second).finally(() => {
          settled = true;
        });

        blocked.catch(() => undefined);

        await delay(1_000);

        expect(settled).toBe(false);

        await a.commitTransaction();

        await expect(blocked).rejects.toMatchObject({
          driverError: {
            code: UNIQUE_VIOLATION,
            constraint: ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX,
          },
        });

        await b.rollbackTransaction();
      } finally {
        await a.release();
        await b.release();
      }

      expect(await liveSessionsOfTechnician(technician.id)).toBe(1);
    });

    it('dos create simultaneos sobre dispositivos distintos dan una sesion y un 409', async () => {
      const technician = await seedTechnician();
      const first = await seedRequest(technician);
      const second = await seedRequest(technician);

      // Solicitudes y dispositivos distintos: no compiten por ninguna fila
      // bloqueada, asi que las dos transacciones pueden leerse a la vez sin
      // ver la sesion de la otra. Lo unico que las separa es el indice.
      const results = await Promise.allSettled([
        service.create({ supportRequestId: first.id }, technician),
        service.create({ supportRequestId: second.id }, technician),
      ]);

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);

      const rejected = results.filter((result) => result.status === 'rejected');

      expect(rejected).toHaveLength(1);
      // El cliente ve 409, no un QueryFailedError ni un 500.
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(postgresError(rejected[0].reason).code).toBeUndefined();

      expect(await liveSessionsOfTechnician(technician.id)).toBe(1);
    });

    it('la transaccion perdedora no deja nada a medias', async () => {
      const technician = await seedTechnician();
      const live = await seedRequest(technician);
      const rejectedRequest = await seedRequest(technician);

      await service.create({ supportRequestId: live.id }, technician);

      await expect(
        service.create({ supportRequestId: rejectedRequest.id }, technician),
      ).rejects.toBeInstanceOf(ConflictException);

      // La solicitud del segundo dispositivo sigue ACCEPTED: el tecnico podra
      // iniciarla en cuanto cierre la que tiene abierta.
      const stored = await dataSource
        .getRepository(SupportRequest)
        .findOneByOrFail({ id: rejectedRequest.id });

      expect(stored.status).toBe(SupportRequestStatus.ACCEPTED);
      expect(await liveSessionsOfTechnician(technician.id)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Convivencia con la restriccion por dispositivo
  // ---------------------------------------------------------------------------

  describe('las dos reglas a la vez', () => {
    it('sigue impidiendo dos sesiones vivas sobre el mismo dispositivo', async () => {
      const device = await seedDevice();
      const technicianA = await seedTechnician();
      const technicianB = await seedTechnician();

      const first = await seedRequest(
        technicianA,
        SupportRequestStatus.COMPLETED,
        device,
      );
      const second = await seedRequest(
        technicianB,
        SupportRequestStatus.COMPLETED,
        device,
      );

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await insertLiveSession(runner, first);

        // Tecnicos distintos: el indice por tecnico no tiene nada que decir y
        // el que responde es el de dispositivo.
        await expect(insertLiveSession(runner, second)).rejects.toMatchObject({
          driverError: {
            code: UNIQUE_VIOLATION,
            constraint: ACTIVE_REMOTE_SESSION_INDEX,
          },
        });
      } finally {
        await runner.release();
      }
    });

    it('deja a dos tecnicos distintos con una sesion viva cada uno', async () => {
      const technicianA = await seedTechnician();
      const technicianB = await seedTechnician();

      const first = await seedRequest(technicianA);
      const second = await seedRequest(technicianB);

      await expect(
        service.create({ supportRequestId: first.id }, technicianA),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });

      await expect(
        service.create({ supportRequestId: second.id }, technicianB),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });

      expect(await liveSessionsOfTechnician(technicianA.id)).toBe(1);
      expect(await liveSessionsOfTechnician(technicianB.id)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Cierre
  // ---------------------------------------------------------------------------

  describe('despues de cerrar', () => {
    it('el tecnico puede abrir otra sesion sin ninguna limpieza', async () => {
      const technician = await seedTechnician();
      const first = await seedRequest(technician);

      const opened = await service.create(
        { supportRequestId: first.id },
        technician,
      );

      await service.closeByTechnician(opened.id, technician);

      const second = await seedRequest(technician);

      await expect(
        service.create({ supportRequestId: second.id }, technician),
      ).resolves.toMatchObject({ status: RemoteSessionStatus.CONNECTING });

      // La fila cerrada sigue ahi, pero fuera del indice parcial.
      expect(await liveSessionsOfTechnician(technician.id)).toBe(1);

      const total = await dataSource
        .getRepository(RemoteSession)
        .countBy({ technicianId: technician.id });

      expect(total).toBe(2);
    });

    it('devuelve por GET current la unica sesion viva del tecnico', async () => {
      const technician = await seedTechnician();
      const first = await seedRequest(technician);

      const opened = await service.create(
        { supportRequestId: first.id },
        technician,
      );

      const { remoteSession } = await service.findCurrentForTechnician(
        technician.id,
      );

      expect(remoteSession).toMatchObject({
        id: opened.id,
        status: RemoteSessionStatus.CONNECTING,
      });

      await service.closeByTechnician(opened.id, technician);

      await expect(
        service.findCurrentForTechnician(technician.id),
      ).resolves.toEqual({ remoteSession: null });
    });
  });
});
