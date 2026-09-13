import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { buildTypeOrmOptions } from './config/database.config';
import { DevicesModule } from './devices/devices.module';
import { RemoteSessionsModule } from './remote-sessions/remote-sessions.module';
import { SignalingModule } from './signaling/signaling.module';
import { SupportRequestsModule } from './support-requests/support-requests.module';

@Module({
  imports: [
    ConfigModule.forRoot(),

    // `forRootAsync` y no un objeto literal: asi las opciones se construyen
    // cuando `ConfigModule` ya cargo el `.env`, y no dependen del orden en
    // que se evalue este array.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmOptions({
          DATABASE_URL: configService.get<string>('DATABASE_URL'),
        }),
    }),
    AuthModule,
    DevicesModule,
    SupportRequestsModule,
    RemoteSessionsModule,
    SignalingModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
