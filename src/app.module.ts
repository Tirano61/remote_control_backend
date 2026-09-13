import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';




@Module({
	imports: [
		ConfigModule.forRoot(),
		TypeOrmModule.forRoot({
			type: 'postgres',
			host: process.env.DB_HOST,
			port: +(process.env.DB_PORT ?? 5455),
			database: process.env.POSTGRES_DB_NAME,
			username: process.env.POSTGRES_USER,
			password: process.env.POSTGRES_PASSWORD,
			autoLoadEntities: true,
			synchronize: true, // importante: no permitir que TypeORM altere esquema con tipos no reconocidos
			extra: {}
		}),
		AuthModule,


	],
	controllers: [],
	providers: [],
})
export class AppModule { }
