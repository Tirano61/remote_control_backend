import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceAuthModule } from '../devices/auth/device-auth.module';
import { DevicePresenceModule } from '../devices/presence/device-presence.module';
import { DeviceRealtimeModule } from '../devices/realtime/device-realtime.module';
import { DeviceSupportRequestsController } from './device-support-requests.controller';
import { SupportRequest } from './entities/support-request.entity';
import { SupportRequestsController } from './support-requests.controller';
import { SupportRequestsService } from './support-requests.service';

/**
 * Solicitudes de asistencia.
 *
 * Modulo propio, fuera de `DevicesModule`: es un dominio distinto y ademas no
 * importa `DevicesModule`, solo las piezas concretas que necesita (presencia y
 * salida de eventos), de modo que no puede aparecer una dependencia circular
 * entre ambos.
 *
 * El controlador del dispositivo se declara primero a proposito: Nest resuelve
 * las rutas en el orden en que se registran, y asi `GET /support-requests/current`
 * se empareja antes que `GET /support-requests/:id` del controlador de tecnicos.
 */
@Module({
  controllers: [DeviceSupportRequestsController, SupportRequestsController],
  providers: [SupportRequestsService],
  imports: [
    TypeOrmModule.forFeature([SupportRequest]),
    // Aporta Passport/JwtStrategy para `@Auth()` en las rutas de tecnicos.
    AuthModule,
    // Aporta la estrategia `device-jwt` para `@DeviceAuth()` en las de tablet.
    DeviceAuthModule,
    // Presencia: no se asigna una solicitud de un dispositivo OFFLINE, y el
    // listado del tecnico muestra `device.isOnline`.
    DevicePresenceModule,
    // Salida de eventos hacia la tablet (`support:assigned`).
    DeviceRealtimeModule,
  ],
  exports: [TypeOrmModule, SupportRequestsService],
})
export class SupportRequestsModule {}
