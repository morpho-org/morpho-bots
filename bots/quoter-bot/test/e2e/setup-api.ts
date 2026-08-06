import type { Server } from 'bun'

import { ECRECOVER_RATIFIER, MARKET, MARKET_ID } from './constants'

const json = (body: unknown, status = 200) => Response.json(body, { status })

const route = (request: Request) => {
  const { pathname } = new URL(request.url)

  if (pathname === '/v0/midnight/books') {
    return json({
      cursor: null,
      data: [
        {
          market_id: MARKET_ID,
          id: MARKET_ID,
          chain_id: MARKET.chainId,
          midnight: MARKET.midnight,
          loan_token: MARKET.loanToken,
          collaterals: MARKET.collaterals,
          maturity: MARKET.maturity,
          rcf_threshold: MARKET.rcfThreshold,
          enter_gate: MARKET.enterGate,
          liquidator_gate: MARKET.liquidatorGate,
          asks: [],
          bids: []
        }
      ]
    })
  }

  if (pathname === '/v0/midnight/markets') {
    return json({
      cursor: null,
      data: [{ chain_id: MARKET.chainId, market_id: MARKET_ID, listed: true }]
    })
  }

  if (pathname.startsWith('/v0/midnight/users/') && pathname.endsWith('/offer-groups')) {
    return json({ cursor: null, data: [] })
  }

  if (pathname === '/v0/config/contracts') {
    return json({
      cursor: null,
      data: [
        {
          chain_id: MARKET.chainId,
          address: ECRECOVER_RATIFIER,
          name: 'ecrecoverRatifier'
        }
      ]
    })
  }

  return json({ message: 'unsupported e2e fixture route' }, 404)
}

export type SetupApiHandle = {
  baseUrl: string
  server: Server<undefined>
}

/**
 * Starts deterministic Morpho and Router API fixtures for setup-check provider reads.
 *
 * @returns A loopback API origin and the running Bun server.
 * @remarks The responses mirror the pinned market's immutable Base state and intentionally contain
 * no maker offers. The caller must pass the result to {@link stopSetupApi}.
 */
export const startSetupApi = (): SetupApiHandle => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: route })
  return { baseUrl: server.url.origin, server }
}

/**
 * Stops the deterministic setup API fixture.
 *
 * @param handle - Running fixture handle, or `undefined` when setup failed before server creation.
 * @returns A promise that resolves after active connections close.
 */
export const stopSetupApi = async (handle: SetupApiHandle | undefined) => {
  if (handle) await handle.server.stop(true)
}
