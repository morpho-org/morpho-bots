import { Controller, Get } from '@nestjs/common'

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', uptime_s: Math.floor(process.uptime()) }
  }
}
