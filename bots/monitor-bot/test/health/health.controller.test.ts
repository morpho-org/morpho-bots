import type { INestApplication } from '@nestjs/common'

import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AppModule } from '../../src/app.module'
import { LOGGER } from '../../src/logging/logger.provider'
import { fakeLogger } from '../helpers'

describe('GET /health', () => {
  let app: INestApplication

  beforeAll(async () => {
    // Override the real bot-kit logger so the suite doesn't print live JSON lines to stderr.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOGGER)
      .useValue(fakeLogger())
      .compile()
    app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    // Port 0 lets the OS pick a free port so parallel test runs never collide.
    await app.listen(0)
  })

  afterAll(async () => {
    await app.close()
  })

  it('responds 200 with ok status over real http', async () => {
    const response = await fetch(`${await app.getUrl()}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string; uptime_s: number }
    expect(body.status).toBe('ok')
    expect(body.uptime_s).toBeGreaterThanOrEqual(0)
  })
})
