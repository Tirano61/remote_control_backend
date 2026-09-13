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
import { SupportRequestsService } from './support-requests.service';

/**
 * Solicitudes de asistencia vistas desde la tablet.
 *
 * Protegido entero con `@DeviceAuth()`: la identidad sale del Device JWT, no
 * de lo que venga en el body o en la URL. Ningun endpoint recibe `deviceId`.
 *
 * Va en un controlador aparte del de tecnicos porque la identidad que lo
 * protege es otra, aunque ambos cuelguen de `/support-requests`.
 */
@Controller('support-requests')
@DeviceAuth()
export class DeviceSupportRequestsController {
  constructor(
    private readonly supportRequestsService: SupportRequestsService,
  ) {}

  /** El usuario pulsa "Solicitar asistencia". Body vacio. */
  @Post()
  create(@GetDevice() device: Device) {
    return this.supportRequestsService.createForDevice(device);
  }

  /**
   * Solicitud activa del propio dispositivo.
   *
   * Responde `200` con `supportRequest: null` cuando no hay ninguna: no tener
   * solicitud es normal, no un error.
   */
  @Get('current')
  findCurrent(@GetDevice('id') deviceId: string) {
    return this.supportRequestsService.findCurrentForDevice(deviceId);
  }

  /** El usuario acepta al tecnico asignado: `ASSIGNED -> ACCEPTED`. */
  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@Param('id', ParseUUIDPipe) id: string, @GetDevice() device: Device) {
    return this.supportRequestsService.acceptByDevice(id, device);
  }

  /** El usuario rechaza al tecnico asignado: `ASSIGNED -> REJECTED`. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseUUIDPipe) id: string, @GetDevice() device: Device) {
    return this.supportRequestsService.rejectByDevice(id, device);
  }

  /** El usuario retira su solicitud desde cualquier estado activo. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', ParseUUIDPipe) id: string, @GetDevice() device: Device) {
    return this.supportRequestsService.cancelByDevice(id, device);
  }
}
