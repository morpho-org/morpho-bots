import type { IMarket } from '@morpho-org/midnight-sdk';
import {
  AccrualPosition,
  EcrecoverRatifierUtils,
  fetchMarket,
  midnightAbi,
  Payload
} from '@morpho-org/midnight-sdk';
import type { Logger } from '@repo/bot-kit';

import type { Account, Address, PublicClient, Transport, WalletClient } from 'viem';
import { erc20Abi } from 'viem';
import { base } from 'viem/chains';

import type { MarketQuoteConfig } from './config';
import { buildOfferTree } from './offers';

type PublishContext = {
  publicClient: PublicClient<Transport, typeof base>;
  walletClient: WalletClient<Transport, typeof base, Account>;
  maker: Address;
  midnight: Address;
  mempool: Address;
  ratifier: Address;
  apiUrl: string;
  ttlSeconds: number;
  maxFeeWei: bigint;
  dryRun: boolean;
  logger: Logger;
};

export async function assertFunding(
  context: Pick<PublishContext, 'publicClient' | 'maker' | 'midnight'>,
  market: IMarket,
  marketId: `0x${string}`,
  maxUnits: bigint,
  timestamp: bigint
) {
  const [balance, allowance, position] = await Promise.all([
    context.publicClient.readContract({
      address: market.params.loanToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [context.maker]
    }),
    context.publicClient.readContract({
      address: market.params.loanToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [context.maker, context.midnight]
    }),
    context.publicClient.readContract({
      address: context.midnight,
      abi: midnightAbi,
      functionName: 'position',
      args: [marketId, context.maker]
    })
  ]);
  const accruedCredit = new AccrualPosition(
    {
      credit: position[0],
      pendingFee: position[1],
      lastLossFactor: position[2],
      lastAccrual: position[3],
      debt: position[4],
      collateralBitmap: position[5],
      collateral: []
    },
    market
  ).accrueInterest(timestamp).credit;

  if (balance < maxUnits) {
    throw new Error(`maker loan-token balance ${balance} is below maxUnits ${maxUnits}`);
  }

  if (allowance < maxUnits) {
    throw new Error(`Midnight loan-token allowance ${allowance} is below maxUnits ${maxUnits}`);
  }

  if (accruedCredit < maxUnits) {
    throw new Error(`maker accrued credit ${accruedCredit} is below maxUnits ${maxUnits}`);
  }
}

export async function assertMakerReady(context: PublishContext) {
  const authorized = await context.publicClient.readContract({
    address: context.midnight,
    abi: midnightAbi,
    functionName: 'isAuthorized',
    args: [context.maker, context.ratifier]
  });

  if (!authorized) {
    throw new Error(
      `maker ${context.maker} has not authorized EcrecoverRatifier ${context.ratifier}`
    );
  }
}

export async function publishMarketEpoch(
  context: PublishContext,
  config: MarketQuoteConfig,
  start: bigint
) {
  const market = await fetchMarket(context.publicClient, { marketId: config.marketId });
  if (market.params.midnight.toLowerCase() !== context.midnight.toLowerCase()) {
    throw new Error(
      `market ${config.marketId} belongs to unexpected Midnight ${market.params.midnight}`
    );
  }

  const expiry = start + BigInt(context.ttlSeconds) - 1n;
  if (expiry >= market.params.maturity) {
    throw new Error(`market ${config.marketId} matures before offer epoch expiry ${expiry}`);
  }

  await assertFunding(context, market, config.marketId, config.maxUnits, expiry);
  const { tree, bidGroup, askGroup } = buildOfferTree({
    market,
    config,
    maker: context.maker,
    ratifier: context.ratifier,
    start,
    expiry
  });

  await tree.mempoolValidate({ chainId: 8453, apiUrl: context.apiUrl });
  const signature = await EcrecoverRatifierUtils.sign({
    tree,
    client: context.walletClient,
    account: context.maker
  });

  await tree.mempoolValidate({
    chainId: 8453,
    apiUrl: context.apiUrl,
    ratification: { type: 'ecrecover', account: context.maker, signature }
  });

  const items = await EcrecoverRatifierUtils.ratify({ tree, account: context.maker, signature });
  const payload = await Payload.encode(items);
  const fields = {
    marketId: config.marketId,
    root: tree.root,
    start,
    expiry,
    offers: tree.offers.length,
    bidGroup: bidGroup.id,
    askGroup: askGroup.id,
    payloadBytes: (payload.length - 2) / 2
  };

  if (context.dryRun) {
    context.logger.info('publish.dry_run', fields);
    return { ...fields, transactionHash: null };
  }

  const fees = await context.publicClient.estimateFeesPerGas();
  if (fees.maxFeePerGas !== undefined && fees.maxFeePerGas > context.maxFeeWei) {
    throw new Error(
      `maxFeePerGas ${fees.maxFeePerGas} exceeds configured ceiling ${context.maxFeeWei}`
    );
  }

  const transactionHash = await context.walletClient.sendTransaction({
    account: context.maker,
    chain: base,
    to: context.mempool,
    data: payload,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas
  });

  const receipt = await context.publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== 'success') {
    throw new Error(`mempool transaction reverted: ${transactionHash}`);
  }

  context.logger.info('publish.success', {
    ...fields,
    transactionHash,
    blockNumber: receipt.blockNumber
  });

  return { ...fields, transactionHash };
}
