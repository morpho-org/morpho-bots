import type { Address } from 'viem'

import { Offer, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { decodeLedger } from '@repo/kernel'
import { encodeLedger } from '@repo/kernel/testing'
import { midnightCommitmentId, midnightWitness } from '@repo/validators'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zeroAddress } from 'viem'
import { describe, expect, test } from 'vitest'

import { LedgerRefusedError } from '../../../src/errors'
import { readLedgerGroups } from '../../../src/infrastructure/kernel/quoter-ownership'
import { ledgerText } from '../../fixtures/kernel-ledger'

const CHAIN = 8453
const makerA: Address = '0x00000000000000000000000000000000000000aa'
const makerB: Address = '0x00000000000000000000000000000000000000bb'
const signerA: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const signerB: Address = '0x0000000000000000000000000000000000000002'
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

/** A ledger as `signer`'s kernel writes it, holding one live group of `maker`'s. */
const ledgerOf = (maker: Address, signer: Address) => {
  const offer = Offer.create({
    market,
    buy: true,
    maker,
    start: 1n,
    expiry: market.maturity,
    ratifier: getChainAddress(CHAIN, 'ecrecoverRatifier'),
    tick: 6_000n,
    maxUnits: 1_000n,
    continuousFeeCap: 0n
  } as Parameters<typeof Offer.create>[0])
  const tree = Tree.create([offer])
  const id = midnightCommitmentId(offer.group)
  const text = ledgerText(CHAIN, signer, [
    {
      spec: { id },
      state: 'live',
      intentId: 'ladder:publish:1',
      origin: { witness: midnightWitness([{ offers: tree.offers }]) }
    }
  ])
  return { group: offer.group.toLowerCase(), text }
}

/** A state directory holding `files`, removed once `run` ends. */
const withLedgers = async (
  files: Readonly<Record<string, string>>,
  run: (directory: string) => Promise<void>
) => {
  const root = await mkdtemp(join(tmpdir(), 'quoter-ledgers-'))
  try {
    const directory = join(root, 'morpho-quoter-bot')
    await mkdir(directory)
    for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text)
    await run(directory)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('readLedgerGroups', () => {
  test("reads only the configured maker's groups from a state directory two makers share", async () => {
    const a = ledgerOf(makerA, signerA)
    const b = ledgerOf(makerB, signerB)
    await withLedgers(
      {
        [`kernel-${CHAIN}-${signerA.toLowerCase()}.json`]: a.text,
        [`kernel-${CHAIN}-${signerB}.json`]: b.text
      },
      async directory => {
        const groups = await readLedgerGroups(CHAIN, makerA, directory)
        expect(groups.map(group => group.groupId)).toEqual([a.group])
      }
    )
  })

  test.each([
    [
      'an older format',
      (ledger: Record<string, unknown>) => ({
        ...ledger,
        header: { ...(ledger.header as object), format: 1 }
      }),
      signerA,
      'malformed ledger: unknown format'
    ],
    [
      'a malformed record',
      (ledger: Record<string, unknown>) => ({ ...ledger, watermarks: { a: -1 } }),
      signerA,
      'malformed ledger: malformed watermarks'
    ],
    [
      "another signer's ledger",
      (ledger: Record<string, unknown>) => ledger,
      signerB,
      'malformed ledger: bound to another chain or account'
    ]
  ])('refuses %s with the kernel reason, reading none of it', async (_, edit, signer, reason) => {
    const ledger = decodeLedger(ledgerOf(makerA, signerA).text) as unknown as Record<
      string,
      unknown
    >
    await withLedgers(
      { [`kernel-${CHAIN}-${signer.toLowerCase()}.json`]: encodeLedger(edit(ledger) as never) },
      async directory => {
        const error = await readLedgerGroups(CHAIN, makerA, directory).catch(
          (value: unknown) => value
        )
        expect(error).toBeInstanceOf(LedgerRefusedError)
        expect((error as LedgerRefusedError).reason).toBe(reason)
      }
    )
  })
})
