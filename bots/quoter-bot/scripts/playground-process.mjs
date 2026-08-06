import { spawn } from 'node:child_process'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const ignoreMissingProcess = error => {
  if (error?.code !== 'ESRCH') throw error
}

const waitForChild = child =>
  new Promise(resolve => {
    let spawnError
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, error: spawnError, signal })
    }
    child.once('error', error => {
      spawnError = error
      // Node normally emits close after error. The fallback prevents an injected or unusual
      // ChildProcess implementation from leaving cancellation unbounded.
      queueMicrotask(() => finish(null, null))
    })
    child.once('close', finish)
  })

const runTaskkill = async (spawnProcess, args) => {
  let child
  try {
    child = spawnProcess('taskkill.exe', args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    })
  } catch (error) {
    return { code: null, error, signal: null }
  }
  return waitForChild(child)
}

export const createPortableProcessRunner =
  ({
    platform = process.platform,
    spawnProcess = spawn,
    killProcess = process.kill.bind(process),
    terminationGraceMs = 500,
    forceKillGraceMs = 500
  } = {}) =>
  async ({
    executable,
    args = [],
    cwd,
    env = process.env,
    signal,
    stdio = ['ignore', 'pipe', 'pipe'],
    onProcess = () => {}
  }) => {
    if (signal?.aborted) throw signal.reason

    let child
    let childClosed = false
    let terminationPromise
    let abortRequested = false
    const terminate = () => {
      abortRequested = true
      if (!child || terminationPromise) return
      terminationPromise = (async () => {
        const errors = []
        if (platform === 'win32') {
          const graceful = await runTaskkill(spawnProcess, ['/PID', String(child.pid), '/T'])
          if (graceful.error) errors.push(graceful.error)
          await delay(terminationGraceMs)
          const forced = await runTaskkill(spawnProcess, ['/PID', String(child.pid), '/T', '/F'])
          if (forced.error) errors.push(forced.error)
        } else {
          try {
            killProcess(-child.pid, 'SIGTERM')
          } catch (error) {
            try {
              ignoreMissingProcess(error)
            } catch (unexpected) {
              errors.push(unexpected)
            }
          }
          await delay(terminationGraceMs)
          try {
            killProcess(-child.pid, 'SIGKILL')
          } catch (error) {
            try {
              ignoreMissingProcess(error)
            } catch (unexpected) {
              errors.push(unexpected)
            }
          }
        }
        await Promise.race([childResult, delay(forceKillGraceMs)])
        if (!childClosed) {
          errors.push(
            new Error(`Process tree for ${executable} did not exit after forced termination`)
          )
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, `Failed to terminate process tree for ${executable}`)
        }
      })()
    }

    // Register before spawn and check on both sides so abort cannot fall into a startup gap.
    signal?.addEventListener('abort', terminate, { once: true })
    if (signal?.aborted) {
      signal.removeEventListener('abort', terminate)
      throw signal.reason
    }

    let childResult
    try {
      child = spawnProcess(executable, args, {
        cwd,
        detached: platform !== 'win32',
        env,
        shell: false,
        stdio,
        windowsHide: platform === 'win32'
      })
      childResult = waitForChild(child)
      void childResult.then(() => {
        childClosed = true
      })
      try {
        onProcess(child)
      } catch (callbackError) {
        terminate()
        await childResult
        try {
          await terminationPromise
        } catch (terminationError) {
          throw new AggregateError(
            [callbackError, terminationError],
            `Process registration and cleanup failed for ${executable}`,
            { cause: callbackError }
          )
        }
        throw callbackError
      }
      if (signal?.aborted) terminate()

      let stdout = ''
      let stderr = ''
      if (child.stdout?.on) {
        child.stdout.setEncoding?.('utf8')
        child.stdout.on('data', chunk => {
          stdout += chunk
        })
      }
      if (child.stderr?.on) {
        child.stderr.setEncoding?.('utf8')
        child.stderr.on('data', chunk => {
          stderr += chunk
        })
      }
      const result = await childResult
      if (abortRequested || signal?.aborted) {
        try {
          await terminationPromise
        } catch (terminationError) {
          throw new AggregateError(
            [signal?.reason ?? new Error('Process aborted'), terminationError],
            `Process aborted and cleanup failed for ${executable}`,
            { cause: signal?.reason }
          )
        }
        throw signal?.reason ?? new Error('Process aborted')
      }
      return { ...result, stderr, stdout }
    } finally {
      signal?.removeEventListener('abort', terminate)
    }
  }

export const runPortableProcess = createPortableProcessRunner()
