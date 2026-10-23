import { Controller, Get, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from './database/prisma.service';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { LoginRateLimitGuard } from './auth/login-rate-limit';
import { TasksService } from './tasks/tasks.service';
import { SyncGateway } from './sync/sync.gateway';
import { jwtSecret } from './config';

@Controller()
class HealthController {
  constructor(private readonly db: PrismaService) {}
  @Get('health')
  async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
@Module({
  imports: [JwtModule.register({ secret: jwtSecret(), signOptions: { expiresIn: '8h' } })],
  controllers: [AuthController, HealthController],
  providers: [PrismaService, AuthService, LoginRateLimitGuard, TasksService, SyncGateway],
})
export class AppModule {}
