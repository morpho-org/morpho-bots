import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

test('market-making image prepares the persistent state mount before dropping privileges', async () => {
  const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8')
  const stateDirectory = dockerfile.indexOf('mkdir -p /repo /state')
  const stateOwnership = dockerfile.indexOf('chown node:node /repo /state')
  const unprivilegedUser = dockerfile.indexOf('USER node')

  expect(stateDirectory).toBeGreaterThan(-1)
  expect(stateOwnership).toBeGreaterThan(stateDirectory)
  expect(unprivilegedUser).toBeGreaterThan(stateOwnership)
})
