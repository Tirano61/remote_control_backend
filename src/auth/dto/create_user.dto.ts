import { ArrayNotEmpty, IsArray, IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { ValidRoles } from "../interfaces/valid-roles";


export class CreateUserDto {

    @IsString()
    @IsEmail()
    email: string;

    @IsString()
    @MinLength(6)
    @MaxLength(50)
    @Matches(
        /(?:(?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
        message: 'The password must have a Uppercase, lowercase letter and a number'
    })
    password: string;

    @IsString()
    @MinLength(1)
    fullName: string;

    /**
     * Roles del usuario a crear. Solo valores de ValidRoles.
     * Si se omite se respeta el default de la columna (`user`), que no da
     * acceso a ningun endpoint de tecnico ni de administracion.
     */
    @IsOptional()
    @IsArray()
    @ArrayNotEmpty()
    @IsEnum(ValidRoles, { each: true })
    roles?: ValidRoles[];

}