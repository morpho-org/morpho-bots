import type { Command, KernelActivity, KernelEvent, KernelState } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import {
  EcrecoverRatifierUtils,
  MarketUtils,
  midnightAbi,
  Offer,
  setterRatifierAbi,
  Tree
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { createKernel } from '@repo/kernel'
import { FakeChain, MemoryStore, startKernel } from '@repo/kernel/testing'
import { NONCE_FILL_MAX_GAS } from '@repo/kit'
import {
  midnightCancellation as cancellation,
  midnightCommitmentId,
  midnightPublicationPlan as publicationPlan
} from '@repo/validators'
import {
  encodeFunctionData,
  hashMessage,
  recoverAddress,
  toFunctionSelector,
  zeroAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { MonitoringEvent } from '../src/application/monitoring/monitoring-event'

import { ConfigService } from '../src/config/config.service'
import {
  createKernelLog,
  createSignerAccount,
  dryHosting,
  quoterKernelConfig,
  quoterKernelSpec
} from '../src/kernel'

const CHAIN = 8453
// Anvil's published development key: a throwaway maker that never holds funds.
const maker = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
)
const market = {
  chainId: BigInt(CHAIN),
  midnight: getChainAddress(CHAIN, 'midnight'),
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  collateralParams: [
    {
      token: '0x4200000000000000000000000000000000000006' as Address,
      lltv: 770_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000' as Address
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const marketId = MarketUtils.toId(market)
const NOW = BigInt(Date.UTC(2026, 9, 3) / 1000)

const environment = (ratifier: 'ecrecoverRatifier' | 'setterRatifier') => ({
  CHAIN_ID: String(CHAIN),
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker.address,
  MAKER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  MIDNIGHT_ADDRESS: getChainAddress(CHAIN, 'midnight'),
  LOAN_ASSET_ADDRESS: market.loanToken,
  RATIFIER_ADDRESS: getChainAddress(CHAIN, ratifier),
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: marketId,
  NATIVE_RESERVE_WEI: '10',
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MAX_RATIFICATION_GAS: '100000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolling',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
})

const offer = (ratifier: Address, buy: boolean) =>
  Offer.create({
    market,
    buy,
    maker: maker.address,
    start: NOW,
    expiry: market.maturity,
    ratifier,
    tick: 6_000n,
    maxUnits: 1_000_000n,
    continuousFeeCap: 0n,
    ...(buy ? {} : { reduceOnly: true, receiverIfMakerIsSeller: maker.address })
  } as Parameters<typeof Offer.create>[0])

/** Drives the real kernel and validator to `running`, as the driver would at start. */
const runningKernel = (config: ConfigService) => {
  const kernel = createKernel(quoterKernelConfig(config, maker.address))
  let state: KernelState = kernel.initialState()
  const commands: Command[] = []
  const send = (event: KernelEvent) => {
    const result = kernel.reduce(state, event)
    state = result.state
    commands.push(...result.commands)
    return result.commands
  }
  const now = Number(NOW) * 1_000
  send({ type: 'Start', ledger: null, enrollment: 'enrolling', now, accountCode: '0x' })
  const block = { number: 10, hash: `0x${'0a'.repeat(32)}`, timestamp: NOW }
  send({ type: 'Head', ...block, finalized: 8, finalizedTimestamp: NOW })
  send({ type: 'NonceAt', block: 10, blockHash: block.hash, latest: 0, pending: 0, safe: 0 })
  for (const command of commands.filter(command => command.type === 'flush'))
    send({ type: 'Flushed', seq: command.seq })
  expect(state.lifecycle.kind).toBe('running')
  return { send, state: () => state, now, block }
}

const notices = (commands: readonly Command[]) =>
  commands.flatMap(command => (command.type === 'notify' ? [command.notice] : []))

const submit = (
  harness: ReturnType<typeof runningKernel>,
  intentId: string,
  steps: Parameters<typeof publicationPlan>[0] extends never ? never : unknown
) =>
  harness.send({
    type: 'Submit',
    plan: {
      intentId,
      steps: steps as never,
      notAfter: harness.now + 60_000,
      basisBlock: harness.block.number
    }
  })

describe('quoter kernel reorg window', () => {
  test.each([
    [8453, 3_000],
    [1, 128]
  ])('retains ten minutes with a 128-block minimum for chain %i', (chainId, depth) => {
    const config = ConfigService.from({
      ...environment('ecrecoverRatifier'),
      CHAIN_ID: String(chainId),
      MIDNIGHT_ADDRESS: getChainAddress(chainId, 'midnight'),
      RATIFIER_ADDRESS: getChainAddress(chainId, 'ecrecoverRatifier')
    })
    expect(quoterKernelSpec({ config, account: maker }).hosting.reorgDepth).toBe(depth)
    expect(dryHosting(config).reorgDepth).toBe(depth)
  })

  test.each([
    [
      8453,
      {
        maxSimLagBlocks: 30,
        maxEvidenceAgeBlocks: 1_200,
        stuckBlocks: 100,
        latchBoundBlocks: 1_000
      }
    ],
    [1, { maxSimLagBlocks: 3, maxEvidenceAgeBlocks: 128, stuckBlocks: 10, latchBoundBlocks: 100 }]
  ])('converts each kernel window from a time for chain %i', (chainId, windows) => {
    const config = ConfigService.from({
      ...environment('ecrecoverRatifier'),
      CHAIN_ID: String(chainId),
      MIDNIGHT_ADDRESS: getChainAddress(chainId, 'midnight'),
      RATIFIER_ADDRESS: getChainAddress(chainId, 'ecrecoverRatifier')
    })
    expect(quoterKernelConfig(config, maker.address)).toMatchObject(windows)
  })

  test.each([132, 154, 2_999, 3_000, 3_001])(
    'keeps the startup refusal boundary at lag %i',
    async lag => {
      const config = ConfigService.from(environment('ecrecoverRatifier'))
      const hosting = quoterKernelSpec({ config, account: maker }).hosting
      const chain = new FakeChain()
      chain.height = 5_000
      chain.finalityLag = lag
      const { runner, nodes, stopped } = await startKernel({
        ...hosting,
        chain,
        store: new MemoryStore(),
        effects: chain.effects,
        now: () => 0
      })
      try {
        if (lag >= hosting.reorgDepth) {
          await expect(stopped).resolves.toMatchObject({
            outcome: 'refused',
            reason: `the finalized block lags the head by ${lag} blocks, past the 3000-block reorg window`
          })
        } else {
          await vi.waitFor(() => expect(runner.read(nodes.state)?.lifecycle.kind).toBe('running'))
          expect(runner.read(nodes.state)?.finalized.number).toBe(chain.height - lag)
        }
      } finally {
        await runner.abandon()
      }
    }
  )
})

describe('quoter kernel plans', () => {
  test('signs an Ecrecover ratification, then publishes through the validator to simulation', async () => {
    const config = ConfigService.from(environment('ecrecoverRatifier'))
    const tree = Tree.create([offer(getChainAddress(CHAIN, 'ecrecoverRatifier'), false)])
    const plan = publicationPlan({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      tree,
      ratifier: 'ecrecover'
    })
    const harness = runningKernel(config)

    const admitted = submit(harness, 'ladder:publish', plan.steps)
    expect(notices(admitted)).toEqual(['admitted'])
    const sign = admitted.find(command => command.type === 'sign')
    if (sign?.type !== 'sign' || sign.payload.kind !== 'typed')
      throw new Error('expected a typed signature')

    const signature = await maker.signTypedData(
      EcrecoverRatifierUtils.typedData({ tree, chainId: CHAIN }) as never
    )
    const afterSign = harness.send({ type: 'Signed', request: sign.request, signature })
    const materialize = afterSign.find(command => command.type === 'materialize')
    if (materialize?.type !== 'materialize') throw new Error('expected the publication to be built')

    const built = await plan.materialize(materialize, new AbortController().signal)
    const afterBuild = harness.send({
      type: 'Materialized',
      request: materialize.request,
      ...built
    })
    expect(notices(afterBuild)).toEqual([])
    expect(afterBuild.map(command => command.type)).toContain('simulate')
    expect(harness.state().entries[midnightCommitmentId(tree.offers[0]!.group)]?.state).toBe(
      'signed'
    )
  })

  test('ratifies a Setter root, then validates the exact publication before building it', async () => {
    const config = ConfigService.from(environment('setterRatifier'))
    const tree = Tree.create([offer(getChainAddress(CHAIN, 'setterRatifier'), false)])
    const validated: Hex[] = []
    const plan = publicationPlan({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      tree,
      ratifier: 'setter',
      validate: async publication => void validated.push(publication)
    })
    const harness = runningKernel(config)

    const admitted = submit(harness, 'bootstrap:publish', plan.steps)
    expect(notices(admitted)).toEqual(['admitted'])
    expect(admitted.map(command => command.type)).toContain('simulate')

    const built = await plan.materialize(
      { type: 'materialize', request: 0, intentId: 'bootstrap:publish', step: 1, signatures: [] },
      new AbortController().signal
    )
    expect(validated).toEqual([built.payload.kind === 'tx' ? built.payload.data : undefined])
  })

  test('refuses a buy beyond the configured loan cap, and a cancel of a group it does not hold', () => {
    const config = ConfigService.from(environment('ecrecoverRatifier'))
    const tree = Tree.create([offer(getChainAddress(CHAIN, 'ecrecoverRatifier'), true)])
    const harness = runningKernel(config)
    const plan = publicationPlan({
      chainId: CHAIN,
      maker: maker.address,
      signer: maker.address,
      tree,
      ratifier: 'ecrecover'
    })
    expect(notices(submit(harness, 'ladder:buy', plan.steps))).toEqual(['refused'])

    const foreign: Hex = `0x${'99'.repeat(32)}`
    expect(
      notices(
        submit(harness, 'invalidation:cancel', [
          { kind: 'tx', payload: cancellation(CHAIN, maker.address, [foreign]) }
        ])
      )
    ).toEqual(['refused'])
  })

  test('bounds the kernel from configuration alone', () => {
    const config = ConfigService.from(environment('ecrecoverRatifier'))
    const kernelConfig = quoterKernelConfig(config, maker.address)
    expect(kernelConfig.account).toBe(maker.address)
    expect(kernelConfig.feeReserve).toBe(config.writePolicy!.maxTransactionSpendWei)
    expect(kernelConfig.caps).toEqual({
      [`loan:${market.loanToken.toLowerCase()}`]: 2n * config.setup.requiredAllowance,
      native: 16n * config.writePolicy!.maxTransactionSpendWei
    })
    expect(kernelConfig.policy.recoveryTargets).toEqual([getChainAddress(CHAIN, 'midnight')])
    expect(cancellation(CHAIN, maker.address, [`0x${'11'.repeat(32)}`]).to).toBe(
      kernelConfig.policy.recoveryTargets[0]
    )
  })
})

/** Answers the signer's RPC reads, estimating `gas` for every transaction. */
const stubRpc = (gas: bigint) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const { id, method } = JSON.parse(init.body) as { id: number; method: string }
      const results: Record<string, unknown> = {
        eth_chainId: `0x${CHAIN.toString(16)}`,
        eth_estimateGas: `0x${gas.toString(16)}`,
        eth_getBlockByNumber: {
          number: '0xa',
          hash: `0x${'0a'.repeat(32)}`,
          parentHash: `0x${'09'.repeat(32)}`,
          timestamp: `0x${NOW.toString(16)}`,
          baseFeePerGas: '0x3b9aca00',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          transactions: []
        }
      }
      if (method === 'eth_fillTransaction')
        return Response.json({ jsonrpc: '2.0', id, error: { code: -32_601, message: 'not found' } })
      if (!(method in results)) throw new Error(`unexpected RPC ${method}`)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] }))
    })
  )

const signTx = (
  config: ConfigService,
  to: Address,
  data: Hex,
  writeEvent?: (event: MonitoringEvent) => void
) =>
  quoterKernelSpec({
    config,
    account: maker,
    ...(writeEvent && { writeEvent })
  }).hosting.effects.signTx(
    { kind: 'tx', to, data, value: 0n },
    { nonce: 0, level: 1, kind: 'step', fee: 10n ** 17n, recoveryFee: 10n ** 17n },
    { signal: new AbortController().signal, mayAct: () => true }
  )

const setConsumed = encodeFunctionData({
  abi: midnightAbi,
  functionName: 'setConsumed',
  args: [`0x${'11'.repeat(32)}`, 1n, maker.address]
})

describe('quoter signing policy', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Distinct per-operation calldata caps, so a rule that reads another operation's cap fails.
  const setter = () =>
    ConfigService.from({
      ...environment('setterRatifier'),
      MAX_PUBLICATION_DATA_BYTES: '4096',
      MAX_BATCH_CANCELLATION_DATA_BYTES: '2048'
    })
  const midnight = getChainAddress(CHAIN, 'midnight')

  test('signs a cancellation within its own gas and calldata ceilings', async () => {
    stubRpc(100_000n)
    await expect(signTx(setter(), midnight, setConsumed)).resolves.toMatchObject({
      hash: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    })
  })

  test('signs the kernel nonce fill, and refuses one above its gas bound', async () => {
    stubRpc(21_000n)
    await expect(signTx(setter(), maker.address, '0x')).resolves.toMatchObject({
      hash: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    })
    stubRpc(NONCE_FILL_MAX_GAS + 1n)
    const events: MonitoringEvent[] = []
    await expect(
      signTx(setter(), maker.address, '0x', event => events.push(event))
    ).rejects.toMatchObject({ name: 'PolicyViolationError', check: 'gas' })
    expect(events).toEqual([
      {
        event: 'signer.policy_violation',
        check: 'gas',
        reason: expect.any(String),
        to: maker.address,
        nonce: 0
      }
    ])
  })

  /** Calldata of exactly `bytes` bytes, led by `selector` when the operation has one. */
  const sized = (bytes: number, selector = '0x') =>
    `${selector}${'01'.repeat(bytes - (selector.length - 2) / 2)}` as Hex
  const multicall = toFunctionSelector('multicall(bytes[])')
  const ratify = toFunctionSelector('setIsRootRatified(address,bytes32,bool)')
  const mempool = () => getChainAddress(CHAIN, 'midnightMempool')
  const setterRatifier = () => getChainAddress(CHAIN, 'setterRatifier')

  test.each([
    { name: 'a batch cancellation', to: () => midnight, bytes: 2048, selector: multicall },
    { name: 'a publication', to: mempool, bytes: 4096, selector: '0x' },
    { name: 'a ratification', to: setterRatifier, bytes: 100, selector: ratify }
  ])('signs $name at exactly its own calldata cap', async ({ to, bytes, selector }) => {
    stubRpc(50_000n)
    await expect(signTx(setter(), to(), sized(bytes, selector))).resolves.toMatchObject({
      hash: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    })
  })

  test.each([
    {
      name: 'a batch cancellation one byte over its own cap, though under the publication cap',
      to: () => midnight,
      bytes: 2049,
      selector: multicall
    },
    { name: 'a publication one byte over its cap', to: mempool, bytes: 4097, selector: '0x' },
    {
      name: 'a ratification one byte over its cap',
      to: setterRatifier,
      bytes: 101,
      selector: ratify
    }
  ])('refuses to sign $name', async ({ to, bytes, selector }) => {
    stubRpc(50_000n)
    await expect(signTx(setter(), to(), sized(bytes, selector))).rejects.toMatchObject({
      name: 'PolicyViolationError',
      check: 'maxDataBytes'
    })
  })

  test.each([
    {
      name: 'a cancellation above MAX_CANCELLATION_GAS',
      gas: 100_001n,
      to: () => midnight,
      data: setConsumed,
      check: 'gas'
    },
    {
      name: 'a cancellation carrying more calldata than one call',
      gas: 50_000n,
      to: () => midnight,
      data: `${setConsumed}${'00'.repeat(32)}` as Hex,
      check: 'maxDataBytes'
    },
    {
      name: 'a batch cancellation above MAX_BATCH_CANCELLATION_GAS',
      gas: 1_000_001n,
      to: () => midnight,
      data: encodeFunctionData({ abi: midnightAbi, functionName: 'multicall', args: [[]] }),
      check: 'gas'
    },
    {
      name: 'a Midnight call no rule names',
      gas: 50_000n,
      to: () => midnight,
      data: '0xdeadbeef' as Hex,
      check: 'selector'
    },
    {
      name: 'a publication above MAX_PUBLICATION_GAS',
      gas: 5_000_001n,
      to: () => getChainAddress(CHAIN, 'midnightMempool'),
      data: '0x01' as Hex,
      check: 'gas'
    },
    {
      name: 'a ratification above MAX_RATIFICATION_GAS',
      gas: 100_001n,
      to: () => getChainAddress(CHAIN, 'setterRatifier'),
      data: encodeFunctionData({
        abi: setterRatifierAbi,
        functionName: 'setIsRootRatified',
        args: [maker.address, `0x${'22'.repeat(32)}`, true]
      }),
      check: 'gas'
    },
    {
      name: 'a nonce fill carrying calldata',
      gas: 21_000n,
      to: () => maker.address,
      data: '0x00' as Hex,
      check: 'maxDataBytes'
    },
    {
      name: 'a target outside the configured contracts',
      gas: 21_000n,
      to: () => market.loanToken,
      data: '0x' as Hex,
      check: 'target'
    }
  ])('refuses to sign $name', async ({ gas, to, data, check }) => {
    stubRpc(gas)
    await expect(signTx(setter(), to(), data)).rejects.toMatchObject({
      name: 'PolicyViolationError',
      check
    })
  })
})

describe('quoter kernel identity', () => {
  test('refuses a local signer that is not the maker', () => {
    const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const config = ConfigService.from(environment('setterRatifier'))
    expect(() => quoterKernelSpec({ config, account: stranger })).toThrow(
      expect.objectContaining({ operation: 'signer-identity-mismatch' })
    )
  })

  test('refuses a KMS signer that is the maker itself, and accepts a delegate', () => {
    const config = ConfigService.from({
      ...environment('ecrecoverRatifier'),
      MAKER_PRIVATE_KEY: undefined,
      MAX_RATIFICATION_GAS: undefined,
      KEY_STORAGE_METHOD: 'aws',
      AWS_KMS_KEY_ID: 'alias/quoter',
      AWS_REGION: 'eu-west-1',
      SIGNER_NATIVE_RESERVE_WEI: '10'
    })
    expect(() => quoterKernelSpec({ config, account: maker })).toThrow(
      expect.objectContaining({ operation: 'signer-identity-mismatch' })
    )
    const delegate = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    expect(quoterKernelSpec({ config, account: delegate }).signer).toBe(delegate.address)
  })

  test('refuses a read-only configuration', () => {
    const config = ConfigService.from(environment('setterRatifier'), { readOnly: true })
    expect(() => quoterKernelSpec({ config, account: maker })).toThrow(
      expect.objectContaining({ operation: 'configuration' })
    )
  })
})

describe('quoter signer account', () => {
  const privateKey = `0x${'11'.repeat(32)}` as const
  const keyMaker = privateKeyToAccount(privateKey)
  const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`).address

  test('creates the legacy local private-key signer', async () => {
    const account = await createSignerAccount({
      readOnly: false,
      maker: keyMaker.address,
      method: 'private-key',
      privateKey
    })
    expect(account.address).toBe(keyMaker.address)
    expect(
      await recoverAddress({
        hash: hashMessage('legacy'),
        signature: await account.signMessage({ message: 'legacy' })
      })
    ).toBe(keyMaker.address)
  })

  test('rejects a local private key that does not derive the configured maker', async () => {
    await expect(
      createSignerAccount({ readOnly: false, maker: stranger, method: 'private-key', privateKey })
    ).rejects.toMatchObject({ operation: 'signer-address' })
  })

  test('rejects a decrypted keystore that does not derive the configured maker', async () => {
    await expect(
      createSignerAccount(
        {
          readOnly: false,
          maker: stranger,
          method: 'keystore',
          path: '/secure/maker.json',
          password: 'not-reported'
        },
        { readFile: async () => '{}', decryptKeystore: async () => privateKey }
      )
    ).rejects.toMatchObject({ operation: 'signer-address' })
  })

  test('rejects an AWS KMS key that derives the funded maker', async () => {
    const spki = Uint8Array.from([
      ...Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      ...Buffer.from(keyMaker.publicKey.slice(2), 'hex')
    ])

    await expect(
      createSignerAccount(
        {
          readOnly: false,
          maker: keyMaker.address,
          method: 'aws',
          keyId: 'alias/quoter',
          region: 'eu-west-1'
        },
        { kms: { getPublicKey: async () => spki, signDigest: async () => new Uint8Array() } }
      )
    ).rejects.toMatchObject({ operation: 'signer-address' })
  })
})

describe('quoter kernel log', () => {
  test('writes one record per resolved winner when nonces resolve and prune in one transition', () => {
    const events: MonitoringEvent[] = []
    const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
    const resolved = (nonce: number, success: boolean): KernelActivity[] => [
      {
        type: 'resolved',
        nonce,
        block: 10,
        blockHash: hash(10),
        winner: hash(nonce),
        success,
        confirmed: success
      },
      { type: 'final', nonce, hashes: [hash(nonce)] }
    ]

    createKernelLog(event => void events.push(event))([...resolved(7, true), ...resolved(8, false)])

    expect(events).toHaveLength(2)
  })
})
