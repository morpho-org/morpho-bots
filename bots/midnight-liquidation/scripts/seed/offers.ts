// Offer construction + EcrecoverRatifier ratification for the position-seeding operator script.
// Ports `HashLib`, `IdLib.toId`, and `EcrecoverRatifier.isRatified`
// (docs/context/repos/midnight-contracts.txt). The non-standard EIP-712 domain (chainId +
// ratifier address only, no name/version) and the raw-root message mean we hand-roll the digest
// rather than using viem `signTypedData`. The seeding script cross-checks this against a real
// on-chain `take` (recompute the offer's digest, recover its maker) before sending anything.

import type { Address, Hex } from 'viem'

import { concat, encodeAbiParameters, encodePacked, keccak256 } from 'viem'
import { sign } from 'viem/accounts'

import type { CollateralParams, Market } from '../../src/execution/encode-call'

/** The Midnight `Offer` struct (IMidnight.sol:32-47), field order load-bearing for `hashOffer`. */
export type Offer = {
  market: Market
  buy: boolean
  maker: Address
  start: bigint
  expiry: bigint
  tick: bigint
  group: Hex
  callback: Address
  callbackData: Hex
  receiverIfMakerIsSeller: Address
  ratifier: Address
  reduceOnly: boolean
  maxUnits: bigint
  maxAssets: bigint
}

type Signature = { v: number; r: Hex; s: Hex }

// Typehashes pinned from HashLib (contracts.txt:742-746) and the height-0 OfferTree typehash
// (contracts.txt:758). EIP-712 domain typehash = keccak256("EIP712Domain(uint256 chainId,address
// verifyingContract)") (contracts.txt:383).
const COLLATERAL_PARAMS_TYPEHASH =
  '0xaf44a88eb50ebdbbebd980e5a23045c44f61ece5f80ab708a1bbe8718102e6af' as const
const MARKET_TYPEHASH =
  '0x358117e98511cc3df97175dca58053b06675b43ad090b0553f8a1eff008b6e2e' as const
const OFFER_TYPEHASH = '0x980a4cfc9766df84667f316d76e10cefc8caf04fb4cd4a9fca00a8e7b34f619c' as const
const OFFER_TREE_TYPEHASH_HEIGHT0 =
  '0x2b9ee710e1977dfc5778fe18c905ccc1d9e144baf3ba83be732d4da65ecb73e3' as const
const EIP712_DOMAIN_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const

// SSTORE2 deploy prefix (IdLib, contracts.txt:337) prepended to `abi.encode(market)` before hashing.
const SSTORE2_PREFIX = '0x600b380380600b5f395ff3' as const

const COLLATERAL_PARAMS_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'token', type: 'address' },
    { name: 'lltv', type: 'uint256' },
    { name: 'maxLif', type: 'uint256' },
    { name: 'oracle', type: 'address' }
  ]
} as const

const MARKET_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'loanToken', type: 'address' },
    { name: 'collateralParams', type: 'tuple[]', components: COLLATERAL_PARAMS_TUPLE.components },
    { name: 'maturity', type: 'uint256' },
    { name: 'rcfThreshold', type: 'uint256' },
    { name: 'enterGate', type: 'address' },
    { name: 'liquidatorGate', type: 'address' }
  ]
} as const

/** EIP-712 hashStruct of a CollateralParams (HashLib.hashCollateralParams, :810-820). */
function hashCollateralParams(cp: CollateralParams) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' }
      ],
      [COLLATERAL_PARAMS_TYPEHASH, cp.token, cp.lltv, cp.maxLif, cp.oracle]
    )
  )
}

/** EIP-712 hashStruct of a Market (HashLib.hashMarket, :823-849). */
function hashMarket(market: Market) {
  const collateralParamsHash = keccak256(concat(market.collateralParams.map(hashCollateralParams)))
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' }
      ],
      [
        MARKET_TYPEHASH,
        market.loanToken,
        collateralParamsHash,
        market.maturity,
        market.rcfThreshold,
        market.enterGate,
        market.liquidatorGate
      ]
    )
  )
}

/** EIP-712 hashStruct of an Offer (HashLib.hashOffer, :852-872) — all 14 fields, exact order. */
export function hashOffer(offer: Offer) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // OFFER_TYPEHASH
        { type: 'bytes32' }, // hashMarket(market)
        { type: 'bool' }, // buy
        { type: 'address' }, // maker
        { type: 'uint256' }, // start
        { type: 'uint256' }, // expiry
        { type: 'uint256' }, // tick
        { type: 'bytes32' }, // group
        { type: 'address' }, // callback
        { type: 'bytes32' }, // keccak256(callbackData)
        { type: 'address' }, // receiverIfMakerIsSeller
        { type: 'address' }, // ratifier
        { type: 'bool' }, // reduceOnly
        { type: 'uint256' }, // maxUnits
        { type: 'uint256' } // maxAssets
      ],
      [
        OFFER_TYPEHASH,
        hashMarket(offer.market),
        offer.buy,
        offer.maker,
        offer.start,
        offer.expiry,
        offer.tick,
        offer.group,
        offer.callback,
        keccak256(offer.callbackData),
        offer.receiverIfMakerIsSeller,
        offer.ratifier,
        offer.reduceOnly,
        offer.maxUnits,
        offer.maxAssets
      ]
    )
  )
}

/** keccak256(left ++ right) (HashLib.hashNode, :801-807). */
function hashNode(left: Hex, right: Hex) {
  return keccak256(concat([left, right]))
}

/**
 * Mirrors `HashLib.isLeaf` (:787-797): walks the proof using `leafIndex` bits to order siblings
 * (NO sorting). Used to cross-check our `hashOffer` against a real on-chain offer before spending —
 * if our hash matches the contract's, `isLeaf(realRoot, hashOffer(realOffer), idx, proof)` is true.
 */
export function isLeaf({
  root,
  leafHash,
  leafIndex,
  proof
}: {
  root: Hex
  leafHash: Hex
  leafIndex: bigint
  proof: readonly Hex[]
}) {
  let current = leafHash
  for (let i = 0; i < proof.length; i++) {
    current =
      ((leafIndex >> BigInt(i)) & 1n) === 0n
        ? hashNode(current, proof[i]!)
        : hashNode(proof[i]!, current)
  }
  return current === root
}

/** Deterministic market id (IdLib.toId, :339-345). `chainId` is the contract's INITIAL_CHAIN_ID. */
export function toId({
  market,
  chainId,
  midnight
}: {
  market: Market
  chainId: number
  midnight: Address
}) {
  const creationCodeHash = keccak256(
    concat([SSTORE2_PREFIX, encodeAbiParameters([MARKET_TUPLE], [market])])
  )
  return keccak256(
    encodePacked(
      ['uint8', 'address', 'uint256', 'bytes32'],
      [0xff, midnight, BigInt(chainId), creationCodeHash]
    )
  )
}

/**
 * Signs the EcrecoverRatifier digest for a single offer treated as its own height-0 Merkle tree
 * (root = hashOffer(offer)), reproducing `EcrecoverRatifier.isRatified` (:1042-1045). NOT viem
 * `signTypedData`: the domain has only `chainId` + `verifyingContract` and the message is a raw root.
 */
export async function signOfferTree({
  root,
  privateKey,
  ratifier,
  chainId
}: {
  root: Hex
  privateKey: Hex
  ratifier: Address
  chainId: number
}): Promise<Signature> {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [OFFER_TREE_TYPEHASH_HEIGHT0, root]
    )
  )
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [EIP712_DOMAIN_TYPEHASH, BigInt(chainId), ratifier]
    )
  )
  const digest = keccak256(concat(['0x1901', domainSeparator, structHash]))
  const sig = await sign({ hash: digest, privateKey })
  const v = sig.v !== undefined ? Number(sig.v) : (sig.yParity ?? 0) + 27
  return { v, r: sig.r, s: sig.s }
}

/** ABI-encodes `(Signature, bytes32 root, uint256 leafIndex, bytes32[] proof)` for `take`'s ratifierData. */
export function encodeRatifierData({
  signature,
  root,
  leafIndex,
  proof
}: {
  signature: Signature
  root: Hex
  leafIndex: bigint
  proof: readonly Hex[]
}) {
  return encodeAbiParameters(
    [
      { type: 'tuple', components: [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }] },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'bytes32[]' }
    ],
    [[signature.v, signature.r, signature.s], root, leafIndex, [...proof]]
  )
}
