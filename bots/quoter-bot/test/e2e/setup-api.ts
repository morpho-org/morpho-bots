import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'

import { ANVIL_DEFAULT_ACCOUNT, MARKET, MARKET_ID } from './constants'

const json = (body: unknown, status = 200) => Response.json(body, { status })
type SetupApiMode = 'ready' | 'books-failed' | 'offers-failed'
let mode: SetupApiMode = 'ready'

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
      data: [{ chain_id: MARKET.chainId, market_id: MARKET_ID, listed: mode !== 'books-failed' }]
    })
  }

  if (pathname.startsWith('/v0/midnight/users/') && pathname.endsWith('/offer-groups')) {
    return json({
      cursor: null,
      data:
        mode === 'offers-failed'
          ? [
              {
                id: `0x${'ab'.repeat(32)}`,
                chain_id: MARKET.chainId,
                consumed: '0',
                max_assets: '1',
                offers: [
                  {
                    market_id: MARKET_ID,
                    maker: ANVIL_DEFAULT_ACCOUNT.address,
                    buy: true,
                    tick: 100,
                    market: { maturity: MARKET.maturity }
                  }
                ]
              }
            ]
          : []
    })
  }

  return json({ message: 'unsupported e2e fixture route' }, 404)
}

export type SetupApiHandle = {
  baseUrl: string
  server: Server
  setMode(mode: SetupApiMode): void
}

// bun's `Bun.serve` took a Web-standard `(Request) => Response` handler directly. Node's http server
// speaks IncomingMessage/ServerResponse, so this adapts between the two and leaves `route` untouched.
// Node's request listener is void-returning, so the async work is wrapped: the promise is consumed
// here and a handler failure answers 500 rather than surfacing as an unhandled rejection.
const toNodeListener =
  (handle: (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void>) =>
  (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    void handle(incoming, outgoing).catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500)
      outgoing.end()
    })
  }

const toNodeHandler =
  (handler: (request: Request) => Response) =>
  async (
    incoming: import('node:http').IncomingMessage,
    outgoing: import('node:http').ServerResponse
  ) => {
    const url = `http://${incoming.headers.host ?? '127.0.0.1'}${incoming.url ?? '/'}`
    const headers = new Headers()
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(key, value)
      else if (Array.isArray(value)) for (const v of value) headers.append(key, v)
    }
    const method = incoming.method ?? 'GET'
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : await new Promise<Buffer>(resolve => {
            const chunks: Buffer[] = []
            incoming.on('data', chunk => chunks.push(chunk as Buffer))
            incoming.on('end', () => resolve(Buffer.concat(chunks)))
          })
    const response = handler(
      new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined })
    )
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  }

/**
 * Starts deterministic Morpho API fixtures for setup-check provider reads.
 *
 * @returns A loopback API origin and the running Node http server.
 * @remarks The responses mirror the pinned market's immutable Base state and intentionally contain
 * no maker offers. Binds port 0 so parallel suites cannot collide. The caller must pass the result to
 * {@link stopSetupApi}.
 */
export const startSetupApi = async (): Promise<SetupApiHandle> => {
  mode = 'ready'
  const server = createServer(toNodeListener(toNodeHandler(route)))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    setMode: value => void (mode = value)
  }
}

/**
 * Stops the deterministic setup API fixture.
 *
 * @param handle - Running fixture handle, or `undefined` when setup failed before server creation.
 * @returns A promise that resolves after active connections close.
 */
export const stopSetupApi = async (handle: SetupApiHandle | undefined) => {
  if (!handle) return
  handle.server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    handle.server.close(error => (error ? reject(error) : resolve()))
  })
}
