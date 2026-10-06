import { getAddress } from 'viem'

import { requireChecksumAddress } from '../src/require-checksum-address'
import { ruleTester } from './rule-tester'

const CHECKSUMMED = getAddress('0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb')

ruleTester.run('require-checksum-address', requireChecksumAddress, {
  valid: [
    `const a = '${CHECKSUMMED}'`,
    `const a = '0x${'0'.repeat(40)}'`,
    `const hash = '0x${'ab'.repeat(32)}'`,
    `const sha = 'bbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'`
  ],
  invalid: [
    {
      code: `const a = '${CHECKSUMMED.toLowerCase()}'`,
      errors: [{ message: `Write the address checksummed: ${CHECKSUMMED}` }]
    },
    {
      code: `const a = \`${CHECKSUMMED.toLowerCase()}\``,
      errors: [{ message: `Write the address checksummed: ${CHECKSUMMED}` }]
    }
  ]
})
