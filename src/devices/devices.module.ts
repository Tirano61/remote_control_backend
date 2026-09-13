import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceEnrollmentController } from './device-enrollment.controller';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DeviceEnrollment } from './entities/device-enrollment.entity';
import { Device } from './entities/device.entity';

@Module({
  controllers: [DevicesController, DeviceEnrollmentController],
  providers: [DevicesService, DeviceEnrollmentService],
  // AuthModule aporta Passport/JwtStrategy para poder usar @Auth() en las rutas.
  imports: [TypeOrmModule.forFeature([Device, DeviceEnrollment]), AuthModule],
  exports: [TypeOrmModule, DevicesService],
})
export class DevicesModule {}
