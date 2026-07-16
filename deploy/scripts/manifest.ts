// Single source of truth for what each deployable bot ships to Railway. The deploy-only path
// (`deploy-railway.ts`) reads `services`; the full provisioning scripts read `chains` for their
// per-chain config. Keep this in sync with `rindexer.yaml` and `packages/blue-liquidation/src/config.ts`
// when adding a chain (see deploy/blue-rindexer/README.md).

type BotName = 'blue-liq' | 'midnight-liq'

type BotManifest = {
  // Services Railway builds from the repo, deploy order first-to-last. Excludes the managed
  // Postgres (a database, not built from the tree) which the full blue-liq script provisions separately.
  services: readonly string[]
  chains: readonly { chainId: number; service: string }[]
}

export const BOTS = {
  'blue-liq': {
    services: ['rindexer', 'bot-8453', 'bot-4663'],
    chains: [
      { chainId: 8453, service: 'bot-8453' },
      { chainId: 4663, service: 'bot-4663' }
    ]
  },
  'midnight-liq': {
    services: ['bot'],
    chains: [{ chainId: 8453, service: 'bot' }]
  }
} as const satisfies Record<BotName, BotManifest>

export function isBotName(value: string): value is BotName {
  return value === 'blue-liq' || value === 'midnight-liq'
}
