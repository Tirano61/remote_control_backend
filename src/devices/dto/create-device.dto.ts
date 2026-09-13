import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Datos que el cliente puede enviar al registrar un dispositivo.
 *
 * `id`, `publicId`, `createdAt` y `updatedAt` los genera el backend
 * y por eso no forman parte del DTO.
 */
export class CreateDeviceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  manufacturer?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  androidVersion?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  appVersion?: string;
}
