import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { User } from "../entities/user.entity";
import { JWTPayloadInterface } from "../interfaces/jwt-payload.interface";
import { ConfigService } from '@nestjs/config';
import { Injectable } from "@nestjs/common";
import { AuthService } from "../auth.service";


@Injectable()
export class JwtStrategy extends PassportStrategy( Strategy ){

    constructor(
        private readonly authService: AuthService,

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
    /// Las comprobaciones viven en AuthService para que HTTP y Socket.IO usen
    /// exactamente las mismas: usuario existente y activo.
    validate( payload: JWTPayloadInterface ): Promise<User> {

        return this.authService.validateJwtPayload( payload );

    }
}