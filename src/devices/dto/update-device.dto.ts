import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateDeviceDto } from './create-device.dto';

/**
 * Campos administrables de un dispositivo.
 *
 * Hereda los campos editables de `CreateDeviceDto` y agrega el estado
 * administrativo. `id`, `publicId`, `createdAt` y `updatedAt` no son
 * modificables por el cliente.
 */
export class UpdateDeviceDto extends PartialType(CreateDeviceDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
