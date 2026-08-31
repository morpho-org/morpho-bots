import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base, mainnet } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { resolveObservabilityChainId } from '../../src/config/observability-chain.utils'

const writeConfig = async (directory: string, name: string, chainId: number) => {
  const path = join(directory, name)
  await writeFile(path, `chain:\n  id: ${chainId}\n  rpcUrl: 'https://rpc.example'\n`)
  return path
}

describe('resolveObservabilityChainId', () => {
  test('prefers CHAIN_ID over any configuration file, matching config precedence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observability-chain-env-'))
    try {
      const path = await writeConfig(directory, 'mainnet.yaml', mainnet.id)
      expect(
        await resolveObservabilityChainId({ CHAIN_ID: String(base.id) }, ['--config', path])
      ).toBe(base.id)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reads the chain from an explicit config path in both flag spellings', async () => {
    // Regression: reading only the environment labelled a YAML-configured mainnet run as Base,
    // and the pre-parser originally missed the `-c` spelling the CLI also declares.
    const directory = await mkdtemp(join(tmpdir(), 'observability-chain-flag-'))
    try {
      const path = await writeConfig(directory, 'mainnet.yaml', mainnet.id)
      for (const argv of [['--config', path], ['-c', path], [`--config=${path}`]]) {
        expect(await resolveObservabilityChainId({}, argv)).toBe(mainnet.id)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('falls back to Base instead of throwing on unreadable or unsupported configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observability-chain-bad-'))
    try {
      const missing = join(directory, 'absent.yaml')
      expect(await resolveObservabilityChainId({}, ['--config', missing])).toBe(base.id)

      const unsupported = await writeConfig(directory, 'unsupported.yaml', 10)
      expect(await resolveObservabilityChainId({}, ['--config', unsupported])).toBe(base.id)

      // A dangling flag must not be read as a path.
      expect(await resolveObservabilityChainId({}, ['-c'])).toBe(base.id)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
