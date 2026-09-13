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
import {
  ACTIVE_SUPPORT_REQUEST_STATUSES,
  SupportRequestStatus,
} from '../enums/support-request-status.enum';

/** Nombre del indice unico parcial, para reconocer su violacion en el servicio. */
export const ACTIVE_SUPPORT_REQUEST_INDEX =
  'IDX_support_requests_device_active';

/**
 * Lista de estados activos en SQL, derivada del enum para que el indice no
 * pueda quedar desalineado si manana se agrega un estado.
 */
const ACTIVE_STATUSES_SQL = ACTIVE_SUPPORT_REQUEST_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');

/**
 * Solicitud de asistencia abierta por el usuario de una tablet.
 *
 * Un dispositivo puede acumular solicitudes historicas, pero solo una puede
 * estar activa a la vez: lo garantiza el indice unico parcial, no una
 * comprobacion previa en la aplicacion (entre el SELECT y el INSERT habria una
 * carrera).
 *
 * `ACCEPTED` significa unicamente que el usuario autorizo al tecnico a
 * continuar: la sesion remota es otro concepto y llegara mas adelante.
 *
 * CUIDADO al agregar estados: `synchronize` compara nombre, columnas y
 * unicidad de los indices, pero no su condicion, asi que un cambio en la lista
 * de estados activos NO se aplicaria solo sobre una base ya creada; habria que
 * recrear el indice explicitamente.
 */
@Entity('support_requests')
@Index(ACTIVE_SUPPORT_REQUEST_INDEX, ['deviceId'], {
  unique: true,
  where: `"status" IN (${ACTIVE_STATUSES_SQL})`,
})
// Listado del tecnico: `GET /support-requests?status=WAITING`.
@Index(['status'])
// Solicitudes de un tecnico concreto. Parcial: la mayoria de las filas tienen
// technicianId NULL y no aportan nada al indice.
@Index(['technicianId'], { where: '"technicianId" IS NOT NULL' })
export class SupportRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  deviceId: string;

  @ManyToOne(() => Device, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  /**
   * Tecnico que tomo la solicitud. `null` mientras esta en `WAITING`.
   *
   * Los tecnicos son usuarios del sistema con el rol correspondiente: no hay
   * una entidad `Technician` aparte.
   */
  @Column('uuid', { nullable: true })
  technicianId: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'technicianId' })
  technician: User | null;

  /**
   * Columna `text` con el enum de la aplicacion, igual que `User.roles`: es la
   * convencion del repositorio y evita alterar tipos en PostgreSQL.
   * Las transiciones validas las controla `SupportRequestsService`; no existe
   * ningun endpoint que permita escribir `status` directamente.
   */
  @Column('text', { default: SupportRequestStatus.WAITING })
  status: SupportRequestStatus;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  /** Momento en que un tecnico tomo la solicitud. */
  @Column({ type: 'timestamp', nullable: true })
  assignedAt: Date | null;

  /** Momento en que el usuario del dispositivo acepto o rechazo al tecnico. */
  @Column({ type: 'timestamp', nullable: true })
  respondedAt: Date | null;

  /** Momento en que la solicitud llego a un estado terminal. */
  @Column({ type: 'timestamp', nullable: true })
  closedAt: Date | null;
}
