import { ExecutorAbi } from '@repo/abis/v2'
import { describe, expect, test } from 'bun:test'
import { executorAbi as upstreamExecutorAbi } from 'executooor-viem'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import solc from 'solc'
import { toFunctionSelector } from 'viem'

// Verifies the vendored Executor singleton (repo-root contracts/executooor — hence no src/ mirror
// for this test): it must compile clean for Cancun, its ABI must stay byte-for-byte in sync with
// the hand-written @repo/abis/v2 ExecutorAbi, and its only functional diff from upstream
// Rubilmax/executooor must remain the stripped owner gate (no constructor, same call surface).
// solc runs once per file (~seconds), so all assertions share one compile.

const CONTRACTS_DIR = join(import.meta.dir, '../../../../contracts/executooor')

function compile() {
  const input = {
    language: 'Solidity',
    sources: {
      'Executor.sol': { content: readFileSync(join(CONTRACTS_DIR, 'Executor.sol'), 'utf8') },
      'interfaces/IExecutor.sol': {
        content: readFileSync(join(CONTRACTS_DIR, 'interfaces/IExecutor.sol'), 'utf8')
      }
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

describe('contracts/executooor/Executor.sol', () => {
  test('compiles for Cancun with zero errors', () => {
    expect(errors.map(e => e.formattedMessage)).toEqual([])
    expect(executor).toBeDefined()
    expect(executor!.evm.bytecode.object.length).toBeGreaterThan(0)
  })

  test('solc ABI matches @repo/abis/v2 ExecutorAbi exactly', () => {
    expect(executor!.abi).toEqual(ExecutorAbi as unknown as unknown[])
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
      (ExecutorAbi as readonly { type: string }[]).some(entry => entry.type === 'constructor')
    ).toBe(false)
    expect(signatures(ExecutorAbi)).toEqual(
      signatures(upstreamExecutorAbi.filter(entry => entry.type !== 'constructor'))
    )
  })
})
