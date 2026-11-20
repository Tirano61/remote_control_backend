import { ConflictException, NotFoundException } from '@nestjs/common';
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
import { RemoteSessionEndedBy } from '../src/remote-sessions/enums/remote-session-ended-by.enum';
import {
  nextExpiry,
  SystemCloseReason,
} from '../src/remote-sessions/lifecycle/remote-session-expiry.policy';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from '../src/remote-sessions/enums/remote-session-status.enum';
import {
  REMOTE_SESSION_CLOSED_EVENT,
  RemoteSessionsService,
} from '../src/remote-sessions/remote-sessions.service';
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

  // El transporte no se prueba aqui, pero si CUANTOS avisos de cierre salen y
  // con que `endedBy`: un cierre concurrente no puede producir avisos dobles ni
  // contradictorios.
  const emitToDevice = jest.fn().mockReturnValue(true);
  const emitToTechnician = jest.fn().mockReturnValue(true);

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
          useValue: { emitToDevice },
        },
        {
          provide: TechnicianRealtimeService,
          useValue: {
            emitToTechnician,
            emitToAllTechnicians: () => true,
          },
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

  /** Tecnico, solicitud ACCEPTED y sesion CONNECTING, por el flujo real. */
  const seedLiveSession = async (): Promise<{
    technician: User;
    supportRequestId: string;
    remoteSessionId: string;
  }> => {
    const technician = await seedTechnician();
    const request = await seedRequest(technician);

    const { id } = await service.create(
      { supportRequestId: request.id },
      technician,
    );

    return {
      technician,
      supportRequestId: request.id,
      remoteSessionId: id,
    };
  };

  const storedSession = (id: string): Promise<RemoteSession> =>
    dataSource.getRepository(RemoteSession).findOneByOrFail({ id });

  const storedRequest = (id: string): Promise<SupportRequest> =>
    dataSource.getRepository(SupportRequest).findOneByOrFail({ id });

  /** `CONNECTING | ACTIVE -> CLOSED` a pelo, para poder dejarlo sin confirmar. */
  const closeSessionRaw = (runner: QueryRunner, id: string): Promise<unknown> =>
    runner.manager
      .createQueryBuilder()
      .update(RemoteSession)
      .set({
        status: RemoteSessionStatus.CLOSED,
        endedAt: new Date(),
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
      })
      .where('id = :id', { id })
      .execute();

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
  // Activacion
  // ---------------------------------------------------------------------------

  describe('CONNECTING -> ACTIVE', () => {
    it('activa la sesion y escribe connectedAt una sola vez', async () => {
      const { technician, remoteSessionId, supportRequestId } =
        await seedLiveSession();

      expect((await storedSession(remoteSessionId)).connectedAt).toBeNull();

      const activated = await service.activateByTechnician(
        remoteSessionId,
        technician,
      );

      expect(activated.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(activated.connectedAt).toBeInstanceOf(Date);

      const stored = await storedSession(remoteSessionId);

      expect(stored.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(stored.connectedAt).toEqual(activated.connectedAt);

      // La solicitud no se toca al activar: sigue asociada a la asistencia
      // hasta que la sesion cierre.
      expect((await storedRequest(supportRequestId)).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );

      // Y sigue siendo la unica sesion viva del tecnico: ACTIVE tambien cuenta.
      expect(await liveSessionsOfTechnician(technician.id)).toBe(1);
    });

    it('un reintento devuelve la misma sesion sin mover connectedAt', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      const first = await service.activateByTechnician(
        remoteSessionId,
        technician,
      );

      const second = await service.activateByTechnician(
        remoteSessionId,
        technician,
      );

      expect(second.status).toBe(RemoteSessionStatus.ACTIVE);
      expect(second.connectedAt).toEqual(first.connectedAt);
      expect((await storedSession(remoteSessionId)).connectedAt).toEqual(
        first.connectedAt,
      );
    });

    it('una sesion CLOSED no vuelve a abrirse', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technician,
      );

      await expect(
        service.activateByTechnician(remoteSessionId, technician),
      ).rejects.toBeInstanceOf(ConflictException);

      const stored = await storedSession(remoteSessionId);

      expect(stored.status).toBe(RemoteSessionStatus.CLOSED);
      expect(stored.endedAt).toEqual(closed.endedAt);
      expect(stored.connectedAt).toBeNull();
    });

    it('la sesion de otro tecnico responde 404 y no se activa', async () => {
      const { remoteSessionId } = await seedLiveSession();
      const other = await seedTechnician();

      await expect(
        service.activateByTechnician(remoteSessionId, other),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect((await storedSession(remoteSessionId)).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // La carrera activate / close
  // ---------------------------------------------------------------------------

  describe('activar y cerrar a la vez', () => {
    it('el motor bloquea el activate mientras el cierre no confirma, y despues responde 409', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();

        // Cierre sin confirmar: la fila queda bloqueada.
        await closeSessionRaw(runner, remoteSessionId);

        // El `SELECT ... FOR UPDATE` de la activacion no puede leer la fila ni
        // decidir nada hasta saber que hace el cierre. Ninguna comprobacion de
        // aplicacion podria producir esto.
        let settled = false;
        const blocked = service
          .activateByTechnician(remoteSessionId, technician)
          .finally(() => {
            settled = true;
          });

        blocked.catch(() => undefined);

        await delay(1_000);

        expect(settled).toBe(false);

        await runner.commitTransaction();

        // Al reevaluar la fila bloqueada ya lee CLOSED: terminal.
        await expect(blocked).rejects.toBeInstanceOf(ConflictException);
      } finally {
        await runner.release();
      }

      const stored = await storedSession(remoteSessionId);

      expect(stored.status).toBe(RemoteSessionStatus.CLOSED);
      expect(stored.connectedAt).toBeNull();
    });

    it('el cierre espera a la activacion y despues hace ACTIVE -> CLOSED', async () => {
      const { technician, remoteSessionId, supportRequestId } =
        await seedLiveSession();

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();

        // Activacion sin confirmar, con el mismo lock que toma el servicio.
        await runner.manager.findOne(RemoteSession, {
          where: { id: remoteSessionId },
          lock: { mode: 'pessimistic_write' },
        });

        await runner.manager
          .createQueryBuilder()
          .update(RemoteSession)
          .set({
            status: RemoteSessionStatus.ACTIVE,
            connectedAt: new Date(),
          })
          .where('id = :id', { id: remoteSessionId })
          .execute();

        let settled = false;
        const blocked = service
          .closeByTechnician(remoteSessionId, technician)
          .finally(() => {
            settled = true;
          });

        blocked.catch(() => undefined);

        await delay(1_000);

        expect(settled).toBe(false);

        await runner.commitTransaction();

        // El UPDATE condicional reevalua la fila ya ACTIVE, que sigue viva.
        await expect(blocked).resolves.toMatchObject({
          status: RemoteSessionStatus.CLOSED,
          endedBy: RemoteSessionEndedBy.TECHNICIAN,
        });
      } finally {
        await runner.release();
      }

      const stored = await storedSession(remoteSessionId);

      expect(stored.status).toBe(RemoteSessionStatus.CLOSED);
      // La conexion queda registrada aunque la sesion termine.
      expect(stored.connectedAt).toBeInstanceOf(Date);
      expect((await storedRequest(supportRequestId)).status).toBe(
        SupportRequestStatus.COMPLETED,
      );
    });

    it('activate y close simultaneos no dejan un estado imposible', async () => {
      const { technician, remoteSessionId, supportRequestId } =
        await seedLiveSession();

      const [activate, close] = await Promise.allSettled([
        service.activateByTechnician(remoteSessionId, technician),
        service.closeByTechnician(remoteSessionId, technician),
      ]);

      // Quien pierde ve un 409, nunca un 500 ni el error del driver.
      for (const result of [activate, close])
        if (result.status === 'rejected')
          expect(result.reason).toBeInstanceOf(ConflictException);

      const stored = await storedSession(remoteSessionId);

      expect([
        RemoteSessionStatus.ACTIVE,
        RemoteSessionStatus.CLOSED,
      ]).toContain(stored.status);

      if (stored.status === RemoteSessionStatus.CLOSED) {
        expect(close.status).toBe('fulfilled');
        expect(stored.endedAt).toBeInstanceOf(Date);
        expect(stored.endedBy).not.toBeNull();
        expect((await storedRequest(supportRequestId)).status).toBe(
          SupportRequestStatus.COMPLETED,
        );

        // CLOSED es terminal: si llego a activarse, fue antes del cierre.
        if (stored.connectedAt)
          expect(stored.connectedAt.getTime()).toBeLessThanOrEqual(
            (stored.endedAt as Date).getTime(),
          );
      } else {
        // El cierre perdio: entonces tuvo que fallar y la solicitud sigue viva.
        expect(activate.status).toBe('fulfilled');
        expect(stored.connectedAt).toBeInstanceOf(Date);
        expect(stored.endedAt).toBeNull();
        expect((await storedRequest(supportRequestId)).status).toBe(
          SupportRequestStatus.ACCEPTED,
        );
      }
    });

    it('nunca deja CLOSED volver a ACTIVE, se llame como se llame', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      await service.activateByTechnician(remoteSessionId, technician);
      await service.closeByTechnician(remoteSessionId, technician);

      // Varios reintentos tardios del cliente sobre una sesion ya cerrada.
      const retries = await Promise.allSettled([
        service.activateByTechnician(remoteSessionId, technician),
        service.activateByTechnician(remoteSessionId, technician),
      ]);

      for (const retry of retries) {
        expect(retry.status).toBe('rejected');
        expect((retry as PromiseRejectedResult).reason).toBeInstanceOf(
          ConflictException,
        );
      }

      expect((await storedSession(remoteSessionId)).status).toBe(
        RemoteSessionStatus.CLOSED,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Cierre
  // ---------------------------------------------------------------------------

  describe('cierre del sistema (SYSTEM)', () => {
    const always = () => true;

    const onlyIfConnecting = (session: { status: RemoteSessionStatus }) =>
      session.status === RemoteSessionStatus.CONNECTING;

    it('cierra con SYSTEM y completa la solicitud en la misma transaccion', async () => {
      const { remoteSessionId, supportRequestId } = await seedLiveSession();

      const closed = await service.closeBySystem(remoteSessionId, always);

      expect(closed?.endedBy).toBe(RemoteSessionEndedBy.SYSTEM);

      const stored = await storedSession(remoteSessionId);
      const request = await storedRequest(supportRequestId);

      expect(stored).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });
      expect(request.status).toBe(SupportRequestStatus.COMPLETED);
      expect(request.closedAt?.getTime()).toBe(stored.endedAt?.getTime());
    });

    it('espera al lock de un cierre del tecnico sin confirmar y despues no hace nada', async () => {
      const { remoteSessionId } = await seedLiveSession();

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();

        await closeSessionRaw(runner, remoteSessionId);

        let settled = false;
        const blocked = service
          .closeBySystem(remoteSessionId, always)
          .finally(() => {
            settled = true;
          });

        blocked.catch(() => undefined);

        await delay(1_000);

        // El SELECT ... FOR UPDATE del sistema espera al cierre del tecnico.
        expect(settled).toBe(false);

        await runner.commitTransaction();

        await expect(blocked).resolves.toBeNull();
      } finally {
        await runner.release();
      }

      expect((await storedSession(remoteSessionId)).endedBy).toBe(
        RemoteSessionEndedBy.TECHNICIAN,
      );
    });

    /** Avisos `remote-session:closed` emitidos, por destinatario. */
    const closedNotices = () => ({
      device: emitToDevice.mock.calls
        .filter(([, event]) => event === REMOTE_SESSION_CLOSED_EVENT)
        .map(([, , payload]) => payload as { endedBy: RemoteSessionEndedBy }),
      technician: emitToTechnician.mock.calls
        .filter(([, event]) => event === REMOTE_SESSION_CLOSED_EVENT)
        .map(([, , payload]) => payload as { endedBy: RemoteSessionEndedBy }),
    });

    /**
     * Lo que tiene que quedar en PostgreSQL tras CUALQUIER carrera de cierre:
     * una sola transicion terminal con el `endedBy` del ganador y la solicitud
     * COMPLETED una sola vez, con el mismo instante que la sesion.
     */
    const expectSingleTerminalTransition = async (
      remoteSessionId: string,
      supportRequestId: string,
      endedBy: RemoteSessionEndedBy,
    ): Promise<void> => {
      const stored = await storedSession(remoteSessionId);
      const request = await storedRequest(supportRequestId);

      expect(stored).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy,
      });
      expect(request.status).toBe(SupportRequestStatus.COMPLETED);
      // El `closedAt` es el del cierre ganador: nadie lo reescribio despues.
      expect(request.closedAt?.getTime()).toBe(stored.endedAt?.getTime());
    };

    /** Carreras repetidas: un orden fijo podria ocultar un fallo. */
    const RACE_ROUNDS = 8;

    /**
     * Retraso (ms) con el que arranca el SEGUNDO cierre de cada ronda.
     *
     * Los tres cierres empiezan bloqueando la fila, asi que con arranque
     * simultaneo casi siempre gana el que sale primero. Por eso las rondas
     * pares sale primero el cierre manual y las impares SYSTEM, con retrasos
     * escalonados: quedan ejercitadas las dos ramas (gana SYSTEM / gana el
     * manual). No se exige un reparto concreto de ganadores: depende del motor
     * y haria la prueba inestable.
     */
    const SECOND_START_OFFSETS_MS = [0, 0, 1, 1, 3, 3, 8, 8];

    it.each([
      ['el tecnico', RemoteSessionEndedBy.TECHNICIAN],
      ['el dispositivo', RemoteSessionEndedBy.DEVICE],
    ])(
      'SYSTEM y %s simultaneos: una sola transicion, endedBy del ganador, solicitud COMPLETED y avisos coherentes',
      async (_label, manualEndedBy) => {
        const winners: string[] = [];

        for (let round = 0; round < RACE_ROUNDS; round += 1) {
          const { technician, remoteSessionId, supportRequestId } =
            await seedLiveSession();
          const { deviceId } = await storedSession(remoteSessionId);

          emitToDevice.mockClear();
          emitToTechnician.mockClear();

          const manualClose = () =>
            manualEndedBy === RemoteSessionEndedBy.TECHNICIAN
              ? service.closeByTechnician(remoteSessionId, technician)
              : service.closeByDevice(remoteSessionId, {
                  id: deviceId,
                } as Device);

          const systemClose = () =>
            service.closeBySystem(remoteSessionId, always);
          const offset = () => delay(SECOND_START_OFFSETS_MS[round]);

          // Rondas pares: primero el manual. Impares: primero SYSTEM.
          const manualFirst = round % 2 === 0;
          const manualCloseResult: Promise<{ endedBy: unknown }> = manualFirst
            ? manualClose()
            : offset().then(manualClose);
          const systemCloseResult = manualFirst
            ? offset().then(systemClose)
            : systemClose();

          const [system, manual] = await Promise.allSettled([
            systemCloseResult,
            manualCloseResult,
          ]);

          const systemWon =
            system.status === 'fulfilled' && system.value !== null;

          // El cierre manual nunca falla: si gano, devuelve su propio cierre;
          // si perdio, confirma el de SYSTEM (cierre idempotente).
          expect(manual.status).toBe('fulfilled');

          const winner = systemWon
            ? RemoteSessionEndedBy.SYSTEM
            : manualEndedBy;

          expect(
            (manual as PromiseFulfilledResult<{ endedBy: unknown }>).value
              .endedBy,
          ).toBe(winner);

          winners.push(winner);

          await expectSingleTerminalTransition(
            remoteSessionId,
            supportRequestId,
            winner,
          );

          // Avisos: todos con el `endedBy` ganador, y los que tocan.
          const notices = closedNotices();
          const all = [...notices.device, ...notices.technician];

          expect(all.every((payload) => payload.endedBy === winner)).toBe(true);

          if (winner === RemoteSessionEndedBy.SYSTEM) {
            expect(notices.device).toHaveLength(1);
            expect(notices.technician).toHaveLength(1);
          } else if (winner === RemoteSessionEndedBy.TECHNICIAN) {
            expect(notices.device).toHaveLength(1);
            expect(notices.technician).toHaveLength(0);
          } else {
            expect(notices.device).toHaveLength(0);
            expect(notices.technician).toHaveLength(1);
          }
        }

        // Evidencia del reparto real de ganadores en esta ejecucion.
        process.stdout.write(
          `  [race SYSTEM vs ${manualEndedBy}] winners: ${winners.join(', ')}\n`,
        );
      },
    );

    it('tres cierres SYSTEM simultaneos: uno cierra, los demas no hacen nada', async () => {
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const { remoteSessionId, supportRequestId } = await seedLiveSession();

        emitToDevice.mockClear();
        emitToTechnician.mockClear();

        const results = await Promise.all([
          service.closeBySystem(remoteSessionId, always),
          service.closeBySystem(remoteSessionId, always),
          service.closeBySystem(remoteSessionId, always),
        ]);

        expect(results.filter((result) => result !== null)).toHaveLength(1);

        await expectSingleTerminalTransition(
          remoteSessionId,
          supportRequestId,
          RemoteSessionEndedBy.SYSTEM,
        );

        // Un solo aviso por extremo, aunque hubiera tres intentos.
        const notices = closedNotices();

        expect(notices.device).toEqual([
          { remoteSessionId, endedBy: RemoteSessionEndedBy.SYSTEM },
        ]);
        expect(notices.technician).toEqual([
          { remoteSessionId, endedBy: RemoteSessionEndedBy.SYSTEM },
        ]);
      }
    });

    it('un vencimiento de CONNECTING bloqueado tras un activate sin confirmar no cierra la sesion ya ACTIVE', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();

        // Activacion sin confirmar, con el mismo lock que toma el servicio.
        await runner.manager.findOne(RemoteSession, {
          where: { id: remoteSessionId, technicianId: technician.id },
          lock: { mode: 'pessimistic_write' },
        });

        await runner.manager
          .createQueryBuilder()
          .update(RemoteSession)
          .set({
            status: RemoteSessionStatus.ACTIVE,
            connectedAt: new Date(),
          })
          .where('id = :id', { id: remoteSessionId })
          .execute();

        const blocked = service.closeBySystem(
          remoteSessionId,
          onlyIfConnecting,
        );

        blocked.catch(() => undefined);

        await delay(500);
        await runner.commitTransaction();

        // Al reevaluar la fila bloqueada lee ACTIVE: el TTL ya no aplica.
        await expect(blocked).resolves.toBeNull();
      } finally {
        await runner.release();
      }

      expect((await storedSession(remoteSessionId)).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
    });

    it('activate y vencimiento de CONNECTING simultaneos no dejan un estado imposible', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      const [activate, expire] = await Promise.allSettled([
        service.activateByTechnician(remoteSessionId, technician),
        service.closeBySystem(remoteSessionId, onlyIfConnecting),
      ]);

      const stored = await storedSession(remoteSessionId);

      if (activate.status === 'fulfilled') {
        expect(stored.status).toBe(RemoteSessionStatus.ACTIVE);
        expect(expire).toEqual({ status: 'fulfilled', value: null });
      } else {
        expect(activate.reason).toBeInstanceOf(ConflictException);
        expect(stored).toMatchObject({
          status: RemoteSessionStatus.CLOSED,
          endedBy: RemoteSessionEndedBy.SYSTEM,
          connectedAt: null,
        });
      }
    });

    it('una sesion CLOSED no vuelve a cerrarse ni cambia su endedBy', async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      const closed = await service.closeByTechnician(
        remoteSessionId,
        technician,
      );

      await expect(
        service.closeBySystem(remoteSessionId, always),
      ).resolves.toBeNull();

      const stored = await storedSession(remoteSessionId);

      expect(stored.endedBy).toBe(RemoteSessionEndedBy.TECHNICIAN);
      expect(stored.endedAt?.getTime()).toBe(closed.endedAt?.getTime());
    });

    it('lista las sesiones vivas para la reconciliacion de arranque', async () => {
      const { remoteSessionId } = await seedLiveSession();
      const closedOne = await seedLiveSession();

      await service.closeBySystem(closedOne.remoteSessionId, always);

      const live = await service.findLiveSessions();
      const ids = live.map((session) => session.id);

      expect(ids).toContain(remoteSessionId);
      expect(ids).not.toContain(closedOne.remoteSessionId);
      expect(live.find((session) => session.id === remoteSessionId)).toEqual(
        expect.objectContaining({
          status: RemoteSessionStatus.CONNECTING,
          createdAt: expect.any(Date) as Date,
        }),
      );
    });
  });

  describe('TTL de CONNECTING y zona horaria del proceso', () => {
    /**
     * Las columnas de `remote_sessions` son `timestamp without time zone`.
     * `pg` escribe un `Date` en la hora local del proceso y lo lee tambien como
     * hora local; PostgreSQL descarta el offset del literal. Si `createdAt` lo
     * generara la base (`DEFAULT now()`, en la zona de la SESION de PostgreSQL)
     * y `connectedAt`/`endedAt` el proceso, convivirian dos relojes y el TTL,
     * que se calcula en Node desde `createdAt`, venceria desplazado tantas horas
     * como separen ambas zonas: tarde con offsets negativos, de inmediato con
     * positivos. Esta prueba mide el vencimiento contra el instante real de
     * creacion. La zona del proceso la fija `test/db-global-setup.ts` (no UTC
     * por defecto; otra con `TEST_DB_TZ`), porque en UTC el defecto no se ve.
     */
    const zone = `${Intl.DateTimeFormat().resolvedOptions().timeZone} (UTC${-new Date().getTimezoneOffset() / 60 >= 0 ? '+' : ''}${-new Date().getTimezoneOffset() / 60})`;
    const TTL_MS = 120_000;
    const config = {
      disconnectGraceMs: 60_000,
      connectingTtlMs: TTL_MS,
      startupRecoveryMs: 5_000,
    };
    // Nadie participa: en CONNECTING solo cuenta el TTL.
    const nobody = { isPresent: () => false, absentSince: () => null };
    // Arranque muy anterior: la ventana de recuperacion no interviene.
    const longAgo = 0;

    /** Envejece la fila en PostgreSQL sin cambiar la convencion de escritura. */
    const ageSession = (id: string, seconds: number): Promise<unknown> =>
      dataSource.query(
        `UPDATE "${TEST_SCHEMA}"."remote_sessions"
            SET "createdAt" = "createdAt" - make_interval(secs => $2)
          WHERE id = $1`,
        [id, seconds],
      );

    it(`zona del proceso ${zone}: createdAt es el instante real y el TTL vence a los 120 s`, async () => {
      const before = Date.now();
      const { remoteSessionId } = await seedLiveSession();
      const after = Date.now();

      // Lo que ve Node al releer de PostgreSQL, igual que la reconciliacion.
      const [stored] = (await service.findLiveSessions()).filter(
        (session) => session.id === remoteSessionId,
      );
      const createdAt = stored.createdAt.getTime();

      // Margen de 1 s por la precision de la columna y el reloj de la base.
      expect(createdAt).toBeGreaterThanOrEqual(before - 1_000);
      expect(createdAt).toBeLessThanOrEqual(after + 1_000);

      const expiry = nextExpiry(stored, nobody, config, longAgo);

      expect(expiry?.reason).toBe(SystemCloseReason.CONNECTING_TTL);
      expect(expiry?.at).toBe(createdAt + TTL_MS);

      // Recien creada: no vence; tampoco con la fila bloqueada.
      await expect(
        service.closeBySystem(
          remoteSessionId,
          (session, now) =>
            (nextExpiry(session, nobody, config, longAgo)?.at ?? Infinity) <=
            now.getTime(),
        ),
      ).resolves.toBeNull();

      // 119 s despues de crearse: todavia no.
      await ageSession(remoteSessionId, 119);
      const at119 = (await service.findLiveSession(remoteSessionId))!;
      expect(nextExpiry(at119, nobody, config, longAgo)!.at).toBeGreaterThan(
        Date.now(),
      );

      // 121 s: vencida, y el cierre real con la fila bloqueada la cierra.
      await ageSession(remoteSessionId, 2);

      const closed = await service.closeBySystem(
        remoteSessionId,
        (session, now) =>
          (nextExpiry(session, nobody, config, longAgo)?.at ?? Infinity) <=
          now.getTime(),
      );

      expect(closed).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });

      // Los tres instantes quedan en el mismo reloj: endedAt - createdAt es
      // la vida real de la sesion (~121 s), no unas horas.
      const [row] = await dataSource.query<Array<{ lived: number }>>(
        `SELECT EXTRACT(EPOCH FROM ("endedAt" - "createdAt"))::float AS lived
             FROM "${TEST_SCHEMA}"."remote_sessions" WHERE id = $1`,
        [remoteSessionId],
      );

      expect(row.lived).toBeGreaterThanOrEqual(120);
      expect(row.lived).toBeLessThan(125);
    });

    it(`zona del proceso ${zone}: connectedAt - createdAt es el tiempo real hasta la activacion`, async () => {
      const { technician, remoteSessionId } = await seedLiveSession();

      await service.activateByTechnician(remoteSessionId, technician);

      const [row] = await dataSource.query<Array<{ gap: number }>>(
        `SELECT EXTRACT(EPOCH FROM ("connectedAt" - "createdAt"))::float AS gap
           FROM "${TEST_SCHEMA}"."remote_sessions" WHERE id = $1`,
        [remoteSessionId],
      );

      expect(row.gap).toBeGreaterThanOrEqual(0);
      expect(row.gap).toBeLessThan(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Cierre idempotente (tecnico y dispositivo)
  // ---------------------------------------------------------------------------

  describe('cierre idempotente', () => {
    const always = () => true;

    /** Rondas de cada carrera: un orden fijo podria ocultar un fallo. */
    const ROUNDS = 8;

    /** Sesion viva por el flujo real, con el dispositivo a mano. */
    const seedSessionWithDevice = async () => {
      const seeded = await seedLiveSession();
      const { deviceId } = await storedSession(seeded.remoteSessionId);

      emitToDevice.mockClear();
      emitToTechnician.mockClear();

      return { ...seeded, device: { id: deviceId } as Device };
    };

    /**
     * `xmin` de la fila: el id de la transaccion que escribio su version
     * vigente. Si un reintento no cambia el `xmin`, PostgreSQL no escribio la
     * fila: no hubo UPDATE, ni siquiera uno que dejara los mismos valores.
     */
    const xminOf = async (
      table: 'remote_sessions' | 'support_requests',
      id: string,
    ): Promise<string> => {
      const [row] = await dataSource.query<{ xmin: string }[]>(
        `SELECT xmin::text AS xmin FROM "${TEST_SCHEMA}"."${table}" WHERE id = $1`,
        [id],
      );

      return row.xmin;
    };

    /** `(destinatario, evento, payload)` de cada aviso emitido. */
    type Emitted = [string, string, unknown];

    /** Avisos `remote-session:closed` emitidos, a los dos extremos. */
    const closedNotices = (): Emitted[] =>
      [
        ...(emitToDevice.mock.calls as Emitted[]),
        ...(emitToTechnician.mock.calls as Emitted[]),
      ].filter(([, event]) => event === REMOTE_SESSION_CLOSED_EVENT);

    it('el primer cierre escribe una vez; el reintento devuelve lo mismo sin escribir nada', async () => {
      const { technician, remoteSessionId, supportRequestId } =
        await seedSessionWithDevice();

      const first = await service.closeByTechnician(
        remoteSessionId,
        technician,
      );

      const sessionXmin = await xminOf('remote_sessions', remoteSessionId);
      const requestXmin = await xminOf('support_requests', supportRequestId);
      const storedRequestBefore = await storedRequest(supportRequestId);

      // Respuesta perdida: el cliente reintenta tres veces.
      const retries: (typeof first)[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1)
        retries.push(
          await service.closeByTechnician(remoteSessionId, technician),
        );

      for (const retry of retries) expect(retry).toEqual(first);

      expect(first).toMatchObject({
        status: RemoteSessionStatus.CLOSED,
        endedBy: RemoteSessionEndedBy.TECHNICIAN,
      });
      // El `endedAt` de la respuesta es el persistido, tambien fuera de UTC.
      expect(first.endedAt?.getTime()).toBe(
        (await storedSession(remoteSessionId)).endedAt?.getTime(),
      );
      expect(await xminOf('remote_sessions', remoteSessionId)).toBe(
        sessionXmin,
      );
      expect(await xminOf('support_requests', supportRequestId)).toBe(
        requestXmin,
      );
      expect(await storedRequest(supportRequestId)).toEqual(
        storedRequestBefore,
      );
      expect(storedRequestBefore.closedAt?.getTime()).toBe(
        first.endedAt?.getTime(),
      );
      // Un unico aviso, el del primer cierre.
      expect(closedNotices()).toHaveLength(1);
    });

    it.each([
      [
        'tecnico, luego dispositivo',
        RemoteSessionEndedBy.TECHNICIAN,
        RemoteSessionEndedBy.DEVICE,
      ],
      [
        'dispositivo, luego tecnico',
        RemoteSessionEndedBy.DEVICE,
        RemoteSessionEndedBy.TECHNICIAN,
      ],
      [
        'SYSTEM, luego tecnico',
        RemoteSessionEndedBy.SYSTEM,
        RemoteSessionEndedBy.TECHNICIAN,
      ],
      [
        'SYSTEM, luego dispositivo',
        RemoteSessionEndedBy.SYSTEM,
        RemoteSessionEndedBy.DEVICE,
      ],
    ])(
      'cierre desde el otro extremo (%s): conserva el primer cierre',
      async (_label, firstBy, lateBy) => {
        const { technician, device, remoteSessionId, supportRequestId } =
          await seedSessionWithDevice();

        const closeAs = (endedBy: RemoteSessionEndedBy) =>
          endedBy === RemoteSessionEndedBy.TECHNICIAN
            ? service.closeByTechnician(remoteSessionId, technician)
            : endedBy === RemoteSessionEndedBy.DEVICE
              ? service.closeByDevice(remoteSessionId, device)
              : service.closeBySystem(remoteSessionId, always);

        const first = await closeAs(firstBy);
        const noticesAfterFirst = closedNotices().length;
        const sessionXmin = await xminOf('remote_sessions', remoteSessionId);
        const requestXmin = await xminOf('support_requests', supportRequestId);

        const late = await closeAs(lateBy);

        expect(late).toMatchObject({
          id: remoteSessionId,
          status: RemoteSessionStatus.CLOSED,
          endedBy: firstBy,
        });
        expect(late?.endedAt?.getTime()).toBe(first?.endedAt?.getTime());
        expect(await xminOf('remote_sessions', remoteSessionId)).toBe(
          sessionXmin,
        );
        expect(await xminOf('support_requests', supportRequestId)).toBe(
          requestXmin,
        );
        expect(closedNotices()).toHaveLength(noticesAfterFirst);
      },
    );

    it('un cierre que llega con la fila bloqueada espera y confirma el cierre ajeno', async () => {
      const { device, remoteSessionId, supportRequestId } =
        await seedSessionWithDevice();

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();

        // Otro cierre, todavia sin confirmar, con el mismo lock que el
        // servicio: la fila queda bloqueada.
        await runner.manager.findOne(RemoteSession, {
          where: { id: remoteSessionId },
          lock: { mode: 'pessimistic_write' },
        });
        await closeSessionRaw(runner, remoteSessionId);
        await runner.manager
          .createQueryBuilder()
          .update(SupportRequest)
          .set({
            status: SupportRequestStatus.COMPLETED,
            closedAt: new Date(),
          })
          .where('id = :id', { id: supportRequestId })
          .execute();

        let settled = false;
        const blocked = service
          .closeByDevice(remoteSessionId, device)
          .finally(() => {
            settled = true;
          });

        blocked.catch(() => undefined);

        await delay(1_000);

        // El SELECT ... FOR UPDATE espera: no decide con una lectura vieja.
        expect(settled).toBe(false);

        await runner.commitTransaction();

        // Al obtener la fila ya lee CLOSED/TECHNICIAN y lo confirma tal cual.
        await expect(blocked).resolves.toMatchObject({
          status: RemoteSessionStatus.CLOSED,
          endedBy: RemoteSessionEndedBy.TECHNICIAN,
        });
      } finally {
        await runner.release();
      }

      expect((await storedSession(remoteSessionId)).endedBy).toBe(
        RemoteSessionEndedBy.TECHNICIAN,
      );
      // El cierre que espero no emitio nada.
      expect(closedNotices()).toHaveLength(0);
    });

    type Actor = 'TECHNICIAN' | 'DEVICE' | 'SYSTEM';

    it.each<[string, Actor[]]>([
      ['WEB + DEVICE', ['TECHNICIAN', 'DEVICE']],
      ['WEB + WEB', ['TECHNICIAN', 'TECHNICIAN']],
      ['DEVICE + DEVICE', ['DEVICE', 'DEVICE']],
      ['WEB + SYSTEM', ['TECHNICIAN', 'SYSTEM']],
      ['DEVICE + SYSTEM', ['DEVICE', 'SYSTEM']],
      ['tres actores', ['TECHNICIAN', 'DEVICE', 'SYSTEM']],
      [
        'tres actores con reintentos',
        ['DEVICE', 'TECHNICIAN', 'SYSTEM', 'TECHNICIAN', 'DEVICE', 'SYSTEM'],
      ],
    ])(
      'cierres simultaneos %s: una sola transicion, todos confirman al ganador',
      async (_label, actors) => {
        const winners: string[] = [];

        for (let round = 0; round < ROUNDS; round += 1) {
          const { technician, device, remoteSessionId, supportRequestId } =
            await seedSessionWithDevice();

          // Se rota quien sale primero para no fijar siempre al mismo ganador.
          const order = actors.map(
            (_, index) => actors[(index + round) % actors.length],
          );

          const results = await Promise.allSettled(
            order.map((actor) =>
              actor === 'TECHNICIAN'
                ? service.closeByTechnician(remoteSessionId, technician)
                : actor === 'DEVICE'
                  ? service.closeByDevice(remoteSessionId, device)
                  : service.closeBySystem(remoteSessionId, always),
            ),
          );

          // Nadie ve un 409, un 500, un deadlock ni un error del driver.
          for (const result of results) expect(result.status).toBe('fulfilled');

          const stored = await storedSession(remoteSessionId);
          const request = await storedRequest(supportRequestId);
          const winner = stored.endedBy as RemoteSessionEndedBy;

          winners.push(winner);

          expect(stored.status).toBe(RemoteSessionStatus.CLOSED);
          expect(request.status).toBe(SupportRequestStatus.COMPLETED);
          expect(request.closedAt?.getTime()).toBe(stored.endedAt?.getTime());

          // Los participantes responden todos lo mismo: el cierre ganador.
          // SYSTEM devuelve la sesion solo si fue el, y si no `null`.
          order.forEach((actor, index) => {
            const value = (
              results[index] as PromiseFulfilledResult<{
                endedBy: RemoteSessionEndedBy;
                endedAt: Date | null;
              } | null>
            ).value;

            if (actor === 'SYSTEM' && winner !== RemoteSessionEndedBy.SYSTEM) {
              expect(value).toBeNull();
              return;
            }

            if (actor === 'SYSTEM' && value === null) return;

            expect(value?.endedBy).toBe(winner);
            expect(value?.endedAt?.getTime()).toBe(stored.endedAt?.getTime());
          });

          // Exactamente los avisos de UNA transicion.
          const notices = closedNotices();

          expect(notices).toHaveLength(
            winner === RemoteSessionEndedBy.SYSTEM ? 2 : 1,
          );
          for (const [, , payload] of notices)
            expect(payload).toEqual({ remoteSessionId, endedBy: winner });
        }

        process.stdout.write(
          `  [idempotent race ${actors.join('+')}] winners: ${winners.join(', ')}\n`,
        );
      },
    );

    it('una sesion CLOSED ajena sigue siendo 404, sin esperar a su lock', async () => {
      const owner = await seedSessionWithDevice();
      const stranger = await seedSessionWithDevice();

      await service.closeByTechnician(owner.remoteSessionId, owner.technician);

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();

        // La fila queda bloqueada por otra transaccion.
        await runner.manager.findOne(RemoteSession, {
          where: { id: owner.remoteSessionId },
          lock: { mode: 'pessimistic_write' },
        });

        // La pertenencia viaja en el WHERE del FOR UPDATE: la fila no
        // coincide, PostgreSQL ni la bloquea ni espera por ella.
        const started = Date.now();

        await expect(
          service.closeByTechnician(owner.remoteSessionId, stranger.technician),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          service.closeByDevice(owner.remoteSessionId, stranger.device),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }

      expect((await storedSession(owner.remoteSessionId)).endedBy).toBe(
        RemoteSessionEndedBy.TECHNICIAN,
      );
      // La sesion viva del extraño tampoco se toco.
      expect((await storedSession(stranger.remoteSessionId)).status).toBe(
        RemoteSessionStatus.CONNECTING,
      );
    });

    it('un POST antiguo sobre la sesion historica no afecta a la asistencia nueva', async () => {
      const old = await seedSessionWithDevice();

      await service.closeByTechnician(old.remoteSessionId, old.technician);

      // Nueva asistencia del mismo tecnico sobre el mismo dispositivo.
      const request = await seedRequest(
        old.technician,
        SupportRequestStatus.ACCEPTED,
        old.device,
      );
      const current = await service.create(
        { supportRequestId: request.id },
        old.technician,
      );

      await service.activateByTechnician(current.id, old.technician);

      const currentXmin = await xminOf('remote_sessions', current.id);
      const requestXmin = await xminOf('support_requests', request.id);

      emitToDevice.mockClear();
      emitToTechnician.mockClear();

      await service.closeByTechnician(old.remoteSessionId, old.technician);
      await service.closeByDevice(old.remoteSessionId, old.device);

      expect(await xminOf('remote_sessions', current.id)).toBe(currentXmin);
      expect(await xminOf('support_requests', request.id)).toBe(requestXmin);
      expect((await storedSession(current.id)).status).toBe(
        RemoteSessionStatus.ACTIVE,
      );
      expect(closedNotices()).toHaveLength(0);
    });

    it('un error real de PostgreSQL deja todo intacto y el reintento cierra una sola vez', async () => {
      const { technician, remoteSessionId, supportRequestId } =
        await seedSessionWithDevice();

      // Segunda conexion con `lock_timeout` corto: si la fila esta bloqueada,
      // PostgreSQL aborta con 55P03 (lock_not_available) en vez de esperar.
      const impatient = new DataSource({
        type: 'postgres',
        url: DATABASE_URL,
        ssl: resolveDatabaseSsl(DATABASE_URL as string),
        schema: TEST_SCHEMA,
        entities: [User, Device, SupportRequest, RemoteSession],
        extra: { options: '-c lock_timeout=300' },
      });

      await impatient.initialize();

      const impatientService = new RemoteSessionsService(
        impatient.getRepository(RemoteSession),
        impatient,
        { isOnline: () => true } as unknown as DevicePresenceService,
        { emitToDevice } as unknown as DeviceRealtimeService,
        { emitToTechnician } as unknown as TechnicianRealtimeService,
      );

      const runner = dataSource.createQueryRunner();

      await runner.connect();

      try {
        await runner.startTransaction();
        await runner.manager.findOne(RemoteSession, {
          where: { id: remoteSessionId },
          lock: { mode: 'pessimistic_write' },
        });

        const failure = await impatientService
          .closeByTechnician(remoteSessionId, technician)
          .catch((error: unknown) => error);

        // El error del driver sube tal cual (Nest lo responde como 500).
        expect(postgresError(failure).code).toBe('55P03');

        // Quien tenia la fila no cierra nada.
        await runner.rollbackTransaction();
      } finally {
        await runner.release();
        await impatient.destroy();
      }

      expect(await storedSession(remoteSessionId)).toMatchObject({
        status: RemoteSessionStatus.CONNECTING,
        endedAt: null,
        endedBy: null,
      });
      expect((await storedRequest(supportRequestId)).status).toBe(
        SupportRequestStatus.ACCEPTED,
      );
      expect(closedNotices()).toHaveLength(0);

      // El cliente reintenta y ahora si cierra, una vez.
      await expect(
        service.closeByTechnician(remoteSessionId, technician),
      ).resolves.toMatchObject({ endedBy: RemoteSessionEndedBy.TECHNICIAN });
      await expect(
        service.closeByTechnician(remoteSessionId, technician),
      ).resolves.toMatchObject({ endedBy: RemoteSessionEndedBy.TECHNICIAN });
      expect(closedNotices()).toHaveLength(1);
    });
  });

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
