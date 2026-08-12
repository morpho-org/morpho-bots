import { spawnSync } from 'node:child_process'

const STATE_MOUNT_PATH = '/state'

// Railway mounts persistent volumes as root even when an image declares a non-root user. Repair the
// fixed state mount before loading any application code, then permanently drop every root identity.
const chown = spawnSync('chown', ['-R', 'node:node', STATE_MOUNT_PATH], { stdio: 'inherit' })
if (chown.error || chown.status !== 0) {
  throw new Error('Failed to prepare the Railway state volume')
}

process.setgroups([])
process.setgid('node')
process.setuid('node')

await import('../dist/src/index.js')
