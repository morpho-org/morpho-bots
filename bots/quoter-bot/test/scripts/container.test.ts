import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')

describe('container runtime', () => {
  test('starts the bot directly as the unprivileged node user', () => {
    expect(dockerfile).toContain('RUN /usr/bin/mkdir -p /state && /usr/bin/chown node:node /state')
    expect(dockerfile).toContain('ENV XDG_STATE_HOME=/state')
    expect(dockerfile).toContain('USER node')
    expect(dockerfile).toContain('CMD ["node", "dist/src/index.js", "start", "--verbose"]')
    expect(dockerfile).not.toMatch(/railway/i)
  })

  test('allows Compose deployments to omit inactive reference configuration', () => {
    expect(compose).toContain('REFERENCE_RPC_URL: ${REFERENCE_RPC_URL:-}')
    expect(compose).toContain('REFERENCE_MARKET_ID: ${REFERENCE_MARKET_ID:-}')
    expect(compose).toContain('REFERENCE_LOOKBACK_SECONDS: ${REFERENCE_LOOKBACK_SECONDS:-}')
  })

  test('forwards the accepted loss factor without a default that would mask YAML', () => {
    expect(compose).toContain('ACCEPTED_LOSS_FACTOR: ${ACCEPTED_LOSS_FACTOR:-}')
  })

  test('exposes optional configuration for each supported signer backend', () => {
    expect(compose).toContain('KEY_STORAGE_METHOD: ${KEY_STORAGE_METHOD:-}')
    expect(compose).toContain('MAKER_PRIVATE_KEY: ${MAKER_PRIVATE_KEY:-}')
    expect(compose).toContain('KEYSTORE_PATH: ${KEYSTORE_PATH:-}')
    expect(compose).toContain('KEYSTORE_PASSWORD: ${KEYSTORE_PASSWORD:-}')
    expect(compose).toContain('KEYSTORE_INTERACTIVE: ${KEYSTORE_INTERACTIVE:-}')
    expect(compose).toContain('AWS_KMS_KEY_ID: ${AWS_KMS_KEY_ID:-}')
    expect(compose).toContain('AWS_REGION: ${AWS_REGION:-}')
  })
})
