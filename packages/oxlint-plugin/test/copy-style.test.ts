import { copyStyle } from '../src/copy-style'
import { ruleTester } from './rule-tester'

ruleTester.run('copy-style', copyStyle, {
  valid: [
    '// Reads onchain state, then plans offchain\nconst a = 1',
    "const log = 'on-chain.read'",
    'console.log(`deployed on chain ${chainId}`)',
    '// Deployed on chain 8453\nconst a = 1',
    "// The `erc4626` unwrapper runs first, before 'erc4626' logging\nconst a = 1",
    '// An ERC-4626 vault on a Blue Market with an APY cap\nconst a = 1',
    "const Lens = sol('Lens')`// reads on-chain state of the Blue market`",
    '// Vault V1 and Vault V2 on Morpho Blue, via the `MetaMorpho` ABI\nconst a = 1',
    "import type { TakeableOffer } from './order-book'"
  ],
  invalid: [
    { code: '// reads on-chain state\nconst a = 1', errors: 1 },
    { code: '/** Planned off-chain. */\nconst a = 1', errors: 1 },
    { code: "throw new Error('reverted on chain before settling')", errors: 1 },
    { code: '// an ERC4626 vault\nconst a = 1', errors: 1 },
    { code: "it('converts apy to rate', () => {})", errors: 1 },
    { code: '// one Blue market per position\nconst a = 1', errors: 1 },
    { code: 'const label = `Midnight markets for ${chain}`', errors: 1 },
    { code: '// check the Health Factor\nconst a = 1', errors: 1 },
    { code: '// built on the Morpho Protocol\nconst a = 1', errors: 1 },
    { code: '// reallocates a Vault v2\nconst a = 1', errors: 1 },
    { code: '// deployed on morpho blue\nconst a = 1', errors: 1 },
    { code: '// set by the V1 guardian\nconst a = 1', errors: 1 },
    { code: "const text = 'Resolves crossed order books'", errors: 1 },
    { code: '// whitelisted MetaMorpho vault\nconst a = 1', errors: 1 },
    { code: '// a quick sanity check\nconst a = 1', errors: 1 }
  ]
})
