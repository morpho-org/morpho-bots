import { describe, expect, it } from 'vitest'

import {
  botIds,
  deployTargets,
  loadManifest,
  validateManifest
} from '../../src/release-intent/manifest'

describe('manifest.json', () => {
  const manifest = loadManifest()

  it('lists the four CI-deployable bots', () => {
    expect([...botIds(manifest)]).toEqual([
      'blue-liq',
      'midnight-liq',
      'crossed-books',
      'quoter-bot'
    ])
  })

  it('quoter-bot has no staging environment', () => {
    expect(deployTargets(manifest, 'staging').map(t => t.bot)).toEqual([
      'blue-liq',
      'midnight-liq',
      'crossed-books'
    ])
  })

  it('narrows production targets to the authorized bots, preserving manifest order', () => {
    expect(deployTargets(manifest, 'production', ['quoter-bot', 'blue-liq'])).toEqual([
      {
        bot: 'blue-liq',
        package: '@morpho-org/blue-liquidation',
        stage: 'production',
        environment: 'blue-liq-production',
        publish_image: false
      },
      {
        bot: 'quoter-bot',
        package: '@morpho-org/quoter-bot',
        stage: 'production',
        environment: 'quoter-bot-production',
        publish_image: true
      }
    ])
  })

  it('never publishes an image from staging', () => {
    expect(deployTargets(manifest, 'staging').every(t => !t.publish_image)).toBe(true)
  })
})

describe('validateManifest', () => {
  const entry = { id: 'a-bot', package: '@x/a', environments: { production: 'a-production' } }

  it('accepts a well-formed entry', () => {
    expect(validateManifest([entry])).toEqual([entry])
  })

  it.each([
    { name: 'not an array', input: {}, error: /must be an array/ },
    { name: 'bad id', input: [{ ...entry, id: 'Bad_Id' }], error: /id must match/ },
    { name: 'duplicate id', input: [entry, entry], error: /duplicate id/ },
    { name: 'missing package', input: [{ ...entry, package: '' }], error: /package is required/ },
    {
      name: 'missing production environment',
      input: [{ ...entry, environments: {} }],
      error: /environments.production is required/
    },
    {
      name: 'non-boolean publishImage',
      input: [{ ...entry, publishImage: 'yes' }],
      error: /publishImage must be a boolean/
    }
  ])('rejects $name', ({ input, error }) => {
    expect(() => validateManifest(input)).toThrow(error)
  })
})
