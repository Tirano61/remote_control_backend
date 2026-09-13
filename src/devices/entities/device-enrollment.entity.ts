import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Device } from './device.entity';

/**
 * Codigo temporal de activacion de un dispositivo.
 *
 * El enrolamiento se modela aparte del dispositivo porque son conceptos
 * distintos: un mismo `Device` puede necesitar enrolarse varias veces a lo
 * largo de su vida util, por lo que puede tener varios enrolamientos.
 *
 * El codigo en texto plano solo existe en la respuesta que recibe el tecnico:
 * en la base de datos se guarda unicamente su hash.
 */
@Entity('device_enrollments')
@Index(['deviceId'])
export class DeviceEnrollment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  deviceId: string;

  @ManyToOne(() => Device, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  /**
   * Hash bcrypt del codigo de activacion.
   * `select: false` para que nunca salga en una consulta por descuido.
   */
  @Column('text', { select: false })
  codeHash: string;

  /** Momento a partir del cual el codigo deja de ser valido. */
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  /** Momento en que el codigo fue consumido. El codigo es de un solo uso. */
  @Column({ type: 'timestamp', nullable: true })
  usedAt: Date | null;

  /**
   * Momento en que el codigo fue invalidado sin usarse: porque el tecnico
   * genero uno nuevo o porque se agotaron los intentos fallidos.
   */
  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  /** Intentos de activacion fallidos contra este codigo. */
  @Column('int', { default: 0 })
  failedAttempts: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
