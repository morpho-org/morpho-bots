// Offer construction + EcrecoverRatifier ratification for the position-seeding operator script.
// Ports `HashLib`, `IdLib.toId`, and `EcrecoverRatifier.isRatified`
// (morpho-org/midnight @ 336b924a — the version deployed on Base as 0xAdedD8ab…). The non-standard
// EIP-712 domain (chainId + ratifier address only, no name/version) and the raw-root message mean we
// hand-roll the digest rather than using viem `signTypedData`. The seeding script cross-checks this
// against a real on-chain `take` (recompute the offer's digest, recover its maker) before sending
// anything.

import type { Address, Hex } from 'viem';
import { concat, encodeAbiParameters, encodePacked, keccak256 } from 'viem';
import { sign } from 'viem/accounts';

import type { CollateralParams, Market } from '../../src/execution/encode-call';

/** The Midnight `Offer` struct (IMidnight.sol @ 336b924a), field order load-bearing for `hashOffer`. */
export type Offer = {
  market: Market;
  buy: boolean;
  maker: Address;
  start: bigint;
  expiry: bigint;
  tick: bigint;
  group: Hex;
  callback: Address;
  callbackData: Hex;
  receiverIfMakerIsSeller: Address;
  ratifier: Address;
  reduceOnly: boolean;
  maxUnits: bigint;
  maxAssets: bigint;
  continuousFeeCap: bigint;
};

type Signature = { v: number; r: Hex; s: Hex };

// Typehashes pinned from HashLib @ morpho-org/midnight 336b924a (the deployed commit; COLLATERAL_PARAMS
// /MARKET/OFFER typehash constants + the height-0 OfferTree typehash from HashLib.offerTreeTypeHash(0)).
// COLLATERAL_PARAMS/MARKET are unchanged from 3836155f (those structs did not change); OFFER and the
// OfferTree height-0 typehash changed because this deployment narrowed Offer.maxUnits/maxAssets to
// uint128. EIP-712 domain typehash = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)").
export const COLLATERAL_PARAMS_TYPEHASH =
  '0x39ed3f928d24fd00574b1a02aba9c2483abcf5d9a3a366118c9a5aa29885b841' as const;
export const MARKET_TYPEHASH =
  '0x510b3862f3816a109c9340b76972e8a30984246be06e034ae12ed2934220391a' as const;
export const OFFER_TYPEHASH =
  '0x9905214264a9fb7b6cc1b0e33db7a04687c6e4185a84755d29914314aa9d8906' as const;
export const OFFER_TREE_TYPEHASH_HEIGHT0 =
  '0x270da1ebafc0f24637af3612fb8c3a1d828fcb56d3637c24e86dd006b12ca7f9' as const;
const EIP712_DOMAIN_TYPEHASH =
  '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const;

// SSTORE2 deploy prefix (IdLib.SSTORE2_PREFIX @ 3836155f) prepended to `abi.encode(market)` before hashing.
const SSTORE2_PREFIX = '0x600b380380600b5f395ff3' as const;

const COLLATERAL_PARAMS_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'token', type: 'address' },
    { name: 'lltv', type: 'uint256' },
    { name: 'liquidationCursor', type: 'uint256' },
    { name: 'oracle', type: 'address' }
  ]
} as const;

const MARKET_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'chainId', type: 'uint256' },
    { name: 'midnight', type: 'address' },
    { name: 'loanToken', type: 'address' },
    { name: 'collateralParams', type: 'tuple[]', components: COLLATERAL_PARAMS_TUPLE.components },
    { name: 'maturity', type: 'uint256' },
    { name: 'rcfThreshold', type: 'uint256' },
    { name: 'enterGate', type: 'address' },
    { name: 'liquidatorGate', type: 'address' }
  ]
} as const;

/** EIP-712 hashStruct of a CollateralParams (HashLib.hashCollateralParams @ 3836155f). */
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
      [COLLATERAL_PARAMS_TYPEHASH, cp.token, cp.lltv, cp.liquidationCursor, cp.oracle]
    )
  );
}

/** EIP-712 hashStruct of a Market (HashLib.hashMarket @ 3836155f). */
function hashMarket(market: Market) {
  const collateralParamsHash = keccak256(concat(market.collateralParams.map(hashCollateralParams)));
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' }, // MARKET_TYPEHASH
        { type: 'uint256' }, // chainId
        { type: 'address' }, // midnight
        { type: 'address' }, // loanToken
        { type: 'bytes32' }, // hashed collateralParams
        { type: 'uint256' }, // maturity
        { type: 'uint256' }, // rcfThreshold
        { type: 'address' }, // enterGate
        { type: 'address' } // liquidatorGate
      ],
      [
        MARKET_TYPEHASH,
        market.chainId,
        market.midnight,
        market.loanToken,
        collateralParamsHash,
        market.maturity,
        market.rcfThreshold,
        market.enterGate,
        market.liquidatorGate
      ]
    )
  );
}

/** EIP-712 hashStruct of an Offer (HashLib.hashOffer @ 3836155f) — all 15 fields, exact order. */
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
        { type: 'uint128' }, // maxUnits
        { type: 'uint128' }, // maxAssets
        { type: 'uint256' } // continuousFeeCap
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
        offer.maxAssets,
        offer.continuousFeeCap
      ]
    )
  );
}

/** keccak256(left ++ right) (HashLib.hashNode, :801-807). */
function hashNode(left: Hex, right: Hex) {
  return keccak256(concat([left, right]));
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
  root: Hex;
  leafHash: Hex;
  leafIndex: bigint;
  proof: readonly Hex[];
}) {
  let current = leafHash;
  for (let i = 0; i < proof.length; i++) {
    current =
      ((leafIndex >> BigInt(i)) & 1n) === 0n
        ? hashNode(current, proof[i]!)
        : hashNode(proof[i]!, current);
  }
  return current === root;
}

/**
 * Deterministic market id (IdLib.toId @ 3836155f): CREATE2 address of the market's SSTORE2 creation
 * code, with deployer = `market.midnight` and a fixed salt of 0. (The prior version salted with the
 * chainId; the current one folds chain identity into the hashed `Market.chainId` field instead.)
 */
export function toId(market: Market) {
  const creationCodeHash = keccak256(
    concat([SSTORE2_PREFIX, encodeAbiParameters([MARKET_TUPLE], [market])])
  );
  return keccak256(
    encodePacked(
      ['uint8', 'address', 'uint256', 'bytes32'],
      [0xff, market.midnight, 0n, creationCodeHash]
    )
  );
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
  root: Hex;
  privateKey: Hex;
  ratifier: Address;
  chainId: number;
}): Promise<Signature> {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [OFFER_TREE_TYPEHASH_HEIGHT0, root]
    )
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [EIP712_DOMAIN_TYPEHASH, BigInt(chainId), ratifier]
    )
  );
  const digest = keccak256(concat(['0x1901', domainSeparator, structHash]));
  const sig = await sign({ hash: digest, privateKey });
  const v = sig.v !== undefined ? Number(sig.v) : (sig.yParity ?? 0) + 27;
  return { v, r: sig.r, s: sig.s };
}

/** ABI-encodes `(Signature, bytes32 root, uint256 leafIndex, bytes32[] proof)` for `take`'s ratifierData. */
export function encodeRatifierData({
  signature,
  root,
  leafIndex,
  proof
}: {
  signature: Signature;
  root: Hex;
  leafIndex: bigint;
  proof: readonly Hex[];
}) {
  return encodeAbiParameters(
    [
      { type: 'tuple', components: [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }] },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'bytes32[]' }
    ],
    [[signature.v, signature.r, signature.s], root, leafIndex, [...proof]]
  );
}
