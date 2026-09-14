import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { Device } from '../../devices/entities/device.entity';
import { SupportRequest } from '../../support-requests/entities/support-request.entity';
import { RemoteSessionEndedBy } from '../enums/remote-session-ended-by.enum';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from '../enums/remote-session-status.enum';

/** Indice unico: una solicitud no puede originar dos sesiones. */
export const REMOTE_SESSION_SUPPORT_REQUEST_INDEX =
  'IDX_remote_sessions_support_request';

/** Indice unico parcial: una sola sesion viva por dispositivo. */
export const ACTIVE_REMOTE_SESSION_INDEX = 'IDX_remote_sessions_device_active';

/** Indice unico parcial: una sola sesion viva por tecnico. */
export const ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX =
  'IDX_remote_sessions_technician_active';

/**
 * Lista de estados vivos en SQL, derivada del enum para que el indice no pueda
 * quedar desalineado si manana se agrega un estado.
 */
const ACTIVE_STATUSES_SQL = ACTIVE_REMOTE_SESSION_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');

/**
 * Una autorizacion temporal entre un tecnico y un dispositivo.
 *
 * Nace unicamente de una `SupportRequest` que el usuario de la tablet ya
 * acepto: el acceso remoto existe mientras exista una sesion, nunca porque un
 * tecnico este autenticado.
 *
 * Las tres invariantes importantes las impone PostgreSQL y no un SELECT previo
 * (entre la comprobacion y el INSERT habria una carrera):
 *
 * - una solicitud origina como maximo una sesion;
 * - un dispositivo no tiene dos sesiones vivas a la vez;
 * - un tecnico no atiende dos sesiones vivas a la vez.
 *
 * CUIDADO al agregar estados: `synchronize` compara nombre, columnas y
 * unicidad de los indices, pero no su condicion, asi que un cambio en la lista
 * de estados vivos NO se aplicaria solo sobre una base ya creada; habria que
 * recrear el indice explicitamente.
 */
@Entity('remote_sessions')
@Index(REMOTE_SESSION_SUPPORT_REQUEST_INDEX, ['supportRequestId'], {
  unique: true,
})
@Index(ACTIVE_REMOTE_SESSION_INDEX, ['deviceId'], {
  unique: true,
  where: `"status" IN (${ACTIVE_STATUSES_SQL})`,
})
// Misma condicion, otra columna: el tecnico tampoco puede atender dos sesiones
// vivas a la vez. Es la invariante que permite a `remote_control_web` hablar de
// "la sesion actual" del tecnico sin ambiguedad.
@Index(ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX, ['technicianId'], {
  unique: true,
  where: `"status" IN (${ACTIVE_STATUSES_SQL})`,
})
// Historial de un dispositivo. El indice parcial de arriba solo cubre las
// sesiones vivas, asi que no sirve para consultar las ya cerradas.
@Index(['deviceId'])
// Historial de un tecnico, por el mismo motivo: el indice unico parcial de
// arriba deja fuera las sesiones CLOSED, que son casi todas las filas. Se
// conserva a proposito; no lo sustituye.
@Index(['technicianId'])
@Index(['status'])
export class RemoteSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Solicitud aceptada que autorizo esta sesion. Unica: 1 solicitud, 1 sesion. */
  @Column('uuid')
  supportRequestId: string;

  @ManyToOne(() => SupportRequest, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'supportRequestId' })
  supportRequest: SupportRequest;

  /**
   * Dispositivo controlado.
   *
   * Se puede deducir de la solicitud, pero se persiste a proposito: el indice
   * de sesion viva por dispositivo y las consultas de auditoria no pueden
   * depender de un join. El valor sale siempre del `SupportRequest`, nunca del
   * cliente.
   */
  @Column('uuid')
  deviceId: string;

  @ManyToOne(() => Device, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  /**
   * Tecnico asignado a la solicitud. Obligatorio: una sesion sin responsable no
   * seria auditable. Tampoco sale del cliente.
   */
  @Column('uuid')
  technicianId: string;

  // RESTRICT y no SET NULL como en `SupportRequest`: alli la columna es
  // opcional, aqui no; borrar al tecnico dejaria la sesion sin dueno.
  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'technicianId' })
  technician: User;

  /**
   * Columna `text` con el enum de la aplicacion, igual que `SupportRequest`:
   * es la convencion del repositorio y evita alterar tipos en PostgreSQL.
   * Las transiciones las controla `RemoteSessionsService`; no hay ningun
   * endpoint que permita escribir `status` directamente.
   */
  @Column('text', { default: RemoteSessionStatus.CONNECTING })
  status: RemoteSessionStatus;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  /**
   * Momento en que la conexion remota quedo establecida.
   *
   * Permanece `null` mientras no exista WebRTC: se escribira cuando la sesion
   * pase de verdad a `ACTIVE`.
   */
  @Column({ type: 'timestamp', nullable: true })
  connectedAt: Date | null;

  /** Momento del cierre. `null` mientras la sesion siga viva. */
  @Column({ type: 'timestamp', nullable: true })
  endedAt: Date | null;

  /** Quien cerro la sesion. `null` mientras siga viva. */
  @Column('text', { nullable: true })
  endedBy: RemoteSessionEndedBy | null;
}
