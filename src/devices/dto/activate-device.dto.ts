import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Datos que envia la tablet para activarse por primera vez.
 *
 * El dispositivo se identifica con su `publicId` y demuestra estar autorizado
 * con el codigo de activacion entregado por el tecnico. Ningun otro
 * identificador enviado por el cliente se considera confiable, por eso el DTO
 * no acepta `id` ni ningun campo administrativo como `name` o `isActive`.
 */
export class ActivateDeviceDto {
  @IsString()
  @Matches(/^\d{3}-\d{3}-\d{3}$/, {
    message: 'publicId must follow the format XXX-XXX-XXX',
  })
  publicId: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

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
