import { describe, expect, it } from 'bun:test'

import { BOTS, isBotName } from '../scripts/manifest'
import { deploymentListArgs, upArgs } from '../scripts/railway'

const target = {
  service: 'bot-8453',
  projectId: 'proj-123',
  environment: 'staging'
}

describe('Railway CLI argv', () => {
  it('omits -p/-e under a project token (which already pins them)', () => {
    expect(upArgs({ ...target, hasToken: true })).toEqual(['railway', 'up', '-s', 'bot-8453', '-d'])
    expect(deploymentListArgs({ ...target, hasToken: true })).toEqual([
      'railway',
      'deployment',
      'list',
      '-s',
      'bot-8453',
      '--limit',
      '1',
      '--json'
    ])
  })

  it('passes -p/-e when there is no token (link-based context)', () => {
    expect(upArgs({ ...target, hasToken: false })).toEqual([
      'railway',
      'up',
      '-s',
      'bot-8453',
      '-p',
      'proj-123',
      '-e',
      'staging',
      '-d'
    ])
    expect(deploymentListArgs({ ...target, hasToken: false })).toEqual([
      'railway',
      'deployment',
      'list',
      '-s',
      'bot-8453',
      '-p',
      'proj-123',
      '-e',
      'staging',
      '--limit',
      '1',
      '--json'
    ])
  })
})

describe('deployable-bot manifest', () => {
  it('lists the services each bot ships (Postgres excluded — it is managed)', () => {
    expect(BOTS['blue-liq'].services).toEqual(['rindexer', 'bot-8453', 'bot-4663'])
    expect(BOTS['midnight-liq'].services).toEqual(['bot'])
    expect(BOTS['blue-liq'].services).not.toContain('Postgres')
  })

  it('maps each chain to its service', () => {
    expect(BOTS['blue-liq'].chains).toEqual([
      { chainId: 8453, service: 'bot-8453' },
      { chainId: 4663, service: 'bot-4663' }
    ])
    expect(BOTS['midnight-liq'].chains[0]).toEqual({ chainId: 8453, service: 'bot' })
  })

  it('accepts only known bot names', () => {
    expect(isBotName('blue-liq')).toBe(true)
    expect(isBotName('midnight-liq')).toBe(true)
    expect(isBotName('blue')).toBe(false)
    expect(isBotName('rewards')).toBe(false)
    expect(isBotName('')).toBe(false)
  })
})
