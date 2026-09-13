import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create_user.dto';
import { LoginUserDto } from './dto/login_user.dto';
import { GetUser } from './decorators/get-user.decorator';
import { Auth } from './decorators/auth.decorator';
import { ValidRoles } from './interfaces/valid-roles';
import { User } from './entities/user.entity';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Alta administrativa de usuarios. No es autorregistro: los usuarios
   * representan personal autorizado, asi que solo un admin puede crearlos.
   */
  @Post('register')
  @Auth(ValidRoles.admin)
  createUser(@Body() createUserDto: CreateUserDto) {
    return this.authService.createUser(createUserDto);
  }

  // Autenticar no crea un recurso: 200, no el 201 por defecto de POST.
  @Post('login')
  @HttpCode(HttpStatus.OK)
  loginUser(@Body() loginUserDto: LoginUserDto) {
    return this.authService.loginUser(loginUserDto);
  }

  /**
   * Valida el token actual y devuelve el usuario con un token renovado.
   * Util para que el cliente compruebe la sesion al arrancar.
   */
  @Get('check-status')
  @Auth()
  checkAuthStatus(@GetUser() user: User) {
    return this.authService.checkAuthStatus(user);
  }
}
