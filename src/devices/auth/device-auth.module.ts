import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceCredential } from '../entities/device-credential.entity';
import { Device } from '../entities/device.entity';
import { DeviceAuthController } from './device-auth.controller';
import { DeviceAuthService } from './device-auth.service';
import { DeviceCredentialsService } from './device-credentials.service';
import { DeviceJwtStrategy } from './strategies/device-jwt.strategy';

/**
 * Identidad y autenticacion propias del dispositivo.
 *
 * Tiene su propio `JwtModule` con `DEVICE_JWT_SECRET` y no se exporta a
 * proposito: asi el `JwtService` de los dispositivos no puede colarse en otros
 * modulos ni confundirse con el de los usuarios.
 */
@Module({
  controllers: [DeviceAuthController],
  providers: [DeviceAuthService, DeviceCredentialsService, DeviceJwtStrategy],
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Device, DeviceCredential]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('DEVICE_JWT_SECRET'),
        signOptions: {
          expiresIn:
            configService.get<string>('DEVICE_JWT_EXPIRES_IN') ?? '24h',
        },
      }),
    }),
  ],
  // DeviceCredentialsService lo necesita el enrolamiento para emitir la credencial.
  exports: [DeviceCredentialsService, DeviceJwtStrategy, PassportModule],
})
export class DeviceAuthModule {}
