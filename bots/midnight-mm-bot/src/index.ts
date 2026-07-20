import { getChainAddress } from '@morpho-org/morpho-ts';
import { createLogger, railwayContext } from '@repo/bot-kit';
import { delay, ensureError } from '@repo/utils';

import type { PublicClient, Transport } from 'viem';
import { createPublicClient, createWalletClient, fallback, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { loadConfig } from './config';
import { assertMakerReady, publishMarketEpoch } from './publisher';
import { publicationEpochs } from './schedule';

async function assertContract(
  client: PublicClient<Transport, typeof base>,
  address: `0x${string}`,
  label: string
) {
  const code = await client.getCode({ address });
  if (!code || code === '0x') {
    throw new Error(`${label} has no code at ${address}`);
  }
}

async function main() {
  const config = loadConfig();
  const midnight = getChainAddress(config.chainId, 'midnight');
  const mempool = getChainAddress(config.chainId, 'midnightMempool');
  const ratifier = getChainAddress(config.chainId, 'ecrecoverRatifier');

  if (!midnight || !mempool || !ratifier) {
    throw new Error('Base Midnight deployment is incomplete in @morpho-org/morpho-ts');
  }

  const account = privateKeyToAccount(config.makerPrivateKey);
  const transports = [http(config.rpcUrl)];
  if (config.rpcUrlFallback) {
    transports.push(http(config.rpcUrlFallback));
  }

  const transport = transports.length === 1 ? transports[0]! : fallback(transports);
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ account, chain: base, transport });
  const logger = createLogger(config.logLevel, {
    context: {
      bot: 'midnight-mm-bot',
      chainId: config.chainId,
      maker: account.address,
      ...railwayContext()
    }
  });

  await Promise.all([
    assertContract(publicClient, midnight, 'Midnight'),
    assertContract(publicClient, mempool, 'MidnightMempool'),
    assertContract(publicClient, ratifier, 'EcrecoverRatifier')
  ]);

  const context = {
    publicClient,
    walletClient,
    maker: account.address,
    midnight,
    mempool,
    ratifier,
    apiUrl: config.apiUrl,
    ttlSeconds: config.offerTtlSeconds,
    maxPriceDeviationBps: config.maxPriceDeviationBps,
    routerTimeoutMs: config.routerTimeoutMs,
    maxFeeWei: config.maxFeeWei,
    dryRun: config.dryRun,
    logger
  };

  await assertMakerReady(context);
  logger.info('startup', {
    markets: config.markets.map(m => m.marketId),
    midnight,
    mempool,
    ratifier,
    offerTtlSeconds: config.offerTtlSeconds,
    maxPriceDeviationBps: config.maxPriceDeviationBps,
    routerTimeoutMs: config.routerTimeoutMs,
    dryRun: config.dryRun
  });

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
  });

  process.on('SIGTERM', () => {
    stopped = true;
  });

  const published = new Set<string>();
  for (;;) {
    if (stopped) {
      break;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const epochs = publicationEpochs({
      now,
      ttlSeconds: config.offerTtlSeconds,
      leadSeconds: config.publishLeadSeconds
    });

    for (const market of config.markets) {
      for (const epoch of epochs) {
        const key = `${market.marketId.toLowerCase()}:${epoch}`;
        if (published.has(key)) {
          continue;
        }

        try {
          await publishMarketEpoch(context, market, epoch);
          published.add(key);
        } catch (error) {
          logger.error('publish.error', {
            marketId: market.marketId,
            start: epoch,
            detail: ensureError(error).message
          });
        }
      }
    }

    const oldestLiveEpoch = epochs[0]!;
    for (const key of published) {
      const start = BigInt(key.slice(key.lastIndexOf(':') + 1));
      if (start < oldestLiveEpoch) {
        published.delete(key);
      }
    }

    await delay(config.loopIntervalSeconds * 1000);
  }

  logger.info('shutdown');
}

await main().catch(error => {
  console.error(
    JSON.stringify({ level: 'error', event: 'fatal', detail: ensureError(error).message })
  );
  process.exit(1);
});
