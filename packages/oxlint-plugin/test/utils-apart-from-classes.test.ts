import { utilsApartFromClasses } from '../src/utils-apart-from-classes'
import { ruleTester } from './rule-tester'

ruleTester.run('utils-apart-from-classes', utilsApartFromClasses, {
  valid: [
    'export class Queue {}\nexport type QueueItem = { id: string }\nconst helper = () => 1',
    'export const helper = () => 1\nexport function other() {}',
    'export class Queue {}\nexport const LIMIT = 3'
  ],
  invalid: [
    { code: 'export class Queue {}\nexport const helper = () => 1', errors: 1 },
    { code: 'export function helper() {}\nexport class Queue {}', errors: 1 }
  ]
})
