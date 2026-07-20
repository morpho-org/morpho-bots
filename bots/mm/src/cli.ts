import type { Hash, Hex, TransactionReceipt } from 'viem'

import {
  EcrecoverRatifierUtils,
  Payload,
  Tree,
  fetchAccrualPosition,
  midnightAbi
} from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  http,
  maxUint128
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { CancelCommand, MakeCommand } from './args'

import { confirm } from './confirm'
import { buildOfferGroups } from './offers'
import { aprBpsToTick } from './rates'
import { addLogicalGroup, getLogicalGroup } from './registry'
import { readRegistry, storagePaths, writeJson } from './storage'

const OFFER_LIFETIME = 7n * 24n * 60n * 60n
const MINIMUM_OFFER_LIFETIME = 60n

export async function runMake(command: MakeCommand) {
  const clients = makeClients(command)
  const maker = clients.account.address
  const now = BigInt(Math.floor(Date.now() / 1000))
  const position = await fetchAccrualPosition(clients.publicClient, {
    marketId: command.marketId,
    user: maker
  })
  const market = position.market
  const accrued = position.accrueInterest(now)
  const midnight = market.params.midnight
  const [balance, allowance, decimals, symbol] = await Promise.all([
    clients.publicClient.readContract({
      address: market.params.loanToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [maker]
    }),
    clients.publicClient.readContract({
      address: market.params.loanToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [maker, midnight]
    }),
    clients.publicClient.readContract({
      address: market.params.loanToken,
      abi: erc20Abi,
      functionName: 'decimals'
    }),
    clients.publicClient.readContract({
      address: market.params.loanToken,
      abi: erc20Abi,
      functionName: 'symbol'
    })
  ])
  const buyAssets = balance < allowance ? balance : allowance
  const sellAssets = accrued.faceValue
  const expiry = min(now + OFFER_LIFETIME, market.params.maturity - 1n)
  if (expiry - now < MINIMUM_OFFER_LIFETIME)
    throw new Error('Market matures too soon to post offers')

  const bidBps = command.target - Math.floor(command.spread / 2)
  const askBps = command.target + Math.ceil(command.spread / 2)
  const timeToMaturity = market.params.maturity - now
  const groups = buildOfferGroups({
    market,
    maker,
    ratifier: getChainAddress(command.chainId, 'ecrecoverRatifier'),
    buyTick: aprBpsToTick({ aprBps: bidBps, timeToMaturity, tickSpacing: market.tickSpacing }),
    sellTick: aprBpsToTick({ aprBps: askBps, timeToMaturity, tickSpacing: market.tickSpacing }),
    expiry,
    buyAssets,
    sellAssets,
    continuousFeeCap: BigInt(market.continuousFee),
    tickSpacing: market.tickSpacing
  })
  const tree = Tree.create([groups.buy, groups.sell])
  const paths = storagePaths()
  const registry = await readRegistry(paths.registry)
  const logicalGroupId = command.groupId ?? unusedGroupId(registry)
  if (registry[logicalGroupId])
    throw new Error(`Logical group "${logicalGroupId}" already exists; choose another id`)

  const summary = {
    logicalGroupId,
    chainId: command.chainId,
    marketId: command.marketId,
    maker,
    token: { address: market.params.loanToken, symbol, decimals },
    balance: { raw: balance, formatted: formatUnits(balance, decimals) },
    allowance: { raw: allowance, formatted: formatUnits(allowance, decimals) },
    accruedCredit: { raw: accrued.faceValue, formatted: formatUnits(accrued.faceValue, decimals) },
    targetBps: command.target,
    spreadBps: command.spread,
    bidBps,
    askBps,
    buy: describeOffer(groups.buy.offers[0]!, groups.buy.id),
    sell: describeOffer(groups.sell.offers[0]!, groups.sell.id),
    treeRoot: tree.root,
    dryRun: command.dryRun
  }
  printSummary(summary)
  if (!(await confirm('Sign these two Midnight offers?'))) return { cancelled: true as const }

  await tree.mempoolValidate({ chainId: command.chainId })
  const items = await EcrecoverRatifierUtils.ratify({
    tree,
    client: clients.walletClient,
    account: clients.account
  })
  const payload = await Payload.encode(items)
  await tree.mempoolValidate({
    chainId: command.chainId,
    ratification: {
      type: 'ecrecover',
      account: maker,
      signature: ratifierSignature(items[0]!.ratifierData)
    }
  })

  const artifactPath = join(paths.makes, `${safeName(logicalGroupId)}.json`)
  const protocolGroups = [groups.buy.id, groups.sell.id] as const
  const artifact = {
    type: 'make',
    createdAt: new Date().toISOString(),
    summary,
    signedPostedOffers: items.map(item => ({ offer: item.offer, ratifierData: item.ratifierData })),
    ratifierData: items.map(item => item.ratifierData),
    payload,
    receipt: null as TransactionReceipt | null
  }
  const nextRegistry = addLogicalGroup(registry, logicalGroupId, {
    chainId: command.chainId,
    maker,
    protocolGroups,
    artifact: artifactPath,
    createdAt: artifact.createdAt
  })
  await writeJson(artifactPath, artifact)
  await writeJson(paths.registry, nextRegistry)

  if (command.dryRun) return { logicalGroupId, artifactPath, dryRun: true as const }
  if (!(await confirm('Submit the signed payload to the onchain Midnight mempool now?'))) {
    return { logicalGroupId, artifactPath, submitted: false as const }
  }

  const hash = await clients.walletClient.sendTransaction({
    account: clients.account,
    chain: clients.chain,
    to: getChainAddress(command.chainId, 'midnightMempool'),
    data: payload
  })
  artifact.receipt = await clients.publicClient.waitForTransactionReceipt({ hash })
  await writeJson(artifactPath, artifact)
  return { logicalGroupId, artifactPath, hash, receipt: artifact.receipt }
}

export async function runCancel(command: CancelCommand) {
  const clients = makeClients(command)
  const paths = storagePaths()
  const registry = await readRegistry(paths.registry)
  const entry = getLogicalGroup(registry, command.groupId)
  if (entry.chainId !== command.chainId)
    throw new Error(`Logical group belongs to chain ${entry.chainId}`)
  if (entry.maker !== clients.account.address)
    throw new Error(`Credentials do not control maker ${entry.maker}`)

  const summary = {
    logicalGroupId: command.groupId,
    chainId: command.chainId,
    maker: entry.maker,
    protocolGroups: entry.protocolGroups,
    dryRun: command.dryRun
  }
  printSummary(summary)
  const artifactPath = join(paths.cancels, `${safeName(command.groupId)}-${Date.now()}.json`)
  const artifact = {
    type: 'cancel',
    createdAt: new Date().toISOString(),
    summary,
    receipts: [] as TransactionReceipt[]
  }

  if (command.dryRun) {
    await writeJson(artifactPath, artifact)
    return { artifactPath, dryRun: true as const }
  }
  if (!(await confirm('Revoke every protocol group in this logical group onchain?'))) {
    return { cancelled: true as const }
  }

  for (const group of entry.protocolGroups) {
    const hash = await clients.walletClient.writeContract({
      account: clients.account,
      chain: clients.chain,
      address: getChainAddress(command.chainId, 'midnight'),
      abi: midnightAbi,
      functionName: 'setConsumed',
      args: [group, maxUint128, entry.maker]
    })
    artifact.receipts.push(await clients.publicClient.waitForTransactionReceipt({ hash }))
    await writeJson(artifactPath, artifact)
  }
  const updated = {
    ...registry,
    [command.groupId]: {
      ...entry,
      cancelArtifacts: [...(entry.cancelArtifacts ?? []), artifactPath]
    }
  }
  await writeJson(paths.registry, updated)
  return { artifactPath, receipts: artifact.receipts }
}

function makeClients(command: Pick<MakeCommand, 'chainId' | 'privateKey' | 'rpcUrl'>) {
  const chain = defineChain({
    id: command.chainId,
    name: `chain-${command.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [command.rpcUrl] } }
  })
  const account = privateKeyToAccount(command.privateKey)
  const transport = http(command.rpcUrl)
  return {
    chain,
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport, account })
  }
}

function describeOffer(
  offer: { buy: boolean; tick: bigint; maxAssets: bigint; reduceOnly: boolean },
  group: Hash
) {
  return {
    side: offer.buy ? 'buy' : 'sell',
    tick: offer.tick,
    maxAssets: offer.maxAssets,
    reduceOnly: offer.reduceOnly,
    protocolGroupId: group
  }
}

function ratifierSignature(ratifierData: Hex) {
  return EcrecoverRatifierUtils.decodeRatifierData(ratifierData).signature
}

function unusedGroupId(registry: Record<string, unknown>) {
  let id = randomUUID()
  while (registry[id]) id = randomUUID()
  return id
}

function safeName(value: string) {
  return encodeURIComponent(value).replaceAll('%', '_')
}

function min(a: bigint, b: bigint) {
  return a < b ? a : b
}

function printSummary(value: unknown) {
  console.log(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
  )
}
