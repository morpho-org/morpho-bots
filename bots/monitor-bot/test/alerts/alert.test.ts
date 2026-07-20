import { describe, expect, it } from 'vitest'

import { LogAlertDispatcher } from '../../src/alerts/alert'
import { fakeLogger } from '../helpers'

describe('LogAlertDispatcher', () => {
  it('logs one structured line per alert', async () => {
    const logger = fakeLogger()
    const dispatcher = new LogAlertDispatcher(logger)
    await dispatcher.send([
      { key: 'k1', title: 'first', lines: ['l1'], severity: 'info' },
      { key: 'k2', title: 'second', lines: [], severity: 'critical' }
    ])
    expect(logger.info).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenNthCalledWith(1, 'alert', {
      key: 'k1',
      title: 'first',
      severity: 'info',
      lines: ['l1']
    })
    expect(logger.info).toHaveBeenNthCalledWith(2, 'alert', {
      key: 'k2',
      title: 'second',
      severity: 'critical',
      lines: []
    })
  })
})
