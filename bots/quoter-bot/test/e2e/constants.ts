import type { Hex } from 'viem'

import { getAddress, parseEther, parseUnits, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const ANVIL_DEFAULT_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
export const ANVIL_DEFAULT_ACCOUNT = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY)
export const ANVIL_TAKER_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
export const ANVIL_TAKER_ACCOUNT = privateKeyToAccount(ANVIL_TAKER_PRIVATE_KEY)

export const MARKET_ID = '0x168e31250e0008b50d2255a5ab85e0265acd6c12e4f9a1336134b36a65a47937' as Hex
export const REFERENCE_MARKET_ID =
  '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' as Hex

export const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
export const ECRECOVER_RATIFIER = getAddress('0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E')
export const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
export const CBBTC = getAddress('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf')
const ORACLE = getAddress('0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9')

export const MARKET = {
  chainId: 8453,
  midnight: MIDNIGHT,
  loanToken: USDC,
  collaterals: [
    {
      token: CBBTC,
      lltv: '860000000000000000',
      liquidation_cursor: '300000000000000000',
      oracle: ORACLE
    }
  ],
  maturity: 1_785_510_000,
  rcfThreshold: '3000000000',
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
} as const

export const MAKER_USDC_BALANCE = parseUnits('1000000', 6)
export const MAXIMUM_LEND_EXPOSURE = parseUnits('100000', 6)
export const NATIVE_RESERVE = parseEther('1')
