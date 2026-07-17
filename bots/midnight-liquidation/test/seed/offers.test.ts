// Guards the EIP-712 typehashes that scripts/seed/offers.ts pins from HashLib @ morpho-org/midnight
// 336b924a. These constants are the crux of the deployment migration: when the on-chain Offer struct
// changed (maxUnits/maxAssets uint256 -> uint128) the OFFER and OfferTree typehashes changed, and a
// stale constant here would silently produce offers no ratifier accepts. Recomputing each hash from its
// canonical EIP-712 type string catches any future struct drift the same way this migration required.

import type { Address, Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { keccak256, toHex, zeroAddress } from 'viem'

import type { Offer } from '../../scripts/seed/offers'
import type { CollateralParams, Market } from '../../src/execution/encode-call'

import {
  COLLATERAL_PARAMS_TYPEHASH,
  hashOffer,
  MARKET_TYPEHASH,
  OFFER_TREE_TYPEHASH_HEIGHT0,
  OFFER_TYPEHASH,
  toId
} from '../../scripts/seed/offers'

// Canonical EIP-712 encodeType strings (referenced structs appended, per HashLib's bytes.concat order).
const CP_TYPE =
  'CollateralParams(address token,uint256 lltv,uint256 liquidationCursor,address oracle)'
const MARKET_TYPE =
  'Market(uint256 chainId,address midnight,address loanToken,CollateralParams[] collateralParams,uint256 maturity,uint256 rcfThreshold,address enterGate,address liquidatorGate)'
const OFFER_TYPE =
  'Offer(Market market,bool buy,address maker,uint256 start,uint256 expiry,uint256 tick,bytes32 group,address callback,bytes callbackData,address receiverIfMakerIsSeller,address ratifier,bool reduceOnly,uint128 maxUnits,uint128 maxAssets,uint256 continuousFeeCap)'
const OFFER_TREE_TYPE_HEIGHT0 = 'OfferTree(Offer offerTree)'

const hashType = (s: string): Hex => keccak256(toHex(s))

const MIDNIGHT = '0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A' as Address

function market(midnight: Address = MIDNIGHT): Market {
  return {
    chainId: 8453n,
    midnight,
    loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    collateralParams: [
      {
        token: '0x4200000000000000000000000000000000000006' as Address,
        lltv: 860000000000000000n,
        liquidationCursor: 250000000000000000n,
        oracle: '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4' as Address
      } satisfies CollateralParams
    ],
    maturity: 1_800_000_000n,
    rcfThreshold: 10n ** 30n,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  }
}

function offer(maxUnits: bigint): Offer {
  return {
    market: market(),
    buy: true,
    maker: '0x1111111111111111111111111111111111111111' as Address,
    start: 1_799_999_700n,
    expiry: 1_800_604_800n,
    tick: 12n,
    group: `0x${'00'.repeat(32)}`,
    callback: zeroAddress,
    callbackData: '0x',
    receiverIfMakerIsSeller: zeroAddress,
    ratifier: '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E' as Address,
    reduceOnly: false,
    maxUnits,
    maxAssets: 0n,
    continuousFeeCap: 4294967295n
  }
}

describe('seed/offers typehashes (HashLib @ 336b924a)', () => {
  it('CollateralParams and Market typehashes match their EIP-712 type strings', () => {
    // hashType (generic `Hex`) is the receiver so the pinned literal-typed constant is the expectation.
    expect(hashType(CP_TYPE)).toBe(COLLATERAL_PARAMS_TYPEHASH)
    // Market references CollateralParams: keccak256(MARKET_TYPE ++ COLLATERAL_PARAMS_TYPE).
    expect(hashType(MARKET_TYPE + CP_TYPE)).toBe(MARKET_TYPEHASH)
  })

  it('OFFER_TYPEHASH matches keccak256(OFFER_TYPE ++ COLLATERAL_PARAMS_TYPE ++ MARKET_TYPE)', () => {
    // uint128 maxUnits/maxAssets — the 336b924a narrowing. A uint256 here would reproduce the old
    // 0x2F7a… deployment's typehash and break ratification on the new contract.
    expect(hashType(OFFER_TYPE + CP_TYPE + MARKET_TYPE)).toBe(OFFER_TYPEHASH)
  })

  it('OfferTree height-0 typehash matches its EIP-712 type string', () => {
    expect(hashType(OFFER_TREE_TYPE_HEIGHT0 + CP_TYPE + MARKET_TYPE + OFFER_TYPE)).toBe(
      OFFER_TREE_TYPEHASH_HEIGHT0
    )
  })

  it('hashOffer changes when maxUnits changes', () => {
    expect(hashOffer(offer(1000n))).not.toBe(hashOffer(offer(1001n)))
  })

  it('toId changes when the Midnight address changes', () => {
    expect(toId(market())).not.toBe(toId(market('0x2F7a3AA739ba5792Ce1b4eA046117f2C0095BCA6')))
  })
})
