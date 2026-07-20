import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'

import { ALERT_DISPATCHER, LogAlertDispatcher } from '../alerts/alert'
import { CURSOR_STORE, InMemoryCursorStore } from '../cursor/cursor.store'
import { POLLERS } from './poller'
import { PollerRegistrar } from './poller.registrar'

// Concrete pollers land in follow-up PRs; each gets provided here and collected into the POLLERS
// array the registrar consumes.
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    { provide: CURSOR_STORE, useClass: InMemoryCursorStore },
    { provide: ALERT_DISPATCHER, useClass: LogAlertDispatcher },
    { provide: POLLERS, useValue: [] },
    PollerRegistrar
  ]
})
export class PollingModule {}
