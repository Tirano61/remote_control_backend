import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import { TechnicianRealtimeService } from '../signaling/realtime/technician-realtime.service';
import { SupportRequestTechnicianDto } from '../support-requests/dto/support-request-response.dto';
import { SupportRequest } from '../support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../support-requests/enums/support-request-status.enum';
import { CreateRemoteSessionDto } from './dto/create-remote-session.dto';
import {
  CurrentRemoteSessionResponseDto,
  RemoteSessionResponseDto,
} from './dto/remote-session-response.dto';
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

/** Aviso a la tablet de que el tecnico inicio la asistencia. */
export const REMOTE_SESSION_CREATED_EVENT = 'remote-session:created';

/**
 * Aviso de que la sesion termino, hacia el extremo que NO la cerro.
 *
 * Mismo nombre y mismo payload en los dos namespaces: `/devices` cuando cierra
 * el tecnico, `/technicians` cuando cierra el dispositivo, y AMBOS cuando cierra
 * el sistema (`endedBy: SYSTEM`), porque ninguno de los dos lo pidio. Un unico
 * contrato para un unico hecho.
 */
export const REMOTE_SESSION_CLOSED_EVENT = 'remote-session:closed';

/**
 * Aviso de que la conexion remota quedo establecida, hacia los DOS extremos.
 *
 * Mismo nombre y mismo payload en `/devices` y en `/technicians`: un unico
 * contrato para un unico hecho, igual que `remote-session:closed`.
 *
 * NO es signaling: es un evento de dominio y tiene que llegar aunque el
 * destinatario no haya ejecutado `remote-session:join`. Solo se emite en la
 * transicion real `CONNECTING -> ACTIVE`.
 */
export const REMOTE_SESSION_ACTIVE_EVENT = 'remote-session:active';

/** Payload de `remote-session:created`. Sin email, sin roles y sin tokens. */
export interface RemoteSessionCreatedPayload {
  remoteSessionId: string;
  supportRequestId: string;
  technician: SupportRequestTechnicianDto;
}

/** Payload de `remote-session:closed`. */
export interface RemoteSessionClosedPayload {
  remoteSessionId: string;
  endedBy: RemoteSessionEndedBy;
}

/**
 * Payload de `remote-session:active`. Deliberadamente minimo.
 *
 * El evento es un disparador, no el estado: el cliente responde leyendo la
 * sesion por REST (`GET /remote-sessions/current` o
 * `GET /device/remote-sessions/current`).
 */
export interface RemoteSessionActivePayload {
  remoteSessionId: string;
}

/**
 * Aviso interno, en proceso, de que una sesion cambio de estado ya confirmado
 * en PostgreSQL (creada, activada o cerrada). No es un evento de Socket.IO.
 *
 * Lo usa el cierre automatico para programar sus vencimientos sin que este
 * servicio dependa de el. Recibe una copia minima, sin relaciones.
 */
export type RemoteSessionChangeListener = (
  remoteSession: RemoteSessionLifecycleSnapshot,
) => void;

/** Lo minimo de una sesion para decidir su ciclo de vida. */
export type RemoteSessionLifecycleSnapshot = Pick<
  RemoteSession,
  | 'id'
  | 'supportRequestId'
  | 'deviceId'
  | 'technicianId'
  | 'status'
  | 'createdAt'
  | 'connectedAt'
>;

/**
 * Decision que el cierre automatico toma CON LA FILA BLOQUEADA.
 *
 * Recibe la sesion tal como esta en PostgreSQL en ese instante (ya viva) y la
 * hora del cierre; devuelve `true` solo si todavia corresponde cerrarla.
 */
export type SystemCloseDecision = (
  remoteSession: RemoteSessionLifecycleSnapshot,
  now: Date,
) => boolean;

/** Forma minima del error que devuelve el driver de PostgreSQL. */
interface PostgresError {
  code?: string;
  constraint?: string;
}

/** unique_violation */
const UNIQUE_VIOLATION = '23505';

/**
 * Quien pide algo sobre una sesion, tal como viaja en el WHERE: el tecnico del
 * User JWT o el dispositivo del Device JWT, nunca un id que mande el cliente.
 */
type RemoteSessionParticipant =
  | Pick<RemoteSession, 'technicianId'>
  | Pick<RemoteSession, 'deviceId'>;

/** Columnas de `RemoteSessionLifecycleSnapshot`: nada de relaciones. */
const LIFECYCLE_SNAPSHOT_SELECT = {
  id: true,
  supportRequestId: true,
  deviceId: true,
  technicianId: true,
  status: true,
  createdAt: true,
  connectedAt: true,
} as const;

@Injectable()
export class RemoteSessionsService {
  private readonly logger = new Logger(RemoteSessionsService.name);

  private readonly changeListeners = new Set<RemoteSessionChangeListener>();

  constructor(
    @InjectRepository(RemoteSession)
    private readonly remoteSessionRepository: Repository<RemoteSession>,

    // `SupportRequest` ya no se inyecta: todas sus lecturas y escrituras van
    // por el `EntityManager` de la transaccion, que es lo unico que sostiene el
    // lock. Un repositorio inyectado consultaria por otra conexion, fuera de
    // ella.
    private readonly dataSource: DataSource,

    private readonly devicePresenceService: DevicePresenceService,

    private readonly deviceRealtimeService: DeviceRealtimeService,

    private readonly technicianRealtimeService: TechnicianRealtimeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Tecnicos / admin (JWT de usuario)
  // ---------------------------------------------------------------------------

  /**
   * El tecnico inicia la asistencia sobre una solicitud que la tablet acepto.
   *
   * Del cliente llega unicamente `supportRequestId`: el dispositivo sale de la
   * solicitud y el tecnico del token. Un `admin` usa el mismo endpoint pero no
   * queda por encima de la regla, tambien tiene que ser el tecnico asignado: de
   * momento no existe supervision ni takeover administrativo.
   *
   * Un tecnico atiende como maximo una sesion viva: si ya tiene una
   * `CONNECTING` o `ACTIVE`, la segunda responde `409` aunque sea sobre otro
   * dispositivo. Al cerrarla queda habilitado de inmediato, sin ninguna
   * limpieza: el indice unico parcial deja fuera las filas `CLOSED`.
   */
  async create(
    createRemoteSessionDto: CreateRemoteSessionDto,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    const { supportRequestId } = createRemoteSessionDto;

    // Todo va en una transaccion que bloquea la fila de la solicitud: es el
    // punto de serializacion con `SupportRequestsService.cancelByDevice`, que
    // bloquea esa misma fila. Sin el lock, un SELECT previo podria ver
    // `ACCEPTED` y crear la sesion justo mientras la tablet cancela, dejando
    // una solicitud CANCELLED con una sesion CONNECTING.
    const created = await this.dataSource.transaction(async (manager) => {
      const supportRequest = await this.lockOwnedByTechnicianOrFail(
        manager,
        supportRequestId,
        user.id,
      );

      // Solo una solicitud aceptada autoriza el control remoto: el usuario de
      // la tablet tuvo que autorizar expresamente a ese tecnico. Si la
      // cancelacion gano el lock, aqui ya se lee `CANCELLED`.
      if (supportRequest.status !== SupportRequestStatus.ACCEPTED)
        throw new ConflictException(
          `Support request with id ${supportRequestId} was not accepted by the device`,
        );

      // Un tecnico atiende una sola sesion a la vez, aunque la segunda fuera
      // sobre otro dispositivo. Se comprueba antes que la presencia a
      // proposito: que el tecnico ya este ocupado es un dato suyo y accionable
      // ("cierra la que tienes abierta"), mientras que una tablet offline no le
      // dice nada mientras no pueda abrir ninguna sesion.
      //
      // Esto NO es lo que garantiza la invariante: entre este SELECT y el
      // INSERT hay una carrera, y quien la cierra es el indice unico parcial.
      // Sirve para no llegar al motor en el caso normal y para dar un mensaje
      // preciso.
      if (await this.technicianHasLiveSession(manager, user.id))
        throw new ConflictException(
          `Technician with id ${user.id} already has an active remote session`,
        );

      // Una tablet desconectada no puede establecer nada. La solicitud NO se
      // toca: sigue ACCEPTED para que el tecnico reintente al reconectarse.
      if (!this.devicePresenceService.isOnline(supportRequest.deviceId))
        throw new ConflictException(
          `Device with id ${supportRequest.deviceId} is offline`,
        );

      const remoteSession = this.remoteSessionRepository.create({
        supportRequestId: supportRequest.id,
        deviceId: supportRequest.deviceId,
        technicianId: user.id,
        status: RemoteSessionStatus.CONNECTING,
        // Lo escribe Node y no el `DEFAULT now()` de PostgreSQL, A PROPOSITO.
        // Las columnas son `timestamp without time zone`: `pg` guarda y lee un
        // `Date` en la hora local del proceso, mientras que `now()` usa la zona
        // de la sesion de PostgreSQL (GMT en Neon). Con `createdAt` generado
        // por la base y `connectedAt`/`endedAt` por Node, la fila mezclaria dos
        // relojes y el TTL de CONNECTING, que se calcula en Node desde
        // `createdAt`, venceria desplazado por la diferencia de zonas: horas
        // tarde en UTC-3, de inmediato en UTC+9. Asi los tres instantes de la
        // sesion salen del mismo reloj.
        createdAt: new Date(),
        connectedAt: null,
        endedAt: null,
        endedBy: null,
      });

      const session = await this.save(manager, remoteSession);

      // El tecnico es el usuario autenticado; el dispositivo se lee aparte
      // porque la consulta bloqueante no puede arrastrar relaciones.
      session.device = await manager.findOneByOrFail(Device, {
        id: supportRequest.deviceId,
      });
      session.technician = user;

      return session;
    });

    // Primero confirmar la transaccion, despues avisar: no se anuncia una
    // sesion que todavia pudiera no existir. Si el evento no llega porque la
    // tablet se desconecto justo despues de comprobar la presencia, la sesion
    // sigue siendo valida: la recupera con GET /device/remote-sessions/current.
    this.notifyCreated(created);
    this.notifyChanged(created);

    return this.toResponse(created);
  }

  /**
   * Sesion viva del tecnico autenticado, o `null` si no tiene ninguna.
   *
   * Es como `remote_control_web` recupera su sesion tras un F5, al reabrir la
   * aplicacion o despues de perderse un evento de Socket.IO: el cliente no
   * tiene que tratar un `remoteSessionId` guardado en local como fuente de
   * verdad.
   *
   * La pertenencia viaja en el WHERE y sale exclusivamente del token: no hay
   * ningun `technicianId` que pueda llegar por query, body o path. Un `admin`
   * recupera sus propias sesiones y nada mas: aqui tampoco hay supervision ni
   * takeover.
   *
   * No hay ambiguedad que resolver: un tecnico tiene como maximo una sesion
   * viva, y lo garantiza el indice unico parcial por `technicianId`, no esta
   * consulta. El `ORDER BY createdAt DESC` se conserva porque es inocuo y deja
   * la respuesta definida incluso si algun dia se relajara la invariante.
   */
  async findCurrentForTechnician(
    technicianId: string,
  ): Promise<CurrentRemoteSessionResponseDto> {
    const remoteSession = await this.remoteSessionRepository.findOne({
      where: {
        technicianId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
      relations: { device: true, technician: true },
      order: { createdAt: 'DESC' },
    });

    return {
      remoteSession: remoteSession ? this.toResponse(remoteSession) : null,
    };
  }

  /**
   * Sesion concreta para la aplicacion del tecnico.
   *
   * Conocer el UUID no alcanza: solo la ve el tecnico al que pertenece.
   */
  async findOneForTechnician(
    id: string,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    return this.toResponse(await this.findOwnedByTechnicianOrFail(id, user.id));
  }

  /**
   * El tecnico informa de que la conexion remota quedo establecida.
   *
   * Lo llama `remote_control_web` cuando su `RTCPeerConnection` esta
   * `connected` y el DataChannel de control abierto. El backend no lo puede
   * saber por si mismo: no participa en WebRTC y el signaling nunca cambia el
   * estado de la sesion.
   *
   * Del cliente no llega NADA: el tecnico sale del User JWT, la sesion del path
   * y `connectedAt` lo genera el backend. Un `connectedAt` o un `status`
   * enviados por Flutter no se leerian aunque viajaran en el body.
   *
   * Idempotente a proposito, porque este aviso viaja justo cuando la red acaba
   * de establecerse y su respuesta puede perderse: un segundo `/activate` sobre
   * una sesion que ya esta `ACTIVE` devuelve la misma sesion, con el
   * `connectedAt` original y sin volver a emitir nada.
   *
   * La pertenencia es la misma que en el resto de endpoints del tecnico: la
   * sesion de otro responde `404`, tambien para `admin`. No hay takeover.
   */
  async activateByTechnician(
    id: string,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    // Transaccion con la fila bloqueada: es el punto de serializacion con el
    // cierre. Mientras este lock este tomado, ningun `close` puede colarse
    // entre la lectura del estado y el UPDATE.
    const { remoteSession, activated } = await this.dataSource.transaction(
      async (manager) => {
        const locked = await this.lockSessionOwnedByTechnicianOrFail(
          manager,
          id,
          user.id,
        );

        // `CLOSED` es terminal: una sesion cerrada no vuelve a abrirse nunca,
        // ni siquiera por un reintento del cliente.
        if (locked.status === RemoteSessionStatus.CLOSED)
          throw new ConflictException(
            `Remote session with id ${id} is already closed`,
          );

        // Reintento sobre una sesion ya activa: se devuelve tal cual. No se
        // toca `connectedAt` ni se vuelve a avisar por Socket.IO.
        if (locked.status === RemoteSessionStatus.ACTIVE)
          return {
            remoteSession: await this.withRelations(manager, locked, user),
            activated: false,
          };

        const connectedAt = new Date();

        // Condicionado al estado, igual que el cierre: aunque aqui el lock ya
        // lo garantiza, la comprobacion y la escritura siguen ocurriendo en la
        // misma sentencia.
        if (!(await this.activateSession(manager, id, connectedAt)))
          throw new ConflictException(
            `Remote session with id ${id} is already closed`,
          );

        Object.assign(locked, {
          status: RemoteSessionStatus.ACTIVE,
          connectedAt,
        });

        return {
          remoteSession: await this.withRelations(manager, locked, user),
          activated: true,
        };
      },
    );

    // Solo cuando ocurrio de verdad `CONNECTING -> ACTIVE`, y solo despues del
    // commit: no se anuncia una activacion que todavia pudiera deshacerse.
    if (activated) {
      this.notifyActivated(remoteSession);
      this.notifyChanged(remoteSession);
    }

    return this.toResponse(remoteSession);
  }

  /**
   * El tecnico finaliza la asistencia.
   *
   * Idempotente: si la sesion del tecnico ya estaba `CLOSED` (la cerro el
   * mismo en un intento cuya respuesta se perdio, la tablet o el sistema)
   * responde `200` con la sesion tal como quedo, sin reescribir `endedAt` ni
   * `endedBy` y sin volver a avisar a la tablet. Ver `closeOwned`.
   */
  async closeByTechnician(
    id: string,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    const { remoteSession, closedNow } = await this.closeOwned(
      id,
      { technicianId: user.id },
      RemoteSessionEndedBy.TECHNICIAN,
    );

    // Solo quien hizo la transicion avisa, y despues del commit: un reintento
    // sobre una sesion ya cerrada no emite un segundo `remote-session:closed`.
    if (closedNow) this.notifyDeviceClosed(remoteSession);

    return this.toResponse(remoteSession);
  }

  // ---------------------------------------------------------------------------
  // Dispositivo (Device JWT)
  // ---------------------------------------------------------------------------

  /**
   * Sesion viva del dispositivo autenticado, o `null` si no tiene.
   *
   * Es como la tablet recupera su sesion tras reconectarse, reiniciar la app o
   * perderse el evento de Socket.IO. El `deviceId` sale del Device JWT.
   */
  async findCurrentForDevice(
    deviceId: string,
  ): Promise<CurrentRemoteSessionResponseDto> {
    const remoteSession = await this.remoteSessionRepository.findOne({
      where: {
        deviceId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
      relations: { device: true, technician: true },
    });

    return {
      remoteSession: remoteSession ? this.toResponse(remoteSession) : null,
    };
  }

  /**
   * El usuario de la tablet corta la sesion.
   *
   * DECISION: a quien cierra no se le reenvia `remote-session:closed`. Ya
   * recibe la sesion cerrada en la respuesta HTTP, igual que ocurre con las
   * transiciones de `SupportRequest`.
   *
   * Al tecnico si se le avisa, y despues del commit: es el unico extremo que se
   * quedaria mostrando una sesion que ya no existe. El aviso es simetrico del
   * que recibe la tablet cuando cierra el tecnico.
   *
   * Idempotente igual que el cierre del tecnico: sobre una sesion propia ya
   * `CLOSED` responde `200` con el cierre original y no avisa a nadie.
   */
  async closeByDevice(
    id: string,
    device: Device,
  ): Promise<RemoteSessionResponseDto> {
    const { remoteSession, closedNow } = await this.closeOwned(
      id,
      { deviceId: device.id },
      RemoteSessionEndedBy.DEVICE,
    );

    // Nunca antes de que la transaccion confirme: no se anuncia un cierre que
    // todavia pudiera deshacerse. Y solo si esta peticion hizo la transicion:
    // un reintento, o un cierre que ya hizo otro, no produce avisos.
    if (closedNow) this.notifyTechnicianClosed(remoteSession);

    return this.toResponse(remoteSession);
  }

  // ---------------------------------------------------------------------------
  // Sistema (cierre automatico)
  // ---------------------------------------------------------------------------

  /**
   * Suscribe un listener a los cambios de estado ya confirmados.
   *
   * Devuelve como darse de baja. Un listener que falla se registra y no afecta
   * a la operacion que lo disparo.
   */
  onSessionChanged(listener: RemoteSessionChangeListener): () => void {
    this.changeListeners.add(listener);

    return () => this.changeListeners.delete(listener);
  }

  /** Sesiones vivas (`CONNECTING` / `ACTIVE`), sin relaciones. */
  findLiveSessions(): Promise<RemoteSessionLifecycleSnapshot[]> {
    return this.remoteSessionRepository.find({
      where: { status: In([...ACTIVE_REMOTE_SESSION_STATUSES]) },
      select: LIFECYCLE_SNAPSHOT_SELECT,
    });
  }

  /** Una sesion concreta si sigue viva, o `null`. Sin relaciones. */
  findLiveSession(id: string): Promise<RemoteSessionLifecycleSnapshot | null> {
    return this.remoteSessionRepository.findOne({
      where: { id, status: In([...ACTIVE_REMOTE_SESSION_STATUSES]) },
      select: LIFECYCLE_SNAPSHOT_SELECT,
    });
  }

  /**
   * Cierre automatico del backend: `endedBy = SYSTEM`.
   *
   * Usa EXACTAMENTE la misma transicion que los cierres del tecnico y del
   * dispositivo (`closeWithin`: sesion CLOSED + solicitud COMPLETED en la misma
   * transaccion). Lo unico que anade es el lock y la decision:
   *
   * 1. bloquea la fila (`SELECT ... FOR UPDATE`), como `activate`;
   * 2. si ya no esta viva, no hace nada;
   * 3. vuelve a preguntar a `decide` con la fila bloqueada, porque entre la
   *    programacion del vencimiento y este momento la sesion pudo activarse, o
   *    el participante pudo volver;
   * 4. cierra condicionado al estado leido, de modo que un vencimiento de
   *    CONNECTING nunca toca una sesion que ya es ACTIVE.
   *
   * Frente a un cierre del tecnico o del dispositivo simultaneo, gana el primero
   * que llega a la fila (los tres la bloquean igual): el otro ve `CLOSED`
   * (aqui, `null`; alli, un `200` con el cierre ya hecho) y no reescribe
   * `endedAt` ni `endedBy`.
   *
   * Solo despues del commit avisa a LOS DOS extremos con
   * `remote-session:closed`. Devuelve la sesion cerrada, o `null` si no cerro.
   */
  async closeBySystem(
    id: string,
    decide: SystemCloseDecision,
  ): Promise<RemoteSession | null> {
    const closed = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(RemoteSession, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!locked || !ACTIVE_REMOTE_SESSION_STATUSES.includes(locked.status))
        return null;

      const endedAt = new Date();

      if (!decide(locked, endedAt)) return null;

      const done = await this.closeWithin(
        manager,
        locked,
        endedAt,
        RemoteSessionEndedBy.SYSTEM,
        [locked.status],
      );

      if (!done) return null;

      return Object.assign(locked, {
        status: RemoteSessionStatus.CLOSED,
        endedAt,
        endedBy: RemoteSessionEndedBy.SYSTEM,
      });
    });

    if (!closed) return null;

    this.notifyClosedToBoth(closed);
    this.notifyChanged(closed);

    return closed;
  }

  // ---------------------------------------------------------------------------
  // Interno
  // ---------------------------------------------------------------------------

  /**
   * Cierre pedido por un participante (tecnico o dispositivo). Idempotente.
   *
   * Todo ocurre en una transaccion que empieza bloqueando la fila
   * (`SELECT ... FOR UPDATE`) CON LA PERTENENCIA EN EL WHERE, igual que
   * `activate` y `closeBySystem`:
   *
   * 1. Una sesion ajena o inexistente responde `404` y ni siquiera se bloquea.
   *    La idempotencia no relaja esto: estar `CLOSED` no hace visible una
   *    sesion que nunca fue del solicitante.
   * 2. Si la sesion sigue viva, se cierra con LA transicion de siempre
   *    (`closeWithin`: sesion `CLOSED` + solicitud `COMPLETED`, o nada).
   * 3. Si ya estaba `CLOSED` no se escribe nada: ni `endedAt`, ni `endedBy`, ni
   *    la solicitud. Un reintento tardio no se atribuye el cierre.
   *
   * El lock es lo que decide las carreras: tecnico, dispositivo y sistema
   * compiten por la misma fila, el primero que la obtiene cierra y los demas,
   * al obtenerla despues, leen `CLOSED`. Ninguna decision depende de una
   * lectura hecha fuera de la transaccion.
   *
   * La sesion devuelta se relee DESPUES del cierre, dentro de la misma
   * transaccion: es la fila confirmada, asi que el primer cierre y cualquier
   * reintento responden exactamente lo mismo (mismo `endedAt`, mismo
   * `endedBy`).
   *
   * `closedNow` dice si ESTA peticion hizo la transicion. Solo en ese caso se
   * avisa (por Socket.IO y en proceso): una carrera o un reintento no producen
   * avisos duplicados.
   */
  private async closeOwned(
    id: string,
    owner: RemoteSessionParticipant,
    endedBy: RemoteSessionEndedBy,
  ): Promise<{ remoteSession: RemoteSession; closedNow: boolean }> {
    const outcome = await this.dataSource.transaction(async (manager) => {
      const locked = await this.lockOwnedSessionOrFail(manager, id, owner);

      // Con la fila bloqueada nadie puede cambiar su estado: el UPDATE va
      // condicionado al estado leido y no puede fallar salvo que la fila
      // estuviera ya `CLOSED`, en cuyo caso ni se ejecuta.
      const closedNow =
        locked.status !== RemoteSessionStatus.CLOSED &&
        (await this.closeWithin(manager, locked, new Date(), endedBy, [
          locked.status,
        ]));

      const remoteSession = await manager.findOne(RemoteSession, {
        where: { id },
        relations: { device: true, technician: true },
      });

      // Inalcanzable con la fila bloqueada. Si aun asi ocurriera, no se
      // confirma un cierre que PostgreSQL no tiene.
      if (remoteSession?.status !== RemoteSessionStatus.CLOSED)
        throw new ConflictException(
          `Remote session with id ${id} could not be closed`,
        );

      return { remoteSession, closedNow };
    });

    if (outcome.closedNow) this.notifyChanged(outcome.remoteSession);

    return outcome;
  }

  /**
   * LA transicion de cierre, dentro de una transaccion ya abierta. Es la unica:
   * la usan el tecnico, el dispositivo y el sistema.
   *
   * Los dos UPDATE se confirman juntos o no se confirma ninguno: no puede
   * quedar una sesion `CLOSED` con su solicitud todavia `ACCEPTED`, ni una
   * sesion cerrada cuya solicitud no haya podido pasar a `COMPLETED`.
   *
   * Devuelve `false` si la sesion ya no estaba en ninguno de los estados `from`
   * (nada se escribio). Lanza `409` si la solicitud no puede completarse, lo que
   * aborta la transaccion entera.
   */
  private async closeWithin(
    manager: EntityManager,
    remoteSession: Pick<RemoteSession, 'id' | 'supportRequestId'>,
    endedAt: Date,
    endedBy: RemoteSessionEndedBy,
    from: readonly RemoteSessionStatus[],
  ): Promise<boolean> {
    const closed = await this.closeSession(
      manager,
      remoteSession.id,
      endedAt,
      endedBy,
      from,
    );

    if (!closed) return false;

    const completed = await this.completeSupportRequest(
      manager,
      remoteSession.supportRequestId,
      endedAt,
    );

    // Una sesion viva implica una solicitud `ACCEPTED`: mientras exista la
    // sesion, `cancelByDevice` no puede cerrarla. Que el UPDATE no afecte a
    // exactamente una fila significa que el estado ya es inconsistente, asi
    // que se aborta y se deshace tambien el cierre de la sesion.
    if (!completed)
      throw new ConflictException(
        `Support request with id ${remoteSession.supportRequestId} is not in a state that can complete the remote session`,
      );

    return true;
  }

  /**
   * `<from> -> CLOSED` en un unico UPDATE condicional.
   *
   * Es lo que evita las carreras: comprobacion y escritura ocurren en la misma
   * sentencia. Devuelve `false` cuando la sesion ya no estaba en `from`.
   */
  private async closeSession(
    manager: EntityManager,
    id: string,
    endedAt: Date,
    endedBy: RemoteSessionEndedBy,
    from: readonly RemoteSessionStatus[],
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(RemoteSession)
      .set({ status: RemoteSessionStatus.CLOSED, endedAt, endedBy })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', { from: [...from] })
      .execute();

    return result.affected === 1;
  }

  /**
   * `CONNECTING -> ACTIVE` en un unico UPDATE condicional.
   *
   * `connectedAt` se escribe aqui y en ningun otro sitio, y solo desde
   * `CONNECTING`: como `ACTIVE` y `CLOSED` no vuelven nunca a `CONNECTING`, la
   * columna no puede escribirse dos veces. Un segundo `/activate` no llega a
   * ejecutar esta sentencia.
   *
   * Devuelve `false` cuando la sesion ya no estaba `CONNECTING`.
   */
  private async activateSession(
    manager: EntityManager,
    id: string,
    connectedAt: Date,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(RemoteSession)
      .set({ status: RemoteSessionStatus.ACTIVE, connectedAt })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', {
        from: [RemoteSessionStatus.CONNECTING],
      })
      .execute();

    return result.affected === 1;
  }

  /**
   * `ACCEPTED -> COMPLETED`, tambien condicional.
   *
   * Solo escribe `status` y `closedAt`: `respondedAt`, `technicianId` y
   * `assignedAt` son historia de la solicitud y no se tocan.
   */
  private async completeSupportRequest(
    manager: EntityManager,
    id: string,
    closedAt: Date,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(SupportRequest)
      .set({ status: SupportRequestStatus.COMPLETED, closedAt })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', {
        from: [SupportRequestStatus.ACCEPTED],
      })
      .execute();

    return result.affected === 1;
  }

  /** Sesion del tecnico autenticado, o `404` como si no existiera. */
  private findOwnedByTechnicianOrFail(
    id: string,
    technicianId: string,
  ): Promise<RemoteSession> {
    return this.findOwnedOrFail(id, { technicianId });
  }

  /**
   * La pertenencia viaja en el WHERE.
   *
   * Una sesion ajena responde `404` igual que una inexistente: conocer un UUID
   * valido no autoriza nada y tampoco debe confirmar que la sesion existe.
   */
  private async findOwnedOrFail(
    id: string,
    owner: Partial<Pick<RemoteSession, 'technicianId' | 'deviceId'>>,
  ): Promise<RemoteSession> {
    const remoteSession = await this.remoteSessionRepository.findOne({
      where: { id, ...owner },
      relations: { device: true, technician: true },
    });

    if (!remoteSession)
      throw new NotFoundException(`Remote session with id ${id} not found`);

    return remoteSession;
  }

  /**
   * Bloquea la fila de la sesion del tecnico autenticado. Ver
   * `lockOwnedSessionOrFail`.
   */
  private lockSessionOwnedByTechnicianOrFail(
    manager: EntityManager,
    id: string,
    technicianId: string,
  ): Promise<RemoteSession> {
    return this.lockOwnedSessionOrFail(manager, id, { technicianId });
  }

  /**
   * Bloquea la fila de una sesion del participante autenticado (tecnico o
   * dispositivo).
   *
   * Es el `SELECT ... FOR UPDATE` que serializa la activacion con el cierre y
   * los cierres entre si: quien llega segundo espera al lock y despues
   * reevalua la fila, asi que ve lo que dejo el primero, nunca el estado
   * anterior.
   *
   * La pertenencia viaja en el WHERE, igual que en `findOwnedOrFail`: la sesion
   * de otro tecnico o de otro dispositivo se comporta como inexistente (`404`),
   * este como este, y ni siquiera se bloquea.
   *
   * Sin relaciones, por el mismo motivo que en la solicitud: TypeORM las
   * resolveria con LEFT JOIN y PostgreSQL no admite `FOR UPDATE` sobre el lado
   * nullable de un outer join. Se cargan despues, con una lectura aparte.
   */
  private async lockOwnedSessionOrFail(
    manager: EntityManager,
    id: string,
    owner: RemoteSessionParticipant,
  ): Promise<RemoteSession> {
    const remoteSession = await manager.findOne(RemoteSession, {
      where: { id, ...owner },
      lock: { mode: 'pessimistic_write' },
    });

    if (!remoteSession)
      throw new NotFoundException(`Remote session with id ${id} not found`);

    return remoteSession;
  }

  /**
   * Completa la sesion bloqueada con lo que necesita la respuesta.
   *
   * El tecnico es el usuario autenticado, asi que no hay que ir a buscarlo; el
   * dispositivo se lee aparte porque la consulta bloqueante no puede arrastrar
   * relaciones. Es lo mismo que hace `create` tras insertar.
   */
  private async withRelations(
    manager: EntityManager,
    remoteSession: RemoteSession,
    technician: User,
  ): Promise<RemoteSession> {
    remoteSession.device = await manager.findOneByOrFail(Device, {
      id: remoteSession.deviceId,
    });
    remoteSession.technician = technician;

    return remoteSession;
  }

  /**
   * Bloquea la fila de la solicitud del tecnico autenticado.
   *
   * Es el `SELECT ... FOR UPDATE` que serializa la creacion con la cancelacion
   * desde la tablet, que bloquea esa misma fila. La pertenencia viaja en el
   * WHERE y no en un `if` posterior: la solicitud de otro tecnico se comporta
   * como inexistente y ni siquiera se bloquea.
   *
   * No se piden relaciones a proposito: TypeORM las resolveria con LEFT JOIN y
   * PostgreSQL no admite `FOR UPDATE` sobre el lado nullable de un outer join.
   */
  private async lockOwnedByTechnicianOrFail(
    manager: EntityManager,
    id: string,
    technicianId: string,
  ): Promise<SupportRequest> {
    const supportRequest = await manager.findOne(SupportRequest, {
      where: { id, technicianId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!supportRequest)
      throw new NotFoundException(`Support request with id ${id} not found`);

    return supportRequest;
  }

  /**
   * Guarda la sesion traduciendo las restricciones de PostgreSQL.
   *
   * Las tres unicidades las comprueba el motor y no un SELECT previo: siguen
   * siendo la segunda linea de defensa aunque ahora la solicitud este
   * bloqueada, porque el lock ordena a los que compiten por esa fila y no a
   * cualquier otro camino que pudiera abrir una sesion sobre el dispositivo o
   * sobre el tecnico. Dos peticiones simultaneas del mismo tecnico sobre
   * dispositivos distintos ni siquiera compiten por la misma solicitud: ahi el
   * indice es lo unico que decide.
   *
   * Va por el `EntityManager` de la transaccion: si la unicidad falla, el
   * `ConflictException` la aborta y no queda nada a medias.
   */
  private async save(
    manager: EntityManager,
    remoteSession: RemoteSession,
  ): Promise<RemoteSession> {
    try {
      return await manager.save(RemoteSession, remoteSession);
    } catch (error) {
      const conflict = this.uniqueViolationMessage(error, remoteSession);

      if (conflict) throw new ConflictException(conflict);

      this.logger.error(error);

      throw new InternalServerErrorException('Please check server logs');
    }
  }

  /**
   * Mensaje del conflicto que corresponde al indice unico violado, o `null` si
   * el error no es una violacion de uno de los indices de esta tabla.
   *
   * La tabla tiene tres unicidades distintas (una sesion por solicitud, una
   * sesion viva por dispositivo y una sesion viva por tecnico) y el mensaje no
   * es el mismo, asi que hay que distinguirlas por el NOMBRE de la restriccion
   * que devuelve PostgreSQL.
   *
   * Un `23505` que no sea uno de esos tres nombres NO se convierte en `409`:
   * seria un fallo distinto (la clave primaria, un indice de otra tabla, algo
   * que todavia no existe) y anunciarlo como "ya hay una sesion" mentiria al
   * cliente. Cae al `500` con el error registrado, que es lo que corresponde a
   * algo que no sabemos interpretar.
   */
  private uniqueViolationMessage(
    error: unknown,
    remoteSession: RemoteSession,
  ): string | null {
    if (!(error instanceof QueryFailedError)) return null;

    const driverError = error.driverError as unknown as PostgresError | null;

    if (driverError?.code !== UNIQUE_VIOLATION) return null;

    switch (driverError.constraint) {
      case ACTIVE_REMOTE_SESSION_INDEX:
        return `Device with id ${remoteSession.deviceId} already has an active remote session`;

      case ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX:
        return `Technician with id ${remoteSession.technicianId} already has an active remote session`;

      case REMOTE_SESSION_SUPPORT_REQUEST_INDEX:
        return `Support request with id ${remoteSession.supportRequestId} already has a remote session`;

      default:
        return null;
    }
  }

  /**
   * Si el tecnico ya tiene una sesion `CONNECTING` o `ACTIVE`.
   *
   * Va por el `EntityManager` de la transaccion y no por el repositorio
   * inyectado: tiene que leer dentro de la misma transaccion que despues
   * inserta.
   */
  private technicianHasLiveSession(
    manager: EntityManager,
    technicianId: string,
  ): Promise<boolean> {
    return manager.exists(RemoteSession, {
      where: {
        technicianId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
    });
  }

  /**
   * Avisa a la tablet de que la asistencia empezo.
   *
   * Va por `DeviceRealtimeService` y no por el gateway: este servicio no conoce
   * Socket.IO. El tecnico se publica con la misma representacion que en
   * `support:assigned`.
   */
  private notifyCreated(remoteSession: RemoteSession): void {
    const payload: RemoteSessionCreatedPayload = {
      remoteSessionId: remoteSession.id,
      supportRequestId: remoteSession.supportRequestId,
      technician: SupportRequestTechnicianDto.fromTechnician(
        remoteSession.technician,
      ),
    };

    this.deviceRealtimeService.emitToDevice(
      remoteSession.deviceId,
      REMOTE_SESSION_CREATED_EVENT,
      payload,
    );
  }

  /**
   * Avisa a los DOS extremos de que la sesion quedo activa.
   *
   * Cada uno por su room personal y no por la de la sesion: es un evento de
   * dominio, no signaling, y tiene que llegar aunque el destinatario no haya
   * ejecutado `remote-session:join`.
   *
   * Ninguno de los dos envios forma parte de la transaccion: la sesion ya esta
   * `ACTIVE` en PostgreSQL y nada de lo que ocurra aqui puede deshacerlo ni
   * convertir una activacion correcta en un `500`. Por eso cada envio va por
   * separado: un transporte caido en un extremo no debe impedir el aviso al
   * otro. Quien no lo reciba recupera el estado por REST.
   */
  private notifyActivated(remoteSession: RemoteSession): void {
    const payload: RemoteSessionActivePayload = {
      remoteSessionId: remoteSession.id,
    };

    this.deliverActive(remoteSession, `device ${remoteSession.deviceId}`, () =>
      this.deviceRealtimeService.emitToDevice(
        remoteSession.deviceId,
        REMOTE_SESSION_ACTIVE_EVENT,
        payload,
      ),
    );

    this.deliverActive(
      remoteSession,
      `technician ${remoteSession.technicianId}`,
      () =>
        this.technicianRealtimeService.emitToTechnician(
          remoteSession.technicianId,
          REMOTE_SESSION_ACTIVE_EVENT,
          payload,
        ),
    );
  }

  /** Envia el aviso de activacion y registra el fallo sin propagarlo. */
  private deliverActive(
    remoteSession: RemoteSession,
    recipient: string,
    emit: () => void,
  ): void {
    try {
      emit();
    } catch (error) {
      // Solo ids: nada de tokens ni de SDP.
      this.logger.error(
        `Remote session ${remoteSession.id} is ACTIVE, but ${REMOTE_SESSION_ACTIVE_EVENT} could not be delivered to its ${recipient}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Avisa a la tablet de que el tecnico termino la sesion.
   *
   * Igual que el aviso al tecnico: la sesion ya esta `CLOSED` en PostgreSQL, y
   * un transporte que falla se registra pero no convierte el cierre en un
   * `500` (que haria creer al tecnico que no cerro).
   */
  private notifyDeviceClosed(remoteSession: RemoteSession): void {
    this.deliverClosed(remoteSession, `device ${remoteSession.deviceId}`, () =>
      this.deviceRealtimeService.emitToDevice(
        remoteSession.deviceId,
        REMOTE_SESSION_CLOSED_EVENT,
        this.closedPayload(remoteSession),
      ),
    );
  }

  /**
   * Avisa al tecnico de que el usuario de la tablet termino la sesion.
   *
   * Va a su room personal y no a la de la sesion: `remote-session:closed` es un
   * evento de dominio, no signaling, y tiene que llegarle aunque nunca haya
   * ejecutado `remote-session:join`.
   *
   * El aviso NO es la fuente de verdad ni forma parte de la transaccion: si el
   * transporte falla, la sesion sigue `CLOSED` y su solicitud `COMPLETED`, y no
   * se deshace nada. Por eso el error se registra y no se propaga: quien cerro
   * ya recibio su respuesta HTTP correcta y convertirla en un `500` haria creer
   * que el cierre fallo. El tecnico recupera el estado con
   * `GET /remote-sessions/current`.
   */
  private notifyTechnicianClosed(remoteSession: RemoteSession): void {
    try {
      this.technicianRealtimeService.emitToTechnician(
        remoteSession.technicianId,
        REMOTE_SESSION_CLOSED_EVENT,
        this.closedPayload(remoteSession),
      );
    } catch (error) {
      // Sin datos de la sesion mas alla de su id: nada de tokens ni de SDP.
      this.logger.error(
        `Remote session ${remoteSession.id} is closed, but ${REMOTE_SESSION_CLOSED_EVENT} could not be delivered to its technician`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Cierre del sistema: avisa a LOS DOS extremos, porque ninguno lo pidio.
   *
   * Mismo evento y mismo payload que los cierres normales, con
   * `endedBy: "SYSTEM"`. Cada envio por separado y sin propagar errores: la
   * sesion ya esta CLOSED en PostgreSQL, un transporte caido no lo deshace y
   * no debe impedir el aviso al otro extremo. Es best-effort: un extremo
   * desconectado no lo recibe y reconcilia por REST al volver.
   */
  private notifyClosedToBoth(remoteSession: RemoteSession): void {
    const payload = this.closedPayload(remoteSession);

    this.deliverClosed(remoteSession, `device ${remoteSession.deviceId}`, () =>
      this.deviceRealtimeService.emitToDevice(
        remoteSession.deviceId,
        REMOTE_SESSION_CLOSED_EVENT,
        payload,
      ),
    );

    this.deliverClosed(
      remoteSession,
      `technician ${remoteSession.technicianId}`,
      () =>
        this.technicianRealtimeService.emitToTechnician(
          remoteSession.technicianId,
          REMOTE_SESSION_CLOSED_EVENT,
          payload,
        ),
    );
  }

  /** Envia un aviso de cierre y registra el fallo sin propagarlo. */
  private deliverClosed(
    remoteSession: RemoteSession,
    recipient: string,
    emit: () => unknown,
  ): void {
    try {
      emit();
    } catch (error) {
      this.logger.error(
        `Remote session ${remoteSession.id} is closed, but ${REMOTE_SESSION_CLOSED_EVENT} could not be delivered to its ${recipient}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Avisa en proceso a los listeners (el cierre automatico) de un cambio ya
   * confirmado. Un listener que falla no convierte la operacion en un error.
   */
  private notifyChanged(remoteSession: RemoteSession): void {
    const snapshot: RemoteSessionLifecycleSnapshot = {
      id: remoteSession.id,
      supportRequestId: remoteSession.supportRequestId,
      deviceId: remoteSession.deviceId,
      technicianId: remoteSession.technicianId,
      status: remoteSession.status,
      createdAt: remoteSession.createdAt,
      connectedAt: remoteSession.connectedAt,
    };

    for (const listener of this.changeListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error(
          `Remote session ${remoteSession.id} change listener failed`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /** Un unico payload de cierre para los dos destinatarios. */
  private closedPayload(
    remoteSession: RemoteSession,
  ): RemoteSessionClosedPayload {
    return {
      remoteSessionId: remoteSession.id,
      endedBy: remoteSession.endedBy ?? RemoteSessionEndedBy.SYSTEM,
    };
  }

  /** La presencia se resuelve al responder: `isOnline` no es una columna. */
  private toResponse(remoteSession: RemoteSession): RemoteSessionResponseDto {
    return RemoteSessionResponseDto.fromEntity(
      remoteSession,
      this.devicePresenceService.isOnline(remoteSession.deviceId),
    );
  }
}
