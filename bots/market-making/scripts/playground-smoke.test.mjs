import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const smoke = await readFile(new URL('./playground-smoke.mjs', import.meta.url), 'utf8')

test('browser smoke covers the required stateless bootstrap and ladder workflow', () => {
  for (const required of [
    '[data-preview=bootstrap]',
    '[data-preview=ladder]',
    'input[type=file]',
    '__smoke.replacements',
    'collection-import',
    'duplicate',
    'primitive',
    'copy-share-url',
    '[role=tab]',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'caches',
    'unexpected',
    'malformed fallback',
    'share URL reload'
  ])
    assert.match(smoke, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('browser smoke uses local assets and cleans every owned process/resource', () => {
  assert.match(smoke, /startsWith\(`http:\/\/127\.0\.0\.1:/)
  assert.match(smoke, /browser\.kill\('SIGTERM'\)/)
  assert.match(smoke, /browser\.kill\('SIGKILL'\)/)
  assert.match(smoke, /server\.close/)
  assert.match(smoke, /Promise\.all\(owned\.map/)
})
