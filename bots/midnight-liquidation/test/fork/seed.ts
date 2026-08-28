// Mints a real, liquidatable WETH/USDC position inside the anvil fork so the liquidation suite has
// something to liquidate on the fresh 0xAdedD8ab… deployment (which carries no organic debt). Midnight
// has no `borrow()`: debt is only created through the `take` order-book path, where the maker buys
// units (pays USDC) and the taker sells them (supplies collateral, takes on the debt). So this drives
// the full path — clone a curator-trusted market, fund both EOAs via cheatcodes, sign the offer with
// the new 336b924a typehashes, then `supplyCollateral` + `take`. The position is healthy at creation
// (the `take` seller-health check) with a maturity 1h out; the suite warps past it to make it
// post-maturity liquidatable. Reuses the operator script's offer cryptography (scripts/seed/offers.ts)
// verbatim — only the token funding differs (cheatcode wrap/swap here vs. real capital there).

import type { Address, Hex, WalletClient } from 'viem'

import { MidnightAbi } from '@repo/contracts'
import {
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  numberToHex,
  parseEther,
  publicActions,
  zeroAddress
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

import type { Offer } from '../../scripts/seed/offers'
import type { CollateralParams, Market } from '../../src/execution/encode-call'
import type { TestClient } from './harness'

import { ORACLE_ABI, SWAP_ROUTER_ABI, WETH_ABI } from '../../scripts/seed/abis'
import { encodeRatifierData, hashOffer, signOfferTree, toId } from '../../scripts/seed/offers'
import { DEFAULT_TICK_SPACING, priceToTick } from '../../scripts/seed/price-tick'
import { sizePosition } from '../../scripts/seed/sizing'
import { mulDivDown } from '../../src/sizing/math'
import {
  BORROWER_KEY,
  CONFIGURATOR,
  ECRECOVER_RATIFIER,
  deployIdentityOracle,
  fundEth,
  IDENTITY_ORACLE,
  LIQUIDATION_CURSOR,
  LLTV,
  LOAN_COLLATERAL_CURSOR,
  LOAN_COLLATERAL_LLTV,
  MAKER_KEY,
  MIDNIGHT,
  POOL_FEE,
  SWAP_ROUTER_02,
  USDC,
  WETH,
  WETH_USDC_ORACLE
} from './harness'

const WAD = 10n ** 18n
// Offer price ~0.99 (must be ≤ 1 WAD for priceToTick); position health uses the ORACLE price, not this.
const OFFER_PRICE = 990_000_000_000_000_000n
// 1 USDC target debt with a 20% health buffer → comfortably over-collateralized, so post-maturity the
// seize-exact plan caps the repay at the debt (repaidUnits derived by the contract) and turns a profit.
const DEBT_TARGET_UNITS = 1_000_000n // 1 USDC (6 decimals)
const DRAWDOWN_BPS = 2000
// Large, RCF-exempt threshold so the bot repays the full debt in one liquidation (mirrors the seeder).
const RCF_THRESHOLD = 10n ** 30n
// WETH wallet A wraps then swaps to USDC — plenty to cover the tiny buyerAssets with slippage headroom.
const MAKER_WETH_IN = parseEther('0.5')

/** Sends a wallet tx and asserts it mined successfully (surfaces the reverting seed step by name). */
// oxlint-disable-next-line no-explicit-any -- viem's writeContract union is too wide to name here
async function send(wallet: WalletClient, test: TestClient, call: any): Promise<void> {
  const hash = await wallet.writeContract({ chain: base, ...call })
  const receipt = await test.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`seed step reverted: ${call.functionName}`)
}

export type SeededPosition = { id: Hex; borrower: Address; maturity: bigint }

/**
 * Which collateral shape to seed. `loanAsCollateral` builds the live Base shape where the market's own
 * loan token is the accepted collateral, priced by the official identity oracle — the case the bot
 * liquidates with NO swap at all, so the exec path must work with an empty {@link SwapPlan}.
 *
 * A single-collateral loan-as-collateral market is legal at the protocol level;
 * "loan cannot be the only collateral" is a router ADMISSION rule, not a contract constraint
 * (midnight-contracts.txt only requires a non-empty, address-sorted list).
 */
type SeedShape = 'weth-collateral' | 'loan-as-collateral'

// Per-shape collateral params + how the borrower's collateral is funded. Grouped so the two shapes
// cannot drift apart in the seeder body.
const SHAPES = {
  'weth-collateral': {
    token: WETH,
    oracle: WETH_USDC_ORACLE,
    lltv: LLTV,
    cursor: LIQUIDATION_CURSOR,
    group: 0
  },
  'loan-as-collateral': {
    token: USDC,
    oracle: IDENTITY_ORACLE,
    lltv: LOAN_COLLATERAL_LLTV,
    cursor: LOAN_COLLATERAL_CURSOR,
    // A DISTINCT offer group per shape. `consumed[maker][group]` accumulates across takes and is
    // capped at the offer's own `maxUnits` (midnight-contracts.txt:1570), so seeding a second
    // position from the same maker into group 0 reverts `ConsumedUnits()` — both offers size
    // `maxUnits` to their own `units`, and the first one has already spent the budget.
    group: 1
  }
} as const satisfies Record<
  SeedShape,
  { token: Address; oracle: Address; lltv: bigint; cursor: bigint; group: number }
>

/**
 * Opens one liquidatable WETH/USDC position on the fork and returns its `{ id, borrower, maturity }`
 * (the shape the suite previously pinned as a constant). The caller warps past `maturity` to liquidate.
 */
export async function seedLiquidatablePosition(
  test: TestClient,
  rpcUrl: string,
  shape: SeedShape = 'weth-collateral'
): Promise<SeededPosition> {
  const params = SHAPES[shape]
  // The live identity oracle postdates FORK_BLOCK, so the loan-as-collateral shape needs its
  // fork-local stand-in in place before anything reads a price. See `deployIdentityOracle`.
  if (shape === 'loan-as-collateral') await deployIdentityOracle(test)
  const maker = privateKeyToAccount(MAKER_KEY)
  const borrower = privateKeyToAccount(BORROWER_KEY)
  const walletA = createWalletClient({ account: maker, chain: base, transport: http(rpcUrl) })
  const walletB = createWalletClient({ account: borrower, chain: base, transport: http(rpcUrl) })
  await fundEth(test, maker.address)
  await fundEth(test, borrower.address)

  // The cloned market's (lltv, cursor) pair may not be enabled on the fresh deploy — enable whichever
  // half is missing by impersonating the configurator. The WETH shape's lltv is already enabled
  // on-chain; loan-as-collateral's 0.98 may not be, so both are checked rather than just the cursor.
  const [lltvEnabled, cursorEnabled] = await Promise.all([
    test.readContract({
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'isLltvEnabled',
      args: [params.lltv]
    }),
    test.readContract({
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'isLiquidationCursorEnabled',
      args: [params.cursor]
    })
  ])
  if (!lltvEnabled || !cursorEnabled) {
    await fundEth(test, CONFIGURATOR)
    await test.impersonateAccount({ address: CONFIGURATOR })
    const cfgWallet = createWalletClient({
      account: CONFIGURATOR,
      chain: base,
      transport: http(rpcUrl)
    })
    if (!lltvEnabled) {
      await send(cfgWallet, test, {
        address: MIDNIGHT,
        abi: MidnightAbi,
        functionName: 'enableLltv',
        args: [params.lltv]
      })
    }
    if (!cursorEnabled) {
      await send(cfgWallet, test, {
        address: MIDNIGHT,
        abi: MidnightAbi,
        functionName: 'enableLiquidationCursor',
        args: [params.cursor]
      })
    }
    await test.stopImpersonatingAccount({ address: CONFIGURATOR })
  }

  // Size the position off the live oracle price so it is healthy at creation with a known buffer. For
  // loan-as-collateral this reads the identity oracle, i.e. exactly ORACLE_PRICE_SCALE.
  const price = await test.readContract({
    address: params.oracle,
    abi: ORACLE_ABI,
    functionName: 'price'
  })
  const cp: CollateralParams = {
    token: getAddress(params.token),
    lltv: params.lltv,
    liquidationCursor: params.cursor,
    oracle: getAddress(params.oracle)
  }
  const { collateral, units } = sizePosition({
    price,
    lltv: params.lltv,
    debtTargetUnits: DEBT_TARGET_UNITS,
    drawdownBps: DRAWDOWN_BPS
  })

  const now = (await test.getBlock()).timestamp
  const maturity = now + 3600n // 1h ahead: healthy (pre-maturity) at creation; the suite warps past it.
  const tick = priceToTick(OFFER_PRICE, DEFAULT_TICK_SPACING)

  const market: Market = {
    chainId: BigInt(base.id),
    midnight: getAddress(MIDNIGHT),
    loanToken: getAddress(USDC),
    collateralParams: [cp],
    maturity,
    rcfThreshold: RCF_THRESHOLD,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  }
  const id = toId(market)
  const offer: Offer = {
    market,
    buy: true,
    maker: maker.address,
    start: now - 300n,
    expiry: now + 7n * 24n * 3600n,
    tick,
    group: numberToHex(params.group, { size: 32 }),
    callback: zeroAddress,
    callbackData: '0x',
    receiverIfMakerIsSeller: zeroAddress,
    ratifier: getAddress(ECRECOVER_RATIFIER),
    reduceOnly: false,
    maxUnits: units,
    maxAssets: 0n,
    continuousFeeCap: 4294967295n // max uint32 — robust to a nonzero default continuous fee.
  }
  const root = hashOffer(offer)
  const signature = await signOfferTree({
    root,
    privateKey: MAKER_KEY,
    ratifier: getAddress(ECRECOVER_RATIFIER),
    chainId: base.id
  })
  const ratifierData = encodeRatifierData({ signature, root, leafIndex: 0n, proof: [] })
  const buyerAssets = mulDivDown(units, OFFER_PRICE, WAD)

  // Wallet A (maker): acquire USDC (wrap ETH → WETH → swap → USDC), approve Midnight, authorize ratifier.
  await send(walletA.extend(publicActions), test, {
    address: WETH,
    abi: WETH_ABI,
    functionName: 'deposit',
    args: [],
    value: MAKER_WETH_IN
  })
  await send(walletA, test, {
    address: WETH,
    abi: erc20Abi,
    functionName: 'approve',
    args: [SWAP_ROUTER_02, MAKER_WETH_IN]
  })
  await send(walletA, test, {
    address: SWAP_ROUTER_02,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: POOL_FEE,
        recipient: maker.address,
        amountIn: MAKER_WETH_IN,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n
      }
    ]
  })
  await send(walletA, test, {
    address: USDC,
    abi: erc20Abi,
    functionName: 'approve',
    args: [MIDNIGHT, buyerAssets]
  })
  const authed = await test.readContract({
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'isAuthorized',
    args: [maker.address, getAddress(ECRECOVER_RATIFIER)]
  })
  if (!authed) {
    await send(walletA, test, {
      address: MIDNIGHT,
      abi: MidnightAbi,
      functionName: 'setIsAuthorized',
      args: [getAddress(ECRECOVER_RATIFIER), true, maker.address]
    })
  }

  // Wallet B (borrower/taker): acquire the collateral token, approve Midnight, supplyCollateral, take.
  if (shape === 'loan-as-collateral') {
    // The collateral IS USDC, so buy it the same way the maker does. `MAKER_WETH_IN` of WETH buys far
    // more than the tiny `collateral` target, and the surplus is harmless — it stays on the EOA.
    await send(walletB.extend(publicActions), test, {
      address: WETH,
      abi: WETH_ABI,
      functionName: 'deposit',
      args: [],
      value: MAKER_WETH_IN
    })
    await send(walletB, test, {
      address: WETH,
      abi: erc20Abi,
      functionName: 'approve',
      args: [SWAP_ROUTER_02, MAKER_WETH_IN]
    })
    await send(walletB, test, {
      address: SWAP_ROUTER_02,
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH,
          tokenOut: USDC,
          fee: POOL_FEE,
          recipient: borrower.address,
          amountIn: MAKER_WETH_IN,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n
        }
      ]
    })
  } else {
    await send(walletB.extend(publicActions), test, {
      address: WETH,
      abi: WETH_ABI,
      functionName: 'deposit',
      args: [],
      value: collateral
    })
  }
  await send(walletB, test, {
    address: params.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [MIDNIGHT, collateral]
  })
  await send(walletB, test, {
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'supplyCollateral',
    args: [market, 0n, collateral, borrower.address]
  })
  await send(walletB, test, {
    address: MIDNIGHT,
    abi: MidnightAbi,
    functionName: 'take',
    args: [offer, ratifierData, units, borrower.address, borrower.address, zeroAddress, '0x']
  })

  return { id, borrower: borrower.address, maturity }
}
