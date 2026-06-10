import type { Address, Client, Hex, Transport } from 'viem'

import { sol } from 'soltag'
import { decodeAbiParameters, encodeAbiParameters } from 'viem'

import type { Market } from '../execution/encode-call'
import type { BatchLensTransportType } from './read-deployless-batch-lens'

import { MAX_INITCODE_SIZE, readDeploylessBatchLens } from './read-deployless-batch-lens'

// Single-file soltag lens: reads everything the liquidation decision depends on for a batch of
// (id, borrower) pairs inside one eth_call against a single block.timestamp. Reads the full Market
// on-chain via Midnight.toMarket(id) — the id is a cryptographic commitment to the struct, so no
// off-chain market input or `id == toId(market)` re-check is needed — then composes liquidatability
// + the sizing inputs (maxDebt/badDebt/best-collateral) the way liquidate() does and returns the
// Market so the caller can encode the liquidate call. Compiled to a deployless factory by the soltag
// bun preload (see ../../soltag.preload.ts); `sol``` throws if not active.
export const MidnightLiquidationLens = sol('MidnightLiquidationLens')`
// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

struct CollateralParams { address token; uint256 lltv; uint256 maxLif; address oracle; }
struct Market {
  address loanToken;
  CollateralParams[] collateralParams;
  uint256 maturity;
  uint256 rcfThreshold;
  address enterGate;
  address liquidatorGate;
}

interface IMidnight {
  function toMarket(bytes32 id) external view returns (Market memory);
  function liquidationLocked(bytes32 id, address user) external view returns (bool);
  function debtOf(bytes32 id, address user) external view returns (uint256);
  function collateralBitmap(bytes32 id, address user) external view returns (uint128);
  function collateral(bytes32 id, address user, uint256 index) external view returns (uint128);
}
interface IOracle { function price() external view returns (uint256); }
interface ILiquidatorGate { function canLiquidate(address account) external view returns (bool); }

contract MidnightLiquidationLens {
  uint256 internal constant WAD = 1e18;
  uint256 internal constant ORACLE_PRICE_SCALE = 1e36;

  IMidnight public immutable MIDNIGHT;

  struct LensOut {
    bool valid; bool hasDebt; bool healthy; bool locked; bool gateAllows;
    uint64 blockTimestamp;
    uint128 debt; uint128 maxDebt; uint128 badDebt; uint128 activatedBitmap;
    uint8 bestCollateralIdx; uint128 bestCollateralAmt;
    uint256 bestCollateralPrice; uint256 bestCollateralMaxLif; uint256 bestCollateralLltv;
    Market market;
  }

  constructor(IMidnight midnight) { MIDNIGHT = midnight; }

  function _mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) { return (x * y) / d; }
  function _mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) { return (x * y + (d - 1)) / d; }
  function _zeroFloorSub(uint256 x, uint256 y) internal pure returns (uint256) { return x > y ? x - y : 0; }
  function _msb(uint128 bitmap) internal pure returns (uint256 res) { while (bitmap >> (res + 1) != 0) { res++; } }
  function _clearBit(uint128 bitmap, uint256 bit) internal pure returns (uint128) { return uint128(bitmap & ~(uint128(1) << bit)); }

  function lens(bytes[] calldata input) external view returns (bytes[] memory output) {
    output = new bytes[](input.length);
    for (uint256 i = 0; i < input.length; i++) {
      // Per-element isolation: a revert (bad oracle, unknown id, decode failure) leaves output[i]
      // as a zeroed LensOut (valid=false) instead of reverting the whole batch. computeOne is
      // external view, so the self-call is a STATICCALL and cannot mutate state.
      try this.computeOne(input[i]) returns (bytes memory encoded) {
        output[i] = encoded;
      } catch {
        LensOut memory zeroed;
        output[i] = abi.encode(zeroed);
      }
    }
  }

  function computeOne(bytes calldata element) external view returns (bytes memory) {
    (bytes32 id, address borrower, address caller) =
      abi.decode(element, (bytes32, address, address));

    // Reverts MarketNotCreated for an unknown id — caught by lens()'s per-element try/catch, which
    // leaves a zeroed (valid=false) row. A successful read is the canonical Market for this id.
    Market memory market = MIDNIGHT.toMarket(id);

    LensOut memory o;
    o.blockTimestamp = uint64(block.timestamp);
    o.valid = true;
    o.market = market;

    uint256 debt = MIDNIGHT.debtOf(id, borrower);
    o.debt = uint128(debt);
    o.hasDebt = debt > 0;
    o.locked = MIDNIGHT.liquidationLocked(id, borrower);

    address gate = market.liquidatorGate;
    if (gate == address(0)) {
      o.gateAllows = true;
    } else {
      try ILiquidatorGate(gate).canLiquidate(caller) returns (bool ok) { o.gateAllows = ok; }
      catch { o.gateAllows = false; }
    }

    o.activatedBitmap = MIDNIGHT.collateralBitmap(id, borrower);
    _accumulate(o, market, id, borrower, debt);
    _selectBest(o, market, id, borrower);
    return abi.encode(o);
  }

  // Two passes (not one combined loop): a single loop carrying maxDebt/badDebt/argmax exceeds the
  // EVM stack ("stack too deep"). Each slot is re-read in _selectBest — acceptable for a read-only
  // lens. _accumulate mirrors the liquidate() loop exactly (maxDebt down-down; badDebt ceil-ceil,
  // seeded with debt and floored at 0 per slot).
  function _accumulate(LensOut memory o, Market memory market, bytes32 id, address borrower, uint256 debt) private view {
    uint256 maxDebt;
    uint256 badDebt = debt;
    uint128 work = o.activatedBitmap;
    while (work != 0) {
      uint256 idx = _msb(work);
      CollateralParams memory cp = market.collateralParams[idx];
      uint256 amt = uint256(MIDNIGHT.collateral(id, borrower, idx));
      uint256 price = IOracle(cp.oracle).price();
      maxDebt += _mulDivDown(_mulDivDown(amt, price, ORACLE_PRICE_SCALE), cp.lltv, WAD);
      badDebt = _zeroFloorSub(badDebt, _mulDivUp(_mulDivUp(amt, price, ORACLE_PRICE_SCALE), WAD, cp.maxLif));
      work = _clearBit(work, idx);
    }
    o.maxDebt = uint128(maxDebt);
    o.badDebt = uint128(badDebt);
    o.healthy = maxDebt >= debt; // matches isHealthy's final return
  }

  // Picks the activated slot with the greatest USD value (collateral*price/SCALE).
  function _selectBest(LensOut memory o, Market memory market, bytes32 id, address borrower) private view {
    uint256 bestValue;
    bool haveBest;
    uint128 work = o.activatedBitmap;
    while (work != 0) {
      uint256 idx = _msb(work);
      CollateralParams memory cp = market.collateralParams[idx];
      uint256 amt = uint256(MIDNIGHT.collateral(id, borrower, idx));
      uint256 price = IOracle(cp.oracle).price();
      uint256 value = _mulDivDown(amt, price, ORACLE_PRICE_SCALE);
      if (!haveBest || value > bestValue) {
        haveBest = true;
        bestValue = value;
        o.bestCollateralIdx = uint8(idx);
        o.bestCollateralAmt = uint128(amt);
        o.bestCollateralPrice = price;
        o.bestCollateralMaxLif = cp.maxLif;
        o.bestCollateralLltv = cp.lltv;
      }
      work = _clearBit(work, idx);
    }
  }
}
`

const COLLATERAL_PARAMS_COMPONENTS = [
  { name: 'token', type: 'address' },
  { name: 'lltv', type: 'uint256' },
  { name: 'maxLif', type: 'uint256' },
  { name: 'oracle', type: 'address' }
] as const

const MARKET_COMPONENTS = [
  { name: 'loanToken', type: 'address' },
  { name: 'collateralParams', type: 'tuple[]', components: COLLATERAL_PARAMS_COMPONENTS },
  { name: 'maturity', type: 'uint256' },
  { name: 'rcfThreshold', type: 'uint256' },
  { name: 'enterGate', type: 'address' },
  { name: 'liquidatorGate', type: 'address' }
] as const

const LENS_INPUT_ABI = [
  { name: 'id', type: 'bytes32' },
  { name: 'borrower', type: 'address' },
  { name: 'caller', type: 'address' }
] as const

// Precise ABI of the lens entrypoint. soltag's compiled abi is only precisely typed post-transform
// (at runtime), so at compile time we hand the deployless helper this exact fragment for its
// single-array-in/out check + selector; the runtime factory/factoryData still come from soltag.
const LENS_FUNCTION_ABI = [
  {
    type: 'function',
    name: 'lens',
    stateMutability: 'view',
    inputs: [{ name: 'input', type: 'bytes[]' }],
    outputs: [{ name: 'output', type: 'bytes[]' }]
  }
] as const

const LENS_OUT_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'valid', type: 'bool' },
      { name: 'hasDebt', type: 'bool' },
      { name: 'healthy', type: 'bool' },
      { name: 'locked', type: 'bool' },
      { name: 'gateAllows', type: 'bool' },
      { name: 'blockTimestamp', type: 'uint64' },
      { name: 'debt', type: 'uint128' },
      { name: 'maxDebt', type: 'uint128' },
      { name: 'badDebt', type: 'uint128' },
      { name: 'activatedBitmap', type: 'uint128' },
      { name: 'bestCollateralIdx', type: 'uint8' },
      { name: 'bestCollateralAmt', type: 'uint128' },
      { name: 'bestCollateralPrice', type: 'uint256' },
      { name: 'bestCollateralMaxLif', type: 'uint256' },
      { name: 'bestCollateralLltv', type: 'uint256' },
      { name: 'market', type: 'tuple', components: MARKET_COMPONENTS }
    ]
  }
] as const

/** What the lens reads for one (id, borrower) pair. The lens fetches the Market on-chain from
 * `id`; `caller` is the Executor (the liquidate `msg.sender`), whose `canLiquidate` is checked —
 * not the EOA. */
export type LensInput = { id: Hex; borrower: Address; caller: Address }

/** Decoded `LensOut` (uint8 → number, uint64/128/256 → bigint, per viem). */
export type LensOut = {
  valid: boolean
  hasDebt: boolean
  healthy: boolean
  locked: boolean
  gateAllows: boolean
  blockTimestamp: bigint
  debt: bigint
  maxDebt: bigint
  badDebt: bigint
  activatedBitmap: bigint
  bestCollateralIdx: number
  bestCollateralAmt: bigint
  bestCollateralPrice: bigint
  bestCollateralMaxLif: bigint
  bestCollateralLltv: bigint
  /** Full Market read on-chain via `toMarket(id)`; pass straight into `liquidate`. */
  market: Market
}

export function encodeLensInput(input: LensInput): Hex {
  return encodeAbiParameters(LENS_INPUT_ABI, [input.id, input.borrower, input.caller])
}

export function decodeLensOut(output: Hex): LensOut {
  return decodeAbiParameters(LENS_OUT_ABI, output)[0]
}

/** Stable per-pair key for the result map. */
export function lensKey(id: Hex, borrower: Address): string {
  return `${id.toLowerCase()}:${borrower.toLowerCase()}`
}

/**
 * Reads the liquidation lens for every pair in one deployless, chunked `eth_call` (no signer, no
 * cache — decisions need fresh state). The lens fetches each Obligation on-chain from its `id`.
 * Returns a map keyed by {@link lensKey}. The `client` must use viem-dlc's deployless transport
 * (built in `chain/client.ts`). The gas coefficients below are placeholders to calibrate on a Base
 * fork before go-live.
 */
export async function readMidnightLiquidationLens(
  client: Client<Transport<BatchLensTransportType>>,
  midnight: Address,
  pairs: readonly LensInput[]
): Promise<Map<string, LensOut>> {
  const inputs = pairs.map(encodeLensInput)
  const compiled = MidnightLiquidationLens.with(midnight)
  const byInput = await readDeploylessBatchLens(
    client,
    {
      ...compiled,
      abi: LENS_FUNCTION_ABI,
      functionName: 'lens',
      args: [inputs],
      batch: {
        batchSize: MAX_INITCODE_SIZE,
        exfil: 'revert',
        compress: false,
        gas: { default: { constant: 600_000, linear: 30_000, quadratic: 0 } }
      }
    },
    input => input,
    (_input, output) => decodeLensOut(output)
  )

  const result = new Map<string, LensOut>()
  pairs.forEach((pair, i) => {
    const out = byInput.get(inputs[i]!)
    if (out) result.set(lensKey(pair.id, pair.borrower), out)
  })
  return result
}
