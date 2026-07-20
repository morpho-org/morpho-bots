import { Module } from '@nestjs/common'

import { CoreModule } from './core.module'
import { HealthController } from './health/health.controller'
import { PollingModule } from './polling/polling.module'

@Module({
  imports: [CoreModule, PollingModule],
  controllers: [HealthController]
})
export class AppModule {}
