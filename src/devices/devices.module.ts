import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { Device } from './entities/device.entity';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService],
  // AuthModule aporta Passport/JwtStrategy para poder usar @Auth() en las rutas.
  imports: [TypeOrmModule.forFeature([Device]), AuthModule],
  exports: [TypeOrmModule, DevicesService],
})
export class DevicesModule {}
