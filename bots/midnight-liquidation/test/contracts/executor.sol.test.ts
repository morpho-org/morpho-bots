import { Executor } from '@repo/contracts'
import { executorAbi as upstreamExecutorAbi } from 'executooor-viem'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'
import { toFunctionSelector } from 'viem'
import { describe, expect, test } from 'vitest'

// Verifies the vendored Executor singleton (@repo/contracts/solidity/Executor.sol — a single
// self-contained file with IExecutor/Placeholder inlined): it must compile clean for Cancun, its
// ABI must stay byte-for-byte in sync with @repo/contracts/v2's soltag-generated Executor.abi, and its
// only functional diff from upstream Rubilmax/executooor must remain the stripped owner gate (no
// constructor, same call surface). solc runs once per file (~seconds), so all assertions share one
// compile.

const CONTRACTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/solidity'
)

function compile() {
  const input = {
    language: 'Solidity',
    sources: {
      'Executor.sol': { content: readFileSync(join(CONTRACTS_DIR, 'Executor.sol'), 'utf8') }
    },
    settings: {
      optimizer: { enabled: true, runs: 999_999 },
      // tload/tstore (EIP-1153) and mcopy (EIP-5656) require Cancun; Base has it since Ecotone.
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[]
    contracts: Record<
      string,
      Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>
    >
  }
  return {
    errors: (output.errors ?? []).filter(e => e.severity === 'error'),
    executor: output.contracts['Executor.sol']?.Executor
  }
}

const { errors, executor } = compile()

describe('packages/contracts/solidity/Executor.sol', () => {
  test('compiles for Cancun with zero errors', () => {
    expect(errors.map(e => e.formattedMessage)).toEqual([])
    expect(executor).toBeDefined()
    expect(executor!.evm.bytecode.object.length).toBeGreaterThan(0)
  })

  test('solc ABI matches @repo/contracts/v2 Executor.abi exactly', () => {
    expect(executor!.abi).toEqual(Executor.abi as unknown as unknown[])
  })

  test('owner gate is the only ABI diff from upstream executooor: constructor dropped, call surface identical', () => {
    const signatures = (abi: readonly unknown[]) =>
      (abi as { type: string }[])
        .map(entry =>
          entry.type === 'function'
            ? toFunctionSelector(entry as Parameters<typeof toFunctionSelector>[0])
            : entry.type
        )
        .sort()

    expect(
      (Executor.abi as readonly { type: string }[]).some(entry => entry.type === 'constructor')
    ).toBe(false)
    expect(signatures(Executor.abi)).toEqual(
      signatures(upstreamExecutorAbi.filter(entry => entry.type !== 'constructor'))
    )
  })
})
