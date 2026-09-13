import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { ActivateDeviceDto } from './dto/activate-device.dto';

/**
 * Endpoint publico de enrolamiento, usado unicamente por la tablet.
 *
 * No lleva `@Auth()` a proposito: el dispositivo todavia no tiene identidad
 * propia y nunca debe usar el JWT de un tecnico. Lo que autoriza la activacion
 * es el codigo temporal que el tecnico genero para ese dispositivo.
 */
@Controller('device-enrollment')
export class DeviceEnrollmentController {
  constructor(
    private readonly deviceEnrollmentService: DeviceEnrollmentService,
  ) {}

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  activate(@Body() activateDeviceDto: ActivateDeviceDto) {
    return this.deviceEnrollmentService.activate(activateDeviceDto);
  }
}
