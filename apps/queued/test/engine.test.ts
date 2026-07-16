import type { Logger } from '@repo/evm-kit'
import type { RemoteSigner } from '@repo/signer-client'

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { numberToHex, parseEther } from 'viem'
import { base } from 'viem/chains'

import type { QueuedConfig } from '../src/config'

import { createEngine } from '../src/engine'

const SIGNER_ADDRESS = `0x${'ab'.repeat(20)}` as const

// Signing is never exercised by the balance path; a throwing stub proves that.
const FAKE_SIGNER: RemoteSigner = {
  address: SIGNER_ADDRESS,
  signPreparedTransaction: () => {
    throw new Error('unexpected sign in balance test')
  }
}

type Line = { level: string; event: string; fields: Record<string, unknown> }

function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = []
  const make =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, event, fields })
  return {
    logger: { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') },
    lines
  }
}

function baseConfig(home: string, overrides: Partial<QueuedConfig> = {}): QueuedConfig {
  return {
    chainId: base.id,
    chain: base,
    rpcUrl: 'http://rpc.test',
    logLevel: 'debug',
    maxFeeWei: 300_000_000_000n,
    stuckBlocks: 4n,
    dryRun: false,
    socketPath: join(home, 'queued.sock'),
    signer: { kind: 'agent', socketPath: join(home, 'signer.sock') },
    liquidatorAddress: SIGNER_ADDRESS,
    ...overrides
  }
}

// Serves eth_getBalance (and the chainId handshake) from a fixed balance; `null` makes the RPC throw
// so the read-failure branch can be exercised.
function mockRpc(balanceWei: bigint | null): void {
  spyOn(globalThis, 'fetch').mockImplementation((async (
    _url: unknown,
    init?: { body?: string }
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { id: number; method: string }
    switch (body.method) {
      case 'eth_chainId':
        return Response.json({ jsonrpc: '2.0', id: body.id, result: numberToHex(base.id) })
      case 'eth_getBalance':
        if (balanceWei === null) throw new Error('rpc unavailable')
        return Response.json({ jsonrpc: '2.0', id: body.id, result: numberToHex(balanceWei) })
      default:
        throw new Error(`unmocked RPC method ${body.method}`)
    }
  }) as typeof fetch)
}

describe('engine signer balance monitoring', () => {
  afterEach(() => mock.restore())

  async function runStartupCheck(
    balanceWei: bigint | null,
    overrides: Partial<QueuedConfig> = {}
  ): Promise<Line[]> {
    const home = mkdtempSync(join(tmpdir(), 'engine-balance-'))
    mockRpc(balanceWei)
    const { logger, lines } = recordingLogger()
    const engine = createEngine({
      config: baseConfig(home, overrides),
      remoteSigner: FAKE_SIGNER,
      logger,
      home
    })
    try {
      await engine.start()
    } finally {
      await engine.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
    return lines
  }

  it("logs signer.balance at info with a numeric balanceEth (thresholding is BetterStack's job)", async () => {
    const lines = await runStartupCheck(parseEther('1'))
    const balance = lines.filter(l => l.event === 'signer.balance')
    expect(balance).toHaveLength(1)
    expect(balance[0]?.level).toBe('info')
    expect(balance[0]?.fields.address).toBe(SIGNER_ADDRESS)
    expect(balance[0]?.fields.balanceWei).toBe(parseEther('1'))
    expect(balance[0]?.fields.balanceEth).toBe(1)
    // The metric field must be a real JSON number so BetterStack can aggregate on it.
    expect(typeof balance[0]?.fields.balanceEth).toBe('number')
  })

  it('stays at info even on a tiny balance — the daemon never thresholds', async () => {
    const lines = await runStartupCheck(parseEther('0.000001'))
    const balance = lines.filter(l => l.event === 'signer.balance')
    expect(balance).toHaveLength(1)
    expect(balance[0]?.level).toBe('info')
  })

  it('logs signer.balance_failed at warn when the read throws, without crashing startup', async () => {
    const lines = await runStartupCheck(null)
    expect(lines.some(l => l.event === 'signer.balance')).toBe(false)
    const failed = lines.filter(l => l.event === 'signer.balance_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.level).toBe('warn')
    expect(failed[0]?.fields.address).toBe(SIGNER_ADDRESS)
  })
})
