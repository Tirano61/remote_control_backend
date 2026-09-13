import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { User } from "../entities/user.entity";
import { JWTPayloadInterface } from "../interfaces/jwt-payload.interface";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ConfigService } from '@nestjs/config';
import { Injectable, UnauthorizedException } from "@nestjs/common";


@Injectable()
export class JwtStrategy extends PassportStrategy( Strategy ){

    constructor(
        @InjectRepository( User )
        private readonly userRepository: Repository<User>,

        configService: ConfigService
    ){
        const jwtSecret = configService.get<string>('JWT_SECRET_KEY');
        if (!jwtSecret) {
            throw new Error('JWT_SECRET_KEY no está definido en la configuración');
        }
        super({
            secretOrKey: jwtSecret,
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        });
    }

    /// Esta funcion se va a llamar si la el token no ha expirado, y la firma es correcta
    async validate( payload: JWTPayloadInterface ): Promise<User> {
        
        const { id } = payload;
        const user = await this.userRepository.findOneBy({ id });

        if( !user )
            throw new UnauthorizedException('Token not valid');
        if(!user.isActive )
            throw new UnauthorizedException('User is inactive, talk with an admin ');

        return user;
        
    }
}