import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('devices')
export class Device {
  /** Identificador interno, usado para las relaciones de base de datos. */
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Identificador publico legible (ej. `384-729-142`).
   * Lo genera el backend y la unicidad la garantiza la base de datos.
   * NO es una credencial: identifica al dispositivo, no lo autentica.
   */
  @Column('text', { unique: true })
  publicId: string;

  /** Nombre descriptivo asignado por el tecnico (ej. `Tablet Tolva 01`). */
  @Column('text', { nullable: true })
  name: string | null;

  @Column('text', { nullable: true })
  manufacturer: string | null;

  @Column('text', { nullable: true })
  model: string | null;

  @Column('text', { nullable: true })
  androidVersion: string | null;

  @Column('text', { nullable: true })
  appVersion: string | null;

  /**
   * Estado administrativo: indica si el dispositivo esta habilitado.
   * No representa la presencia/conexion (ONLINE / OFFLINE).
   */
  @Column('bool', { default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
