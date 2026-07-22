import type { ResolverService } from '../../application/crossed-books-bot.service'
import type { CrossedMatch, PreparedResolution, SimulationResult } from '../../domain/order-book'
import type { ResolverEncoder } from './resolver.encoder'
import type { ResolverTransport } from './resolver.transport'

export class ResolverExecutionService implements ResolverService {
  constructor(
    private readonly transport: ResolverTransport,
    private readonly encoder: ResolverEncoder,
    private readonly minimumProfit: bigint
  ) {}

  async simulate(matches: readonly CrossedMatch[]): Promise<SimulationResult> {
    const firstMatch = matches[0]
    if (!firstMatch) return { status: 'revert', reason: 'empty match plan' }

    const data = this.encoder.encode(matches, this.minimumProfit)
    const simulation = await this.transport.simulate(data)

    if (simulation.status === 'revert') return simulation

    return {
      status: 'ok',
      prepared: {
        marketId: firstMatch.ask.marketId,
        data,
        profit: this.encoder.decodeProfit(simulation.data)
      }
    }
  }

  submit(prepared: PreparedResolution, blockNumber: bigint) {
    return this.transport.submit(prepared, blockNumber)
  }
}
