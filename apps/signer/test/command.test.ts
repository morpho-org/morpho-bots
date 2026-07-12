import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const SIGNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const SIGNER_ADDRESS = privateKeyToAccount(SIGNER_KEY).address
const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const PACKAGE_DIR = join(import.meta.dir, '..')
const SPAWN_TIMEOUT_MS = 30_000

const POLICY = {
  chainId: 8453,
  executor: EXECUTOR,
  maxFeePerGasWei: '300000000000',
  maxGasLimit: '15000000',
  maxDataBytes: 65536
}

const homes: string[] = []

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 's-'))
  homes.push(path)
  return path
}

function run(env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bun', 'src/main.ts'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, MORPHO_BOTS_HOME: home(), ...env }
  })
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString()
  }
}

function rpc(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const end = buffer.indexOf('\n')
      if (end === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, end)))
    })
    socket.on('error', reject)
  })
}

afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('morpho-signer', () => {
  it('exits 2 when SIGNER_PRIVATE_KEY is missing', () => {
    const { code, stderr } = run()
    expect(code).toBe(2)
    expect(stderr).toContain('SIGNER_PRIVATE_KEY')
  })

  it('exits 2 when the default-deny policy file is missing', () => {
    const { code, stderr } = run({ SIGNER_PRIVATE_KEY: SIGNER_KEY })
    expect(code).toBe(2)
    expect(stderr).toContain('signer policy')
  })

  it(
    'loads an inline policy, identifies itself, and exits cleanly on SIGTERM',
    async () => {
      const signerHome = home()
      const socketPath = join(signerHome, 'signer.sock')
      const process = Bun.spawn(['bun', 'src/main.ts'], {
        cwd: PACKAGE_DIR,
        env: {
          ...globalThis.process.env,
          MORPHO_BOTS_HOME: signerHome,
          SIGNER_PRIVATE_KEY: SIGNER_KEY,
          SIGNER_POLICY_JSON: JSON.stringify(POLICY)
        },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      try {
        for (let i = 0; i < 200 && !existsSync(socketPath); i += 1) await Bun.sleep(50)
        expect(existsSync(socketPath)).toBe(true)
        const response = await rpc(socketPath, { v: 3, method: 'address' })
        expect(response.ok).toBe(true)
        expect((response.result as { address: string }).address).toBe(SIGNER_ADDRESS)
      } finally {
        process.kill('SIGTERM')
      }
      expect(await process.exited).toBe(0)
      expect(existsSync(socketPath)).toBe(false)
    },
    SPAWN_TIMEOUT_MS
  )
})
