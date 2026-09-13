import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Auth } from '../auth/decorators/auth.decorator';
import { ValidRoles } from '../auth/interfaces/valid-roles';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { DevicesService } from './devices.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';

/**
 * Endpoints administrativos de dispositivos.
 *
 * Son para usuarios autenticados (tecnicos/admin). La tablet tendra su propia
 * identidad y credencial en un paso posterior: este JWT no es para dispositivos.
 */
@Controller('devices')
@Auth(ValidRoles.admin, ValidRoles.tecnico)
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly deviceEnrollmentService: DeviceEnrollmentService,
  ) {}

  @Post()
  create(@Body() createDeviceDto: CreateDeviceDto) {
    return this.devicesService.create(createDeviceDto);
  }

  @Get()
  findAll() {
    return this.devicesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.devicesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDeviceDto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(id, updateDeviceDto);
  }

  /**
   * Genera el codigo de activacion que el usuario escribira en la tablet.
   * El codigo se devuelve en texto plano una unica vez.
   */
  @Post(':id/enrollment')
  createEnrollment(@Param('id', ParseUUIDPipe) id: string) {
    return this.deviceEnrollmentService.createEnrollmentCode(id);
  }
}
