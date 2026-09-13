import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceAuthModule } from '../devices/auth/device-auth.module';
import { DevicePresenceModule } from '../devices/presence/device-presence.module';
import { DeviceRealtimeModule } from '../devices/realtime/device-realtime.module';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
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
 * Tampoco importa `RemoteSessionsModule`, solo su entidad: los dos dominios se
 * registran mutuamente la entidad del otro y ninguno depende del servicio del
 * otro, asi que no hay ciclo.
 *
 * El controlador del dispositivo se declara primero a proposito: Nest resuelve
 * las rutas en el orden en que se registran, y asi `GET /support-requests/current`
 * se empareja antes que `GET /support-requests/:id` del controlador de tecnicos.
 */
@Module({
  controllers: [DeviceSupportRequestsController, SupportRequestsController],
  providers: [SupportRequestsService],
  imports: [
    // `RemoteSession` se registra solo para que su metadata exista siempre que
    // este modulo se cargue: la cancelacion comprueba si la solicitud ya tiene
    // una sesion viva. La consulta NO usa este repositorio, la hace el
    // `EntityManager` de la transaccion que sostiene el lock; inyectar
    // `RemoteSessionsService` acoplaria los dos dominios y consultar por un
    // repositorio propio saldria fuera de la transaccion.
    TypeOrmModule.forFeature([SupportRequest, RemoteSession]),
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
