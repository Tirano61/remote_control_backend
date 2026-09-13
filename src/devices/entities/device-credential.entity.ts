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
 * Credencial permanente de un dispositivo.
 *
 * Es la identidad propia de la tablet, separada por completo de la de los
 * usuarios/tecnicos: nace de un enrolamiento exitoso y le permite pedir un
 * Device JWT las veces que haga falta.
 *
 * Un dispositivo puede acumular credenciales historicas (re-enrolamientos),
 * pero solo una puede estar sin revocar: lo garantiza el indice unico parcial.
 */
@Entity('device_credentials')
@Index('IDX_device_credentials_active', ['deviceId'], {
  unique: true,
  where: '"revokedAt" IS NULL',
})
export class DeviceCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  deviceId: string;

  @ManyToOne(() => Device, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  /**
   * SHA-256 del `deviceSecret` en hexadecimal.
   *
   * El secreto es aleatorio y de alta entropia, por lo que no necesita el
   * coste de bcrypt. `select: false` para que no salga por descuido en una
   * consulta ni en una respuesta.
   */
  @Column('text', { select: false })
  secretHash: string;

  /** Ultimo login correcto del dispositivo con esta credencial. */
  @Column({ type: 'timestamp', nullable: true })
  lastUsedAt: Date | null;

  /**
   * Momento en que la credencial dejo de servir, normalmente porque un nuevo
   * enrolamiento emitio otra. Invalida tambien los Device JWT ya emitidos.
   */
  @Column({ type: 'timestamp', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
