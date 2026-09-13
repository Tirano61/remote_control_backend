import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceAuthModule } from './auth/device-auth.module';
import { DeviceEnrollmentController } from './device-enrollment.controller';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DeviceEnrollment } from './entities/device-enrollment.entity';
import { Device } from './entities/device.entity';

@Module({
  controllers: [DevicesController, DeviceEnrollmentController],
  providers: [DevicesService, DeviceEnrollmentService],
  imports: [
    TypeOrmModule.forFeature([Device, DeviceEnrollment]),
    // AuthModule aporta Passport/JwtStrategy para poder usar @Auth() en las rutas.
    AuthModule,
    // Identidad propia del dispositivo: emite la credencial al activarse el
    // enrolamiento y expone /device-auth. Su JwtService no sale de ese modulo.
    DeviceAuthModule,
  ],
  exports: [TypeOrmModule, DevicesService],
})
export class DevicesModule {}
