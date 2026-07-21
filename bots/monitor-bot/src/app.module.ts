import { Module } from '@nestjs/common'

import { CoreModule } from './core.module'
import { HealthController } from './health/health.controller'
import { PollingModule } from './polling/polling.module'
import { WalletsModule } from './wallets/wallets.module'

@Module({
  imports: [CoreModule, WalletsModule, PollingModule],
  controllers: [HealthController]
})
export class AppModule {}
