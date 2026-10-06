import { noHexTemplate } from '../src/no-hex-template'
import { ruleTester } from './rule-tester'

ruleTester.run('no-hex-template', noHexTemplate, {
  valid: ['type A = Address', 'type T = `id-${string}`', 'const s = `0x${value}`'],
  invalid: [
    { code: 'type A = `0x${string}`', errors: 1 },
    { code: 'const f = (data: `0x${string}`[]) => data', errors: 1 }
  ]
})
