import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Credenciales que envia la tablet para obtener su Device JWT.
 *
 * `deviceSecret` es el valor que el backend entrego una unica vez al activarse
 * el enrolamiento. El `publicId` no sirve para autenticarse, por eso no forma
 * parte de este DTO.
 */
export class DeviceLoginDto {
  @IsUUID()
  deviceId: string;

  @IsString()
  @MinLength(32)
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'deviceSecret has an invalid format',
  })
  deviceSecret: string;
}
