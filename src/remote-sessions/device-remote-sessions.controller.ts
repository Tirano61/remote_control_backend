import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { DeviceAuth } from '../devices/auth/decorators/device-auth.decorator';
import { GetDevice } from '../devices/auth/decorators/get-device.decorator';
import { Device } from '../devices/entities/device.entity';
import { RemoteSessionsService } from './remote-sessions.service';

/**
 * Sesiones remotas vistas desde la tablet.
 *
 * Protegido entero con `@DeviceAuth()`: la identidad sale del Device JWT, no de
 * lo que venga en el body o en la URL. Ningun endpoint recibe `deviceId`.
 *
 * Cuelga de `/device/remote-sessions` y no del mismo prefijo que el controlador
 * de tecnicos, asi que no hay ninguna ruta que dependa del orden de registro.
 */
@Controller('device/remote-sessions')
@DeviceAuth()
export class DeviceRemoteSessionsController {
  constructor(private readonly remoteSessionsService: RemoteSessionsService) {}

  /**
   * Sesion viva del propio dispositivo.
   *
   * Responde `200` con `remoteSession: null` cuando no hay ninguna: no tener
   * sesion es lo normal, no un error. Es el endpoint con el que la tablet
   * recupera su sesion tras reconectarse o reiniciar la app.
   */
  @Get('current')
  findCurrent(@GetDevice('id') deviceId: string) {
    return this.remoteSessionsService.findCurrentForDevice(deviceId);
  }

  /**
   * El usuario de la tablet corta la sesion: `CLOSED` con `endedBy = DEVICE`, y
   * su solicitud pasa a `COMPLETED` en la misma transaccion.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(@Param('id', ParseUUIDPipe) id: string, @GetDevice() device: Device) {
    return this.remoteSessionsService.closeByDevice(id, device);
  }
}
