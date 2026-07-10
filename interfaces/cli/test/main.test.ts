import type { SignerServer } from '@repo/signer'

import { createSignerServer, parsePolicy } from '@repo/signer'
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// The CLI's exit-code contract is what loop/cron wrappers script against, so exercise the real
// binary end-to-end: spawn `bun src/main.ts …` from the package dir (whose bunfig preloads the
// soltag lens plugins, mirroring how operators and the Docker image invoke it).
const CLI_DIR = join(import.meta.dir, '..')

// Cold bun spawns take ~3s on CI runners (and the init test spawns twice), so the 5s default flakes.
const SPAWN_TIMEOUT_MS = 30_000

// A config that passes the queue's config gate (chain/rpc/key) without a reachable chain — RPC is at
// an unreachable loopback port. The zero-work queue pass must never dial it (fast path); the
// lock-held pass exits before any chain read.
const VALID_QUEUE_ENV = {
  CHAIN_ID: '8453',
  RPC_URL: 'http://127.0.0.1:1',
  LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bun', 'src/main.ts', ...args], {
    cwd: CLI_DIR,
    env: {
      ...process.env,
      MORPHO_BOTS_HOME: mkdtempSync(join(tmpdir(), 'morpho-bots-test-')),
      ...env
    }
  })
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString()
  }
}

describe('morpho-bots exit codes', () => {
  it(
    'exits 0 for --help and lists the top-level signer command',
    () => {
      const { code, stdout } = run(['--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('signer')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'lists the op commands in a domain’s --help with source/transform labels',
    () => {
      const { code, stdout } = run(['blue', '--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('unhealthy-positions')
      expect(stdout).toContain('liquidate')
      expect(stdout).toContain('queue')
      // The flat namespace stays legible because each op is labeled by its kind.
      expect(stdout).toContain('[source]')
      expect(stdout).toContain('[transform]')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for an unknown command (usage error — wrappers must stop)',
    () => {
      expect(run(['bogus']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for an unknown op (usage error — wrappers must stop)',
    () => {
      // Only the manifest's op names are registered, so an unlisted one is an unknown subcommand.
      expect(run(['midnight', 'frobnicate']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for the removed `sense` verb (replaced by op commands)',
    () => {
      // `sense`/`act` verbs were replaced by op names, so `sense` is now an unknown subcommand.
      expect(run(['blue', 'sense']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for a source op with no usable config, with a startup.error line',
    () => {
      const { code, stderr } = run(['blue', 'unhealthy-positions'])
      expect(code).toBe(2)
      expect(stderr).toContain('startup.error')
      expect(stderr).toContain('no chain configured')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for a transform op with no usable config',
    () => {
      expect(run(['blue', 'liquidate']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for queue with no usable config',
    () => {
      expect(run(['blue', 'queue']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 0 for a queue whose lock is already held by a live pid',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'morpho-bots-test-'))
      // Pre-place the lock held by THIS (live) process, mirroring an overlapping queue.
      mkdirSync(join(home, 'locks'), { recursive: true })
      writeFileSync(
        join(home, 'locks', 'blue-8453.lock'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() })
      )
      const { code, stdout } = run(['blue', 'queue'], {
        ...VALID_QUEUE_ENV,
        MORPHO_BOTS_HOME: home
      })
      expect(code).toBe(0)
      // The lock-held pass emits no wire records (it only drains stdin and skips).
      expect(stdout.trim()).toBe('')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 0 for a queue with empty stdin and empty state (zero-work fast path, no RPC)',
    () => {
      // No lock held, nothing on stdin, no prior queue state → the fast path skips the head fetch
      // (and thus every RPC call), so the unreachable RPC is never dialed and the pass completes.
      const { code } = run(['blue', 'queue'], VALID_QUEUE_ENV)
      expect(code).toBe(0)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'init scaffolds the home dir and a second run keeps existing files',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'morpho-bots-test-'))
      const first = run(['init'], { MORPHO_BOTS_HOME: home })
      expect(first.code).toBe(0)
      expect(first.stdout).toContain('created')
      const second = run(['init'], { MORPHO_BOTS_HOME: home })
      expect(second.code).toBe(0)
      expect(second.stdout).toContain('kept')
    },
    SPAWN_TIMEOUT_MS
  )
})

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const SIGNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const SIGNER_ADDRESS = privateKeyToAccount(SIGNER_KEY).address
const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)

// A minimal default-deny policy the daemon can start on; the `address` handshake never touches it.
const POLICY = {
  version: 1,
  rules: [
    {
      name: 'test',
      chainIds: [8453],
      to: [EXECUTOR],
      maxFeePerGasWei: '300000000000',
      maxGasLimit: '15000000'
    }
  ]
}

// A short-prefixed temp home so `<home>/signer.sock` stays under the ~104-byte sun_path cap.
function shortHome(): string {
  return mkdtempSync(join(tmpdir(), 's-'))
}

// One request line in, one response line out over a fresh connection (the netcat-equivalent probe).
function rpc(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, idx)))
    })
    socket.on('error', reject)
  })
}

describe('morpho-bots signer command', () => {
  it(
    'exits 2 when SIGNER_PRIVATE_KEY is missing',
    () => {
      const { code, stderr } = run(['signer'], { MORPHO_BOTS_HOME: shortHome() })
      expect(code).toBe(2)
      expect(stderr).toContain('SIGNER_PRIVATE_KEY')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 when the policy file is missing (key present)',
    () => {
      // No signer-policy.json in the fresh home → the daemon refuses to start.
      const { code, stderr } = run(['signer'], {
        MORPHO_BOTS_HOME: shortHome(),
        SIGNER_PRIVATE_KEY: SIGNER_KEY
      })
      expect(code).toBe(2)
      expect(stderr).toContain('signer policy')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'listens, answers an address request over the socket, and exits 0 on SIGTERM (unlinking the socket)',
    async () => {
      const home = shortHome()
      writeFileSync(join(home, 'signer-policy.json'), JSON.stringify(POLICY))
      const sock = join(home, 'signer.sock')
      const proc = Bun.spawn(['bun', 'src/main.ts', 'signer'], {
        cwd: CLI_DIR,
        env: { ...process.env, MORPHO_BOTS_HOME: home, SIGNER_PRIVATE_KEY: SIGNER_KEY },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      try {
        // Poll for the socket to appear (cold bun spawn) rather than sleeping a fixed time.
        for (let i = 0; i < 200 && !existsSync(sock); i += 1) await Bun.sleep(50)
        expect(existsSync(sock)).toBe(true)

        const response = await rpc(sock, { v: 1, id: '1', method: 'address' })
        expect((response.result as { address: string }).address).toBe(SIGNER_ADDRESS)
      } finally {
        proc.kill('SIGTERM')
      }
      expect(await proc.exited).toBe(0)
      // close() unlinks the socket on a clean shutdown.
      expect(existsSync(sock)).toBe(false)
    },
    SPAWN_TIMEOUT_MS
  )
})

describe('morpho-bots queue via the signing agent', () => {
  let servers: SignerServer[] = []

  afterEach(async () => {
    await Promise.all(servers.map(s => s.close()))
    servers = []
  })

  async function liveAgent(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 's-'))
    const socketPath = join(dir, 'a.sock')
    const noop = () => undefined
    const server = createSignerServer({
      socketPath,
      account: privateKeyToAccount(SIGNER_KEY),
      policy: parsePolicy(POLICY),
      log: { info: noop, warn: noop, error: noop }
    })
    await server.listen()
    servers.push(server)
    return socketPath
  }

  // Spawn the queue ASYNC (not spawnSync): the live agent listens on THIS process's event loop, so a
  // synchronous spawn would block it and the cross-process handshake would deadlock. `stdin: 'ignore'`
  // gives an empty (non-TTY) stdin → the zero-work fast path. RPC is an unreachable loopback the
  // zero-work pass must never dial once the handshake succeeds.
  const AGENT_QUEUE_ENV = { CHAIN_ID: '8453', RPC_URL: 'http://127.0.0.1:1' }

  async function runQueueAsync(env: Record<string, string>) {
    const proc = Bun.spawn(['bun', 'src/main.ts', 'blue', 'queue'], {
      cwd: CLI_DIR,
      env: { ...process.env, MORPHO_BOTS_HOME: mkdtempSync(join(tmpdir(), 's-')), ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    return { code, stderr }
  }

  it(
    'exits 1 when SIGNER_SOCKET points at a dead socket and no key is set (transient, loop retries)',
    async () => {
      const { code } = await runQueueAsync({
        ...AGENT_QUEUE_ENV,
        SIGNER_SOCKET: join(mkdtempSync(join(tmpdir(), 's-')), 'dead.sock')
      })
      expect(code).toBe(1)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 when the live agent address disagrees with LIQUIDATOR_ADDRESS',
    async () => {
      const socketPath = await liveAgent()
      const { code, stderr } = await runQueueAsync({
        ...AGENT_QUEUE_ENV,
        SIGNER_SOCKET: socketPath,
        LIQUIDATOR_ADDRESS: `0x${'34'.repeat(20)}`
      })
      expect(code).toBe(2)
      expect(stderr).toContain('does not match LIQUIDATOR_ADDRESS')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 0 (zero-work) when the live agent address matches LIQUIDATOR_ADDRESS',
    async () => {
      const socketPath = await liveAgent()
      const { code } = await runQueueAsync({
        ...AGENT_QUEUE_ENV,
        SIGNER_SOCKET: socketPath,
        LIQUIDATOR_ADDRESS: SIGNER_ADDRESS
      })
      expect(code).toBe(0)
    },
    SPAWN_TIMEOUT_MS
  )
})
