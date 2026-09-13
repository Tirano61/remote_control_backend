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
