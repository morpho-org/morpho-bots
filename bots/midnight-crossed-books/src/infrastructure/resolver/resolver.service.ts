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

  /**
   * Hands the simulated resolution to the pending queue for broadcast.
   * @param prepared - Resolver target calldata and market label, exactly as simulation produced it.
   * @returns A promise resolving once the queue has accepted (or declined) the request.
   * @throws `ReadonlyMutationError` when the transport was composed without submission dependencies,
   * and propagates any signer or queue failure the transport raises.
   */
  submit(prepared: PreparedResolution) {
    return this.transport.submit(prepared)
  }
}
