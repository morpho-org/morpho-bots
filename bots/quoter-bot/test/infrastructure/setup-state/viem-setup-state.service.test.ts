import type { AddressInfo } from 'node:net'
import type { Address, Hex } from 'viem'

import { setterRatifierAbi } from '@morpho-org/midnight-sdk'
import { blueAbi } from '@morpho-org/morpho-sdk/abis'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { bytesToHex, hexToBytes, keccak256, zeroHash } from 'viem'
import { describe, expect, test } from 'vitest'

import { SafeProviderError } from '../../../src/application/setup/safe-provider.error'
import { requestJson } from '../../../src/infrastructure/setup-state/http-json.utils'
import { ProviderPaginationError } from '../../../src/infrastructure/setup-state/provider-pagination.error'
import { ProviderReadError } from '../../../src/infrastructure/setup-state/provider-read.error'
import { executeProviderRead } from '../../../src/infrastructure/setup-state/provider-read.utils'
import { ProviderResponseError } from '../../../src/infrastructure/setup-state/provider-response.error'
import { ViemSetupStateService } from '../../../src/infrastructure/setup-state/viem-setup-state.service'

// bun's `Bun.serve` accepted a Web-standard fetch handler and exposed `.port`/`.stop()`. These tests
// only need a throwaway loopback server, so this keeps that shape over node:http.
const startFixtureServer = async (
  handler: () => Response | Promise<Response>
): Promise<{ port: number; stop: () => Promise<void> }> => {
  // Node's request listener is void-returning; consume the promise here so a handler failure cannot
  // escape as an unhandled rejection.
  const server = createServer((_incoming, outgoing): void => {
    void (async () => {
      const response = await handler()
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500)
      outgoing.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
    }
  }
}

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanAsset: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E'
const setterRatifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'
const marketId: Hex = `0x${'55'.repeat(32)}`
const referenceMarketId: Hex = `0x${'88'.repeat(32)}`
const knownGroup: Hex = `0x${'66'.repeat(32)}`
const unknownGroup: Hex = `0x${'77'.repeat(32)}`
const removedMarketId: Hex = `0x${'ab'.repeat(32)}`
const authoritativeRatifierRuntime = (
  await readFile(new URL('../../fixtures/ecrecover-ratifier-base.hex', import.meta.url), 'utf8')
).trim() as Hex
const authoritativeRatifierRuntimeHash =
  '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1'
const authoritativeSetterRatifierRuntime = (
  await readFile(new URL('../../fixtures/setter-ratifier-base.hex', import.meta.url), 'utf8')
).trim() as Hex

const createState = (
  responses: Record<string, unknown>,
  overrides: {
    code?: Hex
    ratifierMidnight?: Address
    rootCanceled?: unknown
    rootRatified?: unknown
    rejectRatifierReads?: boolean
    missingReferenceMarket?: boolean
    referenceLoanAsset?: Address
    requestLimit?: number
    requestTimeoutMs?: number
    now?: () => number
    onRequest?: (url: string, timeoutMs: number | undefined) => unknown
    marketIds?: readonly Hex[]
    v0OfferGroupIds?: readonly Hex[]
    readOnly?: boolean
    persistedGroupIds?: readonly Hex[]
    ignoredGroupIds?: readonly Hex[]
    readOwnedGroupIds?: () => Promise<readonly Hex[]>
    bootstrapGroupIds?: readonly Hex[]
    ladderSellGroupIds?: readonly Hex[]
  } = {}
) => {
  const calls: string[] = []
  const chainReadCalls: Record<string, unknown>[] = []
  const requestBudgets: (number | undefined)[] = []
  const referenceAbis: unknown[] = []
  const chain = {
    getChainId: async () => 8453,
    getCode: async () => overrides.code ?? authoritativeRatifierRuntime,
    getBalance: async () => 10n,
    getBlock: async () => ({ number: 100n, timestamp: 1_000n }),
    readContract: async (parameters: Record<string, unknown>) => {
      chainReadCalls.push(parameters)
      const { functionName } = parameters
      if (functionName === 'allowance') return 100n
      if (functionName === 'isAuthorized') return true
      if (functionName === 'MIDNIGHT') {
        if (overrides.rejectRatifierReads) throw new Error('undeployed ratifier')
        return overrides.ratifierMidnight ?? midnight
      }
      if (functionName === 'isRootCanceled') {
        if (overrides.rejectRatifierReads) throw new Error('undeployed ratifier')
        return overrides.rootCanceled ?? false
      }
      if (functionName === 'isRootRatified') {
        if (overrides.rejectRatifierReads) throw new Error('undeployed ratifier')
        return overrides.rootRatified ?? false
      }
      if (functionName === 'toMarket') {
        return {
          chainId: 8453n,
          midnight,
          loanToken: loanAsset,
          collateralParams: [],
          maturity: 2_000n,
          rcfThreshold: 0n,
          enterGate: maker,
          liquidatorGate: maker
        }
      }
      if (functionName === 'tickSpacing') return 4
      throw new Error(`unexpected ${String(functionName)}`)
    }
  }
  const reference = {
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
      calls.push(blockTag ?? String(blockNumber))
      return blockTag === 'latest'
        ? { number: 100n, timestamp: 1_000n }
        : { number: blockNumber ?? null, timestamp: 998n }
    },
    readContract: async (parameters: Record<string, unknown>) => {
      const { functionName, args, blockNumber } = parameters
      referenceAbis.push(parameters.abi)
      calls.push(`${String(functionName)}:${String((args as unknown[])[0])}:${String(blockNumber)}`)
      if (functionName === 'idToMarketParams') {
        return [
          overrides.missingReferenceMarket
            ? '0x0000000000000000000000000000000000000000'
            : (overrides.referenceLoanAsset ?? loanAsset),
          maker,
          midnight,
          ratifier,
          860_000_000_000_000_000n
        ]
      }
      if (functionName === 'market') {
        return [
          1_000n,
          overrides.missingReferenceMarket ? 0n : 1_000n,
          500n,
          500n,
          overrides.missingReferenceMarket ? 0n : 900n,
          0n
        ]
      }
      throw new Error(`unexpected reference function ${String(functionName)}`)
    }
  }
  const request = async (url: string, _provider: unknown, timeoutMs?: number) => {
    calls.push(url)
    requestBudgets.push(timeoutMs)
    if (overrides.requestLimit !== undefined && calls.length > overrides.requestLimit) {
      throw new Error('test request limit reached')
    }
    if (overrides.onRequest) return overrides.onRequest(url, timeoutMs)
    const match = Object.entries(responses).find(([path]) => url.includes(path))
    if (match) return match[1]
    if (url.includes('/v0/midnight/markets')) {
      return {
        cursor: null,
        data: [{ market_id: marketId, chain_id: 8453, listed: true }]
      }
    }
    throw new Error(`unexpected URL ${url}`)
  }
  return {
    calls,
    chainReadCalls,
    requestBudgets,
    referenceAbis,
    state: new ViemSetupStateService(chain, reference, request, {
      ...(overrides.readOnly
        ? { readOnly: true as const }
        : { readOnly: false as const, privateKey: `0x${'11'.repeat(32)}` }),
      midnight,
      loanAsset,
      morphoApiBaseUrl: 'https://api.example',
      marketIds: overrides.marketIds ?? [marketId],
      referenceMarketId,
      v0OfferGroupIds: overrides.v0OfferGroupIds ?? [knownGroup],
      ignoredOfferGroupIds: overrides.ignoredGroupIds,
      readOwnedGroupIds:
        overrides.readOwnedGroupIds ?? (async () => overrides.persistedGroupIds ?? []),
      readBootstrapGroupIds: async () => overrides.bootstrapGroupIds ?? [],
      readLadderSellGroupIds: async () => overrides.ladderSellGroupIds ?? [],
      referenceLookbackBlocks: 1n,
      requestTimeoutMs: overrides.requestTimeoutMs,
      now: overrides.now
    })
  }
}

describe('ViemSetupStateService', () => {
  test('does not derive or retain a signer identity in read-only mode', async () => {
    const { state } = createState({}, { readOnly: true })

    expect(await state.getDerivedMaker()).toBeUndefined()
  })

  test.each([
    [
      'getChainId',
      'chain-id',
      'rpc',
      'chain-id',
      (state: ViemSetupStateService) => state.getChainId()
    ],
    [
      'getCode',
      'code',
      'rpc',
      'contract-code',
      (state: ViemSetupStateService) => state.getCode(ratifier)
    ],
    [
      'getNativeBalance',
      'balance',
      'rpc',
      'native-balance',
      (state: ViemSetupStateService) => state.getNativeBalance(maker)
    ],
    [
      'getLoanAllowance',
      'allowance',
      'rpc',
      'loan-allowance',
      (state: ViemSetupStateService) => state.getLoanAllowance(maker, loanAsset)
    ],
    [
      'getLatestTimestamp',
      'latest',
      'rpc',
      'latest-timestamp',
      (state: ViemSetupStateService) => state.getLatestTimestamp()
    ],
    [
      'getRatifier compound reads',
      'other-contract',
      'rpc',
      'ratifier-authorization',
      (state: ViemSetupStateService) => state.getRatifier(maker, ratifier)
    ],
    [
      'getBook compound reads',
      'request',
      'morpho-api',
      'book-api',
      (state: ViemSetupStateService) => state.getBook(marketId)
    ],
    [
      'getBook listing read',
      'market-listing',
      'morpho-api',
      'market-listing',
      (state: ViemSetupStateService) => state.getBook(marketId)
    ],
    [
      'checkReference compound reads',
      'reference',
      'archive-rpc',
      'reference-latest-block',
      (state: ViemSetupStateService) => state.checkReference()
    ],
    [
      'inspectOffers compound reads',
      'request',
      'morpho-api',
      'offer-groups',
      (state: ViemSetupStateService) => state.inspectOffers(maker)
    ]
  ])(
    'sanitizes third-party rejection at %s boundary',
    async (_name, surface, provider, operation, run) => {
      const raw = new Error(
        'provider https://reader-user:reader-pass@rpc-secret.example/private?apiKey=credential-secret',
        { cause: new Error('nested-body-secret') }
      )
      const rejectAt = async <T>(selected: string, value: T) => {
        if (surface === selected) throw raw
        return value
      }
      const chain = {
        getChainId: () => rejectAt('chain-id', 8453),
        getCode: () => rejectAt('code', authoritativeRatifierRuntime),
        getBalance: () => rejectAt('balance', 10n),
        getBlock: () => rejectAt('latest', { number: 100n, timestamp: 1_000n }),
        readContract: ({ functionName }: { functionName?: unknown }) =>
          rejectAt(
            functionName === 'allowance' ? 'allowance' : 'other-contract',
            functionName === 'allowance' ? 100n : true
          )
      }
      const reference = {
        getBlock: () => rejectAt('reference', { number: 100n, timestamp: 1_000n }),
        readContract: () => rejectAt('reference-contract', {})
      }
      const request = (url: string) =>
        url.includes('/v0/midnight/markets') && surface !== 'market-listing'
          ? Promise.resolve({ cursor: null, data: [] })
          : rejectAt(url.includes('/v0/midnight/markets') ? 'market-listing' : 'request', {
              cursor: null,
              data: []
            })
      const state = new ViemSetupStateService(chain, reference, request, {
        privateKey: `0x${'11'.repeat(32)}`,
        midnight,
        loanAsset,
        morphoApiBaseUrl: 'https://api.example',
        marketIds: [marketId],
        v0OfferGroupIds: [knownGroup],
        readOwnedGroupIds: async () => [],
        referenceMarketId,
        referenceLookbackBlocks: 1n
      })

      const error = await run(state).catch((value: unknown) => value)
      const serialized = JSON.stringify(error)

      expect(error).not.toBe(raw)
      expect(error).toBeInstanceOf(ProviderReadError)
      if (!(error instanceof ProviderReadError)) throw error
      expect(error).toEqual(
        expect.objectContaining({
          name: 'ProviderReadError',
          provider,
          operation,
          code: 'PROVIDER_READ_FAILED'
        })
      )
      expect(error.message).toBe('Provider read failed')
      expect(error).not.toHaveProperty('cause')
      for (const marker of [
        'reader-user',
        'reader-pass',
        'rpc-secret.example',
        '/private',
        'credential-secret',
        'nested-body-secret'
      ]) {
        expect(serialized).not.toContain(marker)
        expect(String(error)).not.toContain(marker)
      }
    }
  )

  test('preserves safe timeout metadata from a viem provider rejection', async () => {
    const raw = Object.assign(new Error('https://rpc.example/?key=private'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT'
    })
    const error = await executeProviderRead('rpc', 'chain-id', async () => {
      throw raw
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ProviderReadError)
    expect(error).toMatchObject({
      failure: {
        kind: 'provider-error',
        provider: 'rpc',
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        context: 'read'
      }
    })
    expect(JSON.stringify(error)).not.toContain('rpc.example')
    expect(error).not.toHaveProperty('cause')
  })

  test('preserves safe numeric JSON-RPC server metadata from a viem provider rejection', async () => {
    const raw = Object.assign(new Error('https://rpc.example/?key=private'), {
      name: 'RpcRequestError',
      code: -32_005
    })
    const error = await executeProviderRead('rpc', 'chain-id', async () => {
      throw raw
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ProviderReadError)
    expect(error).toMatchObject({
      failure: {
        kind: 'provider-error',
        provider: 'rpc',
        name: 'ProviderError',
        code: -32_005,
        context: 'read'
      }
    })
    expect(JSON.stringify(error)).not.toContain('rpc.example')
    expect(error).not.toHaveProperty('cause')
  })

  test('does not preserve ambiguous JSON-RPC internal-error metadata from a viem rejection', async () => {
    const raw = Object.assign(new Error('execution reverted: private details'), {
      name: 'InternalRpcError',
      code: -32_603
    })
    const error = await executeProviderRead('rpc', 'loan-allowance', async () => {
      throw raw
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ProviderReadError)
    expect(error).toMatchObject({
      failure: {
        kind: 'provider-error',
        provider: 'rpc',
        name: 'ProviderError',
        context: 'read'
      }
    })
    expect((error as ProviderReadError).failure).toMatchObject({
      code: 'PROVIDER_READ_FAILED'
    })
    expect(JSON.stringify(error)).not.toContain('execution reverted')
    expect(error).not.toHaveProperty('cause')
  })

  test('reports HTTP failures with a fixed provider id and no URL fields', async () => {
    const server = await startFixtureServer(() => new Response('private body', { status: 503 }))
    const secret = 'provider-api-key'

    try {
      const error = await requestJson(
        `http://localhost:${server.port}/private?apiKey=${secret}`,
        'router-api'
      ).catch(value => value)
      const serialized = JSON.stringify(error)

      expect(error).toBeInstanceOf(SafeProviderError)
      expect((error as SafeProviderError).name).toBe('SafeProviderError')
      expect(error).toMatchObject({
        failure: {
          kind: 'provider-error',
          provider: 'router-api',
          name: 'HttpError',
          status: 503
        }
      })
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('localhost')
      expect(serialized).not.toContain(String(server.port))
      expect(serialized).not.toContain('/private')
      expect(serialized).not.toContain('private body')
    } finally {
      await server.stop()
    }
  })

  test('classifies a bounded request timeout without exposing URL credentials', async () => {
    const server = await startFixtureServer(async () => {
      await sleep(100)
      return Response.json({ ok: true })
    })
    const secret = 'timeout-provider-key'

    try {
      const error = await requestJson(
        `http://localhost:${server.port}/slow?apiKey=${secret}`,
        'morpho-api',
        10
      ).catch(value => value)
      const serialized = JSON.stringify(error)

      expect(error).toMatchObject({
        failure: {
          kind: 'provider-error',
          provider: 'morpho-api',
          name: 'TimeoutError',
          code: 'REQUEST_TIMEOUT'
        }
      })
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('localhost')
      expect(serialized).not.toContain(String(server.port))
      expect(serialized).not.toContain('/slow')
    } finally {
      await server.stop()
    }
  })

  test('reads a configured book from API allowlist and on-chain state concurrently', async () => {
    const { state } = createState({
      '/v0/midnight/books': {
        cursor: null,
        data: [
          {
            market_id: marketId,
            chain_id: 8453,
            midnight,
            loan_token: loanAsset,
            maturity: 2_000,
            collaterals: [],
            rcf_threshold: '0',
            enter_gate: maker,
            liquidator_gate: maker,
            listed: true,
            asks: [],
            bids: []
          }
        ]
      }
    })

    expect(await state.getBook(marketId)).toEqual({
      id: marketId,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 4,
      maturity: 2_000n
    })
  })

  test('verifies the canonical market in the documented listed market result set', async () => {
    const { state, calls } = createState({
      '/v0/midnight/books': {
        cursor: null,
        data: [
          {
            market_id: marketId,
            chain_id: 8453,
            midnight,
            loan_token: loanAsset,
            maturity: 2_000,
            collaterals: [],
            rcf_threshold: '0',
            enter_gate: maker,
            liquidator_gate: maker,
            asks: [],
            bids: []
          }
        ]
      }
    })

    await expect(state.getBook(marketId)).resolves.toMatchObject({ allowlisted: true })
    expect(calls).toContain(
      `https://api.example/v0/midnight/markets?chain_ids=8453&market_ids=${marketId}&listed=true&limit=100`
    )
    expect(
      calls
        .filter(call => call.includes('/v0/midnight/books'))
        .every(call => !call.includes('listed='))
    ).toBe(true)
  })

  test('reports an explicitly unlisted canonical market as not allowlisted', async () => {
    const { state } = createState({
      '/v0/midnight/markets': {
        cursor: null,
        data: [{ market_id: marketId, chain_id: 8453, listed: false }]
      },
      '/v0/midnight/books': {
        cursor: null,
        data: [
          {
            market_id: marketId,
            chain_id: 8453,
            midnight,
            loan_token: loanAsset,
            maturity: 2_000,
            collaterals: [],
            rcf_threshold: '0',
            enter_gate: maker,
            liquidator_gate: maker,
            asks: [],
            bids: []
          }
        ]
      }
    })

    await expect(state.getBook(marketId)).resolves.toMatchObject({ allowlisted: false })
  })

  test('does not trust a listed filter when the result omits the requested canonical market', async () => {
    const { state } = createState({
      '/v0/midnight/markets': {
        cursor: null,
        data: [{ market_id: removedMarketId, chain_id: 8453, listed: true }]
      },
      '/v0/midnight/books': {
        cursor: null,
        data: [
          {
            market_id: marketId,
            chain_id: 8453,
            midnight,
            loan_token: loanAsset,
            maturity: 2_000,
            collaterals: [],
            rcf_threshold: '0',
            enter_gate: maker,
            liquidator_gate: maker,
            asks: [],
            bids: []
          }
        ]
      }
    })

    await expect(state.getBook(marketId)).resolves.toMatchObject({ allowlisted: false })
  })

  test('accepts only the SDK-canonical Ecrecover ratifier without calling a registry endpoint', async () => {
    const { state, calls } = createState({})

    expect(await state.getRatifier(maker, ratifier)).toEqual({
      type: 'ecrecover',
      listed: true,
      deployed: true,
      midnightMatches: true,
      surfaceMatches: true,
      authorized: true
    })
    expect(calls).toEqual([])
    expect(
      await state.getRatifier(maker, '0x4444444444444444444444444444444444444444')
    ).toMatchObject({ listed: false })
    expect(
      (await createState({}, { code: '0x' }).state.getRatifier(maker, ratifier)).deployed
    ).toBe(false)
    expect(
      (await createState({}, { ratifierMidnight: maker }).state.getRatifier(maker, ratifier))
        .midnightMatches
    ).toBe(false)
  })

  test('accepts the SDK-canonical Setter ratifier with its exact deployed interface', async () => {
    const { state } = createState({}, { code: authoritativeSetterRatifierRuntime })

    expect(await state.getRatifier(maker, setterRatifier)).toEqual({
      type: 'setter',
      listed: true,
      deployed: true,
      midnightMatches: true,
      surfaceMatches: true,
      authorized: true
    })
  })

  test.each([false, true])(
    'checks the Setter root getter without treating rootRatified=%s as deployed surface state',
    async rootRatified => {
      const { state, chainReadCalls } = createState(
        {},
        {
          code: authoritativeSetterRatifierRuntime,
          rootRatified
        }
      )

      const result = await state.getRatifier(maker, setterRatifier)

      expect(result.surfaceMatches).toBe(true)
      expect(chainReadCalls).toContainEqual({
        address: setterRatifier,
        abi: setterRatifierAbi,
        functionName: 'isRootRatified',
        args: [maker, zeroHash]
      })
    }
  )

  test('fails closed when the Setter root getter does not decode to a boolean', async () => {
    const { state } = createState(
      {},
      {
        code: authoritativeSetterRatifierRuntime,
        rootRatified: 'false'
      }
    )

    const error = await state.getRatifier(maker, setterRatifier).catch(value => value)

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect(error).toMatchObject({ provider: 'rpc', operation: 'ratifier-root' })
    expect(error.message).toBe('SetterRatifier isRootRatified response must be boolean')
  })

  test('rejects a non-canonical ratifier even when it has compatible runtime bytecode', async () => {
    const unknownRatifier: Address = '0x1111111111111111111111111111111111111111'
    const { state } = createState({}, { code: authoritativeRatifierRuntime })

    expect(await state.getRatifier(maker, unknownRatifier)).toMatchObject({
      listed: false,
      surfaceMatches: false
    })
  })

  test('rejects arbitrary getter-compatible bytecode and accepts the authoritative Base runtime', async () => {
    expect(keccak256(authoritativeRatifierRuntime)).toBe(authoritativeRatifierRuntimeHash)
    expect(
      (await createState({}, { code: '0x1234' }).state.getRatifier(maker, ratifier)).surfaceMatches
    ).toBe(false)
    expect((await createState({}).state.getRatifier(maker, ratifier)).surfaceMatches).toBe(true)
  })

  test('reports an undeployed ratifier without calling its ABI surface', async () => {
    const result = await createState(
      {},
      { code: '0x', rejectRatifierReads: true }
    ).state.getRatifier(maker, ratifier)

    expect(result).toMatchObject({
      deployed: false,
      midnightMatches: false,
      surfaceMatches: false
    })
  })

  test('proves the exact configured Blue reference market is readable at the historical block', async () => {
    const { state, calls, referenceAbis } = createState({})

    expect(await state.checkReference()).toEqual({
      marketId: referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    })
    expect(calls).toEqual([
      'latest',
      '99',
      `idToMarketParams:${referenceMarketId}:99`,
      `market:${referenceMarketId}:99`
    ])
    expect(referenceAbis).toEqual([blueAbi, blueAbi])
  })

  test('fails closed when the configured reference market has no historical state', async () => {
    const { state } = createState({}, { missingReferenceMarket: true })

    const error = await state.checkReference().catch(value => value)
    expect(error).toBeInstanceOf(ProviderResponseError)
    expect(error).toMatchObject({
      name: 'ProviderResponseError',
      provider: 'archive-rpc',
      operation: 'reference-market'
    })
    expect(error.message).toBe('configured reference market does not exist')
  })

  test('rejects a reference market for a different loan asset', async () => {
    const { state } = createState({}, { referenceLoanAsset: maker })

    const error = await state.checkReference().catch(value => value)

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect(error).toMatchObject({ provider: 'archive-rpc', operation: 'reference-loan-asset' })
  })

  test('reports fresh non-takeable active offers from every offer-group page', async () => {
    const firstOffer = { market_id: marketId, maker, buy: true, tick: 20 }
    const secondOffer = { market_id: marketId, maker, buy: false, tick: 10 }
    const { state } = createState(
      {
        'cursor=next': {
          cursor: null,
          data: [{ id: unknownGroup, chain_id: 8453, offers: [secondOffer] }]
        },
        '/v0/midnight/users/': {
          cursor: 'next',
          data: [{ id: knownGroup, chain_id: 8453, offers: [firstOffer] }]
        }
      },
      { persistedGroupIds: [unknownGroup] }
    )

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: [marketId]
    })
  })

  test('allows only the exact durably owned bootstrap-buy and ladder-sell overlap', async () => {
    const { state } = createState(
      {
        '/v0/midnight/users/': {
          cursor: null,
          data: [
            {
              id: knownGroup,
              chain_id: 8453,
              offers: [{ market_id: marketId, maker, buy: true, tick: 20 }]
            },
            {
              id: unknownGroup,
              chain_id: 8453,
              offers: [{ market_id: marketId, maker, buy: false, tick: 20 }]
            }
          ]
        }
      },
      {
        persistedGroupIds: [unknownGroup],
        bootstrapGroupIds: [knownGroup],
        ladderSellGroupIds: [unknownGroup]
      }
    )

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    })
  })

  test('reads ownership after pagination so newly published groups are recognized', async () => {
    let providerReadCompleted = false
    const { state } = createState(
      {},
      {
        onRequest: async url => {
          if (!url.includes('/v0/midnight/users/')) throw new Error('unexpected request')
          providerReadCompleted = true
          return {
            cursor: null,
            data: [
              {
                id: unknownGroup,
                chain_id: 8453,
                offers: [{ market_id: marketId, maker, buy: true, tick: 20 }]
              }
            ]
          }
        },
        readOwnedGroupIds: async () => (providerReadCompleted ? [unknownGroup] : [])
      }
    )

    expect((await state.inspectOffers(maker)).unknownNamespaces).toEqual([])
  })

  test('reads active offer groups from the Morpho API origin', async () => {
    const { state, calls } = createState({
      '/v0/midnight/users/': { cursor: null, data: [] }
    })

    await state.inspectOffers(maker)

    expect(calls).toContain(
      `https://api.example/v0/midnight/users/${maker}/offer-groups?chain_ids=8453&limit=100`
    )
    expect(calls.some(call => call.startsWith('https://router.example/v0/midnight/users/'))).toBe(
      false
    )
  })

  test('requires persisted ownership for a published same-market group across invocations', async () => {
    const publishedGroup: Hex = `0x${'ef'.repeat(32)}`
    const responses = {
      '/v0/midnight/users/': {
        cursor: null,
        data: [
          {
            id: publishedGroup,
            chain_id: 8453,
            offers: [{ market_id: marketId, maker, buy: true, tick: 20 }]
          }
        ]
      }
    }
    const { state: unknownState } = createState(responses)
    const { state: restartedState } = createState(responses, {
      persistedGroupIds: [publishedGroup]
    })

    expect(await unknownState.inspectOffers(maker)).toEqual({
      unknownNamespaces: [publishedGroup],
      unknownMarketIds: [],
      invertedMarketIds: []
    })
    expect(await restartedState.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    })
  })

  test('fails readiness for a known group that remains active on a removed market', async () => {
    const { state } = createState({
      '/v0/midnight/users/': {
        cursor: null,
        data: [
          {
            id: knownGroup,
            chain_id: 8453,
            offers: [{ market_id: removedMarketId, maker, buy: true, tick: 20 }]
          }
        ]
      }
    })

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [removedMarketId],
      invertedMarketIds: []
    })
  })

  test('ignores a canceled removed-market group while the indexer still returns its tombstone', async () => {
    const { state } = createState(
      {
        '/v0/midnight/users/': {
          cursor: null,
          data: [
            {
              id: knownGroup,
              chain_id: 8453,
              offers: [{ market_id: removedMarketId, maker, buy: true, tick: 20 }]
            }
          ]
        }
      },
      { ignoredGroupIds: [knownGroup] }
    )

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    })
  })

  test('compares mixed-case market and group IDs by canonical bytes', async () => {
    const mixedMarket: Hex = `0x${'aB'.repeat(32)}`
    const mixedGroup: Hex = `0x${'cD'.repeat(32)}`
    const canonicalMarket = bytesToHex(hexToBytes(mixedMarket))
    const canonicalGroup = bytesToHex(hexToBytes(mixedGroup))
    const { state } = createState(
      {
        '/v0/midnight/users/': {
          cursor: null,
          data: [
            {
              id: mixedGroup,
              chain_id: 8453,
              offers: [
                { market_id: mixedMarket, maker, buy: true, tick: 20 },
                { market_id: canonicalMarket, maker, buy: false, tick: 10 }
              ]
            }
          ]
        }
      },
      { marketIds: [canonicalMarket], v0OfferGroupIds: [canonicalGroup] }
    )

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: [canonicalMarket]
    })
  })

  test('fails closed when an active offer side is not boolean', async () => {
    const { state } = createState({
      '/v0/midnight/users/': {
        cursor: null,
        data: [
          {
            id: knownGroup,
            chain_id: 8453,
            offers: [{ market_id: marketId, maker, buy: 'true', tick: 20 }]
          }
        ]
      }
    })

    const error = await state.inspectOffers(maker).catch(value => value)

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect(error).toMatchObject({ provider: 'provider', operation: 'decode' })
  })

  test('fails closed at one aggregate deadline while traversing delayed unique cursors', async () => {
    let now = 0
    let page = 0
    const { state, requestBudgets } = createState(
      {},
      {
        requestTimeoutMs: 10,
        now: () => now,
        onRequest: () => {
          now += 4
          page += 1
          return { cursor: `unique-${page}`, data: [] }
        }
      }
    )

    const error = await state.inspectOffers(maker).catch(value => value)

    expect(error).toMatchObject({
      failure: {
        kind: 'provider-error',
        provider: 'morpho-api',
        name: 'TimeoutError',
        code: 'REQUEST_TIMEOUT',
        context: 'request'
      }
    })
    expect(page).toBe(3)
    expect(requestBudgets).toEqual([10, 6, 2])
  })

  test('does not start another cursor request at the exact aggregate deadline', async () => {
    let now = 5
    let page = 0
    const { state, requestBudgets } = createState(
      {},
      {
        requestTimeoutMs: 10,
        now: () => now,
        onRequest: () => {
          now = 15
          page += 1
          return { cursor: `boundary-${page}`, data: [] }
        }
      }
    )

    await expect(state.inspectOffers(maker)).rejects.toThrow('TimeoutError')
    expect(page).toBe(1)
    expect(requestBudgets).toEqual([10])
  })

  test('fails closed when Morpho API repeats an offer cursor', async () => {
    const { state } = createState(
      {
        'cursor=loop': { cursor: 'loop', data: [] },
        '/v0/midnight/users/': { cursor: 'loop', data: [] }
      },
      { requestLimit: 3 }
    )

    const error = await state.inspectOffers(maker).catch(value => value)
    expect(error).toBeInstanceOf(ProviderPaginationError)
    expect(error).toMatchObject({
      name: 'ProviderPaginationError',
      provider: 'morpho-api',
      reason: 'repeated-cursor'
    })
    expect(error.message).toBe('Morpho API cursor repeated')
  })

  test.each(['', '   ', 42])(
    'rejects malformed non-null cursor %p without early success',
    async cursor => {
      const { state } = createState({
        '/v0/midnight/users/': {
          cursor,
          data: [{ id: knownGroup, chain_id: 8453, offers: [] }]
        }
      })

      const error = await state.inspectOffers(maker).catch(value => value)
      expect(error).toBeInstanceOf(ProviderResponseError)
      expect(error).toMatchObject({ provider: 'morpho-api', operation: 'cursor' })
    }
  )

  test('ignores well-formed non-Base groups returned despite the Base filter', async () => {
    const { state } = createState({
      '/v0/midnight/users/': {
        cursor: null,
        data: [
          {
            id: unknownGroup,
            chain_id: 1,
            offers: [{ market_id: removedMarketId, maker, buy: true, tick: 20 }]
          }
        ]
      }
    })

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    })
  })

  test('fails safely when a returned offer group has malformed chain identity', async () => {
    const { state } = createState({
      '/v0/midnight/users/': {
        cursor: null,
        data: [{ id: knownGroup, chain_id: '8453', offers: [] }]
      }
    })

    const error = await state.inspectOffers(maker).catch(value => value)
    expect(error).toBeInstanceOf(ProviderResponseError)
    expect(error).toMatchObject({ provider: 'provider', operation: 'decode' })
  })

  test('fails closed when Morpho API exceeds the offer page limit with unique cursors', async () => {
    const page = (index: number) => `page-${String(index).padStart(3, '0')}`
    const responses = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `cursor=${page(index)}`,
        { cursor: index === 100 ? null : page(index + 1), data: [] }
      ])
    )
    responses['/v0/midnight/users/'] = { cursor: page(0), data: [] }

    await expect(createState(responses).state.inspectOffers(maker)).rejects.toThrow(
      'Morpho API offer page limit exceeded'
    )
  })

  test('fails closed when Morpho API returns more groups than one requested page', async () => {
    const { state } = createState({
      '/v0/midnight/users/': {
        cursor: null,
        data: Array.from({ length: 101 }, () => ({ id: knownGroup, chain_id: 8453, offers: [] }))
      }
    })

    await expect(state.inspectOffers(maker)).rejects.toThrow(
      'Morpho API offer-group page size exceeded'
    )
  })

  test('fails closed when Morpho API exceeds the offer item limit', async () => {
    const offer = {
      market_id: marketId,
      maker,
      buy: true,
      tick: 20
    }
    const { state } = createState({
      '/v0/midnight/users/': {
        cursor: null,
        data: [{ id: knownGroup, chain_id: 8453, offers: Array(100_001).fill(offer) }]
      }
    })

    await expect(state.inspectOffers(maker)).rejects.toThrow('Morpho API offer item limit exceeded')
  })
})
