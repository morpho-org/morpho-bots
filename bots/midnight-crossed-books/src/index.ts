import { createApplication } from './bootstrap'

const application = await createApplication()
await application.start()

async function shutdown() {
  await application.stop()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
