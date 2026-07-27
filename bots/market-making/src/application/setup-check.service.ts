import type { Address, Hex } from 'viem'

import { isAddress, isAddressEqual } from 'viem'

type SetupCheckStatus = 'passed' | 'failed' | 'not-required'

type SetupRemediation = string | { to: Address; functionName: string; args: readonly unknown[] }

export type SetupCheck = {
  name:
    | 'chain'
    | 'maker'
    | 'native-balance'
    | 'loan-allowance'
    | 'ratifier'
    | 'books'
    | 'reference'
    | 'offers'
    | 'position-health'
  status: SetupCheckStatus
  observed: unknown
  required: unknown
  remediation?: SetupRemediation
}

export type SetupCheckReport = {
  ready: boolean
  checks: SetupCheck[]
}

export class SetupCheckError extends Error {
  constructor(readonly report: SetupCheckReport) {
    const failed = report.checks.filter(check => check.status === 'failed')
    super(`Setup check failed: ${failed.map(check => check.name).join(', ')}`)
    this.name = 'SetupCheckError'
  }
}

export type SetupCheckConfig = {
  chainId: number
  maker: Address
  midnight: Address
  nativeReserve: bigint
  loanAsset: Address
  maximumLendExposure: bigint
  ratifier: Address
  marketIds: readonly Hex[]
}

export type BookSetup = {
  id: Hex
  allowlisted: boolean
  active: boolean
  loanAsset: Address
  tickSpacing: number
  maturity: bigint
}

export interface SetupStateService {
  getChainId(): Promise<number>
  getCode(address: Address): Promise<Hex | undefined>
  getDerivedMaker(): Promise<Address>
  getNativeBalance(address: Address): Promise<bigint>
  getLoanAllowance(
    owner: Address,
    loanAsset: Address
  ): Promise<{ spender: Address; amount: bigint }>
  getRatifier(
    maker: Address,
    ratifier: Address
  ): Promise<{ listed: boolean; supportsEcrecover: boolean; authorized: boolean }>
  getBook(id: Hex): Promise<BookSetup>
  getLatestTimestamp(): Promise<bigint>
  checkReference(): Promise<{ referenceReadable: boolean; archiveReadable: boolean }>
  inspectOffers(maker: Address): Promise<{
    unknownNamespaces: readonly string[]
    invertedMarketIds: readonly Hex[]
  }>
  checkPositionHealth(): Promise<{ status: 'not-required'; reason: string }>
}

const BASE_CHAIN_ID = 8453

type Captured<T> = { ok: true; value: T } | { ok: false; error: string }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function capture<T>(read: () => Promise<T>): Promise<Captured<T>> {
  try {
    return read().then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error: errorMessage(error) })
    )
  } catch (error) {
    return Promise.resolve({ ok: false, error: errorMessage(error) })
  }
}

function sameAddress(left: string, right: string) {
  return isAddress(left) && isAddress(right) && isAddressEqual(left, right)
}

function result(
  name: SetupCheck['name'],
  passed: boolean,
  observed: unknown,
  required: unknown,
  remediation?: SetupRemediation
): SetupCheck {
  return {
    name,
    status: passed ? 'passed' : 'failed',
    observed,
    required,
    ...(passed || !remediation ? {} : { remediation })
  }
}

function providerFailure(name: SetupCheck['name'], error: string, required: unknown) {
  return result(name, false, { error }, required)
}

function bookProblems(
  requestedId: Hex,
  book: BookSetup,
  config: SetupCheckConfig,
  latestTimestamp: bigint
) {
  const reasons: string[] = []
  if (book.id !== requestedId) reasons.push(`provider returned ${book.id}`)
  if (!book.allowlisted) reasons.push('not allowlisted')
  if (!book.active) reasons.push('inactive')
  if (!sameAddress(book.loanAsset, config.loanAsset)) {
    reasons.push(`unexpected loan asset ${book.loanAsset}`)
  }
  if (book.tickSpacing <= 0) reasons.push('tick spacing is inaccessible')
  if (book.maturity <= latestTimestamp) reasons.push(`matured at ${book.maturity}`)
  return { id: requestedId, reasons }
}

function chainCheck(
  config: SetupCheckConfig,
  chainId: Captured<number>,
  midnightCode: Captured<Hex | undefined>
) {
  const required = { chainId: BASE_CHAIN_ID, midnightCode: 'deployed' }
  if (!chainId.ok) return providerFailure('chain', chainId.error, required)
  if (!midnightCode.ok) return providerFailure('chain', midnightCode.error, required)
  const observed = {
    configured: config.chainId,
    connected: chainId.value,
    midnightCode: midnightCode.value
  }
  const ready =
    config.chainId === BASE_CHAIN_ID &&
    chainId.value === BASE_CHAIN_ID &&
    midnightCode.value !== undefined &&
    midnightCode.value !== '0x'
  return result('chain', ready, observed, required)
}

function booksCheck(
  config: SetupCheckConfig,
  timestamp: Captured<bigint>,
  books: readonly { requestedId: Hex; response: Captured<BookSetup> }[]
) {
  const required = 'all configured books valid'
  if (config.marketIds.length === 0) {
    return result('books', false, [{ id: '(none)', reasons: ['no markets configured'] }], required)
  }
  const invalidBooks = books.flatMap(({ requestedId, response }) => {
    if (!response.ok) return [{ id: requestedId, reasons: [`provider error: ${response.error}`] }]
    if (!timestamp.ok) {
      return [{ id: requestedId, reasons: [`timestamp provider error: ${timestamp.error}`] }]
    }
    const problem = bookProblems(requestedId, response.value, config, timestamp.value)
    return problem.reasons.length === 0 ? [] : [problem]
  })
  return result('books', invalidBooks.length === 0, invalidBooks, required)
}

export class SetupCheckService {
  constructor(
    private readonly state: SetupStateService,
    private readonly config: SetupCheckConfig
  ) {}

  async assertReady() {
    const report = await this.check()
    if (!report.ready) throw new SetupCheckError(report)
    return report
  }

  async check(): Promise<SetupCheckReport> {
    const bookReads = this.config.marketIds.map(requestedId => ({
      requestedId,
      response: capture(() => this.state.getBook(requestedId))
    }))
    const reads = await Promise.all([
      capture(() => this.state.getChainId()),
      capture(() => this.state.getCode(this.config.midnight)),
      capture(() => this.state.getDerivedMaker()),
      capture(() => this.state.getNativeBalance(this.config.maker)),
      capture(() => this.state.getLoanAllowance(this.config.maker, this.config.loanAsset)),
      capture(() => this.state.getRatifier(this.config.maker, this.config.ratifier)),
      capture(() => this.state.getLatestTimestamp()),
      Promise.all(bookReads.map(async book => ({ ...book, response: await book.response }))),
      capture(() => this.state.checkReference()),
      capture(() => this.state.inspectOffers(this.config.maker)),
      capture(() => this.state.checkPositionHealth())
    ])
    const [
      chainId,
      midnightCode,
      derivedMaker,
      nativeBalance,
      allowance,
      ratifier,
      latestTimestamp,
      books,
      reference,
      offers,
      positionHealth
    ] = reads

    const makerCheck = !derivedMaker.ok
      ? providerFailure('maker', derivedMaker.error, this.config.maker)
      : result(
          'maker',
          sameAddress(derivedMaker.value, this.config.maker),
          derivedMaker.value,
          this.config.maker
        )
    const nativeCheck = !nativeBalance.ok
      ? providerFailure('native-balance', nativeBalance.error, this.config.nativeReserve)
      : result(
          'native-balance',
          nativeBalance.value >= this.config.nativeReserve,
          nativeBalance.value,
          this.config.nativeReserve,
          `fund ${this.config.maker} with native token to at least ${this.config.nativeReserve}`
        )
    const allowanceRequired = {
      spender: this.config.midnight,
      minimum: this.config.maximumLendExposure
    }
    const allowanceCheck = !allowance.ok
      ? providerFailure('loan-allowance', allowance.error, allowanceRequired)
      : result(
          'loan-allowance',
          sameAddress(allowance.value.spender, this.config.midnight) &&
            allowance.value.amount >= this.config.maximumLendExposure,
          allowance.value,
          allowanceRequired,
          {
            to: this.config.loanAsset,
            functionName: 'approve',
            args: [this.config.midnight, this.config.maximumLendExposure]
          }
        )
    const ratifierRequired = { listed: true, supportsEcrecover: true, authorized: true }
    const ratifierCheck = !ratifier.ok
      ? providerFailure('ratifier', ratifier.error, ratifierRequired)
      : result(
          'ratifier',
          ratifier.value.listed && ratifier.value.supportsEcrecover && ratifier.value.authorized,
          ratifier.value,
          ratifierRequired,
          ratifier.value.listed && ratifier.value.supportsEcrecover && !ratifier.value.authorized
            ? {
                to: this.config.midnight,
                functionName: 'setIsAuthorized',
                args: [this.config.ratifier, true, this.config.maker]
              }
            : 'select a Router-listed Ecrecover ratifier with the expected deployed surface'
        )
    const referenceRequired = { referenceReadable: true, archiveReadable: true }
    const referenceCheck = !reference.ok
      ? providerFailure('reference', reference.error, referenceRequired)
      : result(
          'reference',
          reference.value.referenceReadable && reference.value.archiveReadable,
          reference.value,
          referenceRequired
        )
    const offersRequired = { unknownNamespaces: [], invertedMarketIds: [] }
    const offersCheck = !offers.ok
      ? providerFailure('offers', offers.error, offersRequired)
      : result(
          'offers',
          offers.value.unknownNamespaces.length === 0 &&
            offers.value.invertedMarketIds.length === 0,
          offers.value,
          offersRequired
        )
    const positionCheck = !positionHealth.ok
      ? providerFailure('position-health', positionHealth.error, 'not-required for V0')
      : {
          name: 'position-health' as const,
          status: positionHealth.value.status,
          observed: positionHealth.value,
          required: 'not-required for V0'
        }

    const checks: SetupCheck[] = [
      chainCheck(this.config, chainId, midnightCode),
      makerCheck,
      nativeCheck,
      allowanceCheck,
      ratifierCheck,
      booksCheck(this.config, latestTimestamp, books),
      referenceCheck,
      offersCheck,
      positionCheck
    ]
    return { ready: checks.every(check => check.status !== 'failed'), checks }
  }
}
