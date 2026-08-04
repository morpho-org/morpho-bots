import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requiredDependencies = ['viem', '@repo/bot-kit']

const parsePort = value => {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}; expected an integer from 0 to 65535`)
  }
  return port
}

const parseHost = value => {
  if (!value || value.length > 253 || !/^[\p{L}\p{N}.:[\]-]+$/u.test(value)) {
    throw new Error(`Invalid host: ${value}`)
  }
  return value
}

export const parseServeOptions = (args, env = process.env) => {
  let host = parseHost(env.HOST ?? '127.0.0.1')
  let port = parsePort(env.PORT ?? '4173')
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--host' || argument === '--port') {
      const value = args[++index]
      if (value === undefined) throw new Error(`Missing value for ${argument}`)
      if (argument === '--host') host = parseHost(value)
      else port = parsePort(value)
      continue
    }
    if (argument.startsWith('--host=')) {
      host = parseHost(argument.slice('--host='.length))
      continue
    }
    if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length))
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return { host, port }
}

const unresolvedDependencies = packageRoot => {
  const resolve = createRequire(join(packageRoot, 'package.json')).resolve
  return requiredDependencies.filter(dependency => {
    try {
      resolve(dependency)
      return false
    } catch {
      return true
    }
  })
}

const run = ({ executable, args, cwd, env, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: 'inherit'
    })
    const stop = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', reject)
    child.once('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) {
        reject(signal.reason)
      } else if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `${executable} ${args.join(' ')} failed with ${closeSignal ? `signal ${closeSignal}` : `exit code ${code}`}`
          )
        )
      }
    })
  })

export const ensureFrozenDependencies = async ({
  repoRoot,
  packageRoot,
  executable = 'bun',
  env = process.env,
  signal
}) => {
  let unresolved = unresolvedDependencies(packageRoot)
  if (unresolved.length === 0) return false
  console.log(
    `Workspace dependencies are unresolved from ${packageRoot} (${unresolved.join(', ')}); running bun install --frozen-lockfile...`
  )
  await run({
    executable,
    args: ['install', '--frozen-lockfile'],
    cwd: repoRoot,
    env,
    signal
  })
  unresolved = unresolvedDependencies(packageRoot)
  if (unresolved.length > 0) {
    throw new Error(
      `Frozen install completed but required dependencies remain unresolved from ${packageRoot}: ${unresolved.join(', ')}`
    )
  }
  return true
}
