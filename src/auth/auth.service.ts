import { BadRequestException, Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { CreateUserDto } from './dto/create_user.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import  * as bcrypt from 'bcrypt'
import { LoginUserDto } from './dto/login_user.dto';
import { JWTPayloadInterface } from './interfaces/jwt-payload.interface';
import { JwtService } from '@nestjs/jwt';


@Injectable()
export class AuthService {
  /// Inyectado el repositorio de la tabla de usuarios
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
  ){}

  async createUser(createUserDto: CreateUserDto) {
    try {
      const { password, ...userData } = createUserDto;
      const user = this.userRepository.create({
        ...userData,
        password: bcrypt.hashSync( password, 10 ),
      });

      await this.userRepository.save( user );

      delete (user as any).password;
      
      return {
        ...user,
        token: this.getJwtToken({ id: user.id })
      };
      
    } catch (error) {
      this.handleDBError(error);
    }
  }

  async loginUser(loginUserDto: LoginUserDto){
    
    const { email, password } = loginUserDto;

    const user = await this.userRepository.findOne({
      where: { email },
      select: { id: true, email: true, password: true, fullName: true, roles: true, isActive: true }
    });

    if( !user )
      throw new UnauthorizedException('Credentials are not valid');

    if( !bcrypt.compareSync(password, user.password))
      throw new UnauthorizedException('Credentials are not valid')

    if( !user.isActive )
      throw new UnauthorizedException('User is inactive, talk with an admin');

    delete (user as any).password;

    return {
      ...user,
      token: this.getJwtToken({ id: user.id })
    };
  }

  checkAuthStatus(user: User){
    return {
      ...user,
      token: this.getJwtToken({ id: user.id })
    };
  }

  /**
   * Comprobaciones que hay detrás de un JWT de usuario ya verificado.
   *
   * Es la única fuente de verdad de "este token identifica a un usuario válido":
   * la usan tanto la estrategia de Passport (HTTP) como la autenticación del
   * socket del técnico, así que las reglas no se duplican entre transportes.
   */
  async validateJwtPayload( payload: JWTPayloadInterface ): Promise<User> {

    const { id } = payload;
    const user = await this.userRepository.findOneBy({ id });

    if( !user )
      throw new UnauthorizedException('Token not valid');

    if( !user.isActive )
      throw new UnauthorizedException('User is inactive, talk with an admin ');

    return user;
  }

  /**
   * Autentica un JWT de usuario recibido fuera de Passport, como el del
   * handshake de Socket.IO.
   *
   * Verifica firma y vencimiento y después revalida el estado actual del
   * usuario: el mismo camino que sigue la estrategia HTTP.
   */
  async authenticateToken( token: string ): Promise<User> {

    let payload: JWTPayloadInterface;

    try {
      payload = await this.jwtService.verifyAsync<JWTPayloadInterface>( token );
    } catch {
      throw new UnauthorizedException('Token not valid');
    }

    return this.validateJwtPayload( payload );
  }

  private getJwtToken(payload: JWTPayloadInterface){
    const token = this.jwtService.sign( payload );
    return token;
  }

  private handleDBError(error: any): never {
    if(error.code === '23505')
      throw new BadRequestException(error.detail);
    console.log(error);

    throw new InternalServerErrorException('Please check server logs');
  }

}
