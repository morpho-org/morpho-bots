import { noAsAddress } from '../src/no-as-address'
import { ruleTester } from './rule-tester'

ruleTester.run('no-as-address', noAsAddress, {
  valid: [
    'const a = getAddress(value)',
    'const h = value as Hex',
    'const a = value as viem.Address'
  ],
  invalid: [{ code: "const a = '0x01' as Address", errors: 1 }]
})
