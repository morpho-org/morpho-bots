import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const processIsLive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export const acquireProductionBuildLock = async (
  packageRoot,
  { deadline = performance.now() + 30_000 } = {}
) => {
  const identity = createHash('sha256').update(packageRoot).digest('hex').slice(0, 16)
  const lockPath = join(tmpdir(), `market-making-playground-build-${identity}.lock`)
  const token = `${process.pid}:${randomUUID()}`

  while (performance.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(token)
      await handle.close()
      let released = false
      return async () => {
        if (released) return
        released = true
        const current = await readFile(lockPath, 'utf8').catch(() => undefined)
        if (current === token) await unlink(lockPath)
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const entry = await lstat(lockPath).catch(() => undefined)
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
        throw new Error(`Production build lock is not a regular file: ${lockPath}`)
      }
      const owner = await readFile(lockPath, 'utf8').catch(() => '')
      const pid = Number(owner.split(':', 1)[0])
      if (Number.isSafeInteger(pid) && pid > 0 && !processIsLive(pid)) {
        await unlink(lockPath).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
        continue
      }
      await wait(20)
    }
  }
  throw new Error(`Timed out waiting for production playground build lock: ${lockPath}`)
}
