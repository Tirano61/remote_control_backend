import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Device } from '../entities/device.entity';
import { DeviceAuth } from './decorators/device-auth.decorator';
import { GetDevice } from './decorators/get-device.decorator';
import { DeviceAuthService } from './device-auth.service';
import { DeviceLoginDto } from './dto/device-login.dto';

/**
 * Autenticacion de dispositivos, separada de `/auth` (usuarios/tecnicos).
 *
 * La tablet obtiene aqui su Device JWT con la credencial permanente que
 * recibio al enrolarse. Nunca usa las credenciales de un tecnico.
 */
@Controller('device-auth')
export class DeviceAuthController {
  constructor(private readonly deviceAuthService: DeviceAuthService) {}

  /** Endpoint publico: la credencial del dispositivo es lo que autoriza. */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() deviceLoginDto: DeviceLoginDto) {
    return this.deviceAuthService.login(deviceLoginDto);
  }

  /**
   * Valida el Device JWT actual y devuelve el dispositivo autenticado.
   *
   * No renueva el token: cuando vence, la tablet vuelve a `/device-auth/login`
   * con su credencial permanente.
   */
  @Get('check-status')
  @DeviceAuth()
  checkDeviceStatus(@GetDevice() device: Device) {
    return this.deviceAuthService.checkDeviceStatus(device);
  }
}
