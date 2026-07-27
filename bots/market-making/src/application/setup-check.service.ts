type SetupCheckStatus = 'passed' | 'failed' | 'not-required'

type SetupRemediation = string | { to: string; functionName: string; args: readonly unknown[] }

type SetupCheck = {
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

type SetupCheckReport = {
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
  maker: string
  midnight: string
  nativeReserve: bigint
  loanAsset: string
  maximumLendExposure: bigint
  ratifier: string
  marketIds: readonly string[]
}

export type BookSetup = {
  id: string
  allowlisted: boolean
  active: boolean
  loanAsset: string
  tickSpacing: number
  maturity: bigint
}

export interface SetupStateService {
  getChainId(): Promise<number>
  getCode(address: string): Promise<string>
  getDerivedMaker(): Promise<string>
  getNativeBalance(address: string): Promise<bigint>
  getLoanAllowance(owner: string, loanAsset: string): Promise<{ spender: string; amount: bigint }>
  getRatifier(
    maker: string,
    ratifier: string
  ): Promise<{ listed: boolean; supportsEcrecover: boolean; authorized: boolean }>
  getBook(id: string): Promise<BookSetup>
  getLatestTimestamp(): Promise<bigint>
  checkReference(): Promise<{ referenceReadable: boolean; archiveReadable: boolean }>
  inspectOffers(maker: string): Promise<{
    unknownNamespaces: readonly string[]
    invertedMarketIds: readonly string[]
  }>
  checkPositionHealth(): Promise<{ status: 'not-required'; reason: string }>
}

const BASE_CHAIN_ID = 8453

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
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

function bookProblems(book: BookSetup, config: SetupCheckConfig, latestTimestamp: bigint) {
  const reasons: string[] = []
  if (!config.marketIds.includes(book.id)) reasons.push('not configured')
  if (!book.allowlisted) reasons.push('not allowlisted')
  if (!book.active) reasons.push('inactive')
  if (!sameAddress(book.loanAsset, config.loanAsset)) {
    reasons.push(`unexpected loan asset ${book.loanAsset}`)
  }
  if (book.tickSpacing <= 0) reasons.push('tick spacing is inaccessible')
  if (book.maturity <= latestTimestamp) reasons.push(`matured at ${book.maturity}`)
  return { id: book.id, reasons }
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
    const chainId = await this.state.getChainId()
    const midnightCode = await this.state.getCode(this.config.midnight)
    const derivedMaker = await this.state.getDerivedMaker()
    const nativeBalance = await this.state.getNativeBalance(this.config.maker)
    const allowance = await this.state.getLoanAllowance(this.config.maker, this.config.loanAsset)
    const ratifier = await this.state.getRatifier(this.config.maker, this.config.ratifier)
    const latestTimestamp = await this.state.getLatestTimestamp()
    const books = await Promise.all(this.config.marketIds.map(id => this.state.getBook(id)))
    let reference: { referenceReadable: boolean; archiveReadable: boolean } | undefined
    let referenceError: string | undefined
    try {
      reference = await this.state.checkReference()
    } catch (error) {
      referenceError = error instanceof Error ? error.message : String(error)
    }
    const offers = await this.state.inspectOffers(this.config.maker)
    const positionHealth = await this.state.checkPositionHealth()

    const chainReady =
      this.config.chainId === BASE_CHAIN_ID && chainId === BASE_CHAIN_ID && midnightCode !== '0x'
    const makerReady = sameAddress(derivedMaker, this.config.maker)
    const nativeBalanceReady = nativeBalance >= this.config.nativeReserve
    const allowanceReady =
      sameAddress(allowance.spender, this.config.midnight) &&
      allowance.amount >= this.config.maximumLendExposure
    const ratifierReady = ratifier.listed && ratifier.supportsEcrecover && ratifier.authorized
    const invalidBooks = books
      .map(book => bookProblems(book, this.config, latestTimestamp))
      .filter(book => book.reasons.length > 0)
    const referenceReady =
      reference !== undefined && reference.referenceReadable && reference.archiveReadable
    const offersReady =
      offers.unknownNamespaces.length === 0 && offers.invertedMarketIds.length === 0

    const checks: SetupCheck[] = [
      result(
        'chain',
        chainReady,
        { configured: this.config.chainId, connected: chainId, midnightCode },
        {
          chainId: BASE_CHAIN_ID,
          midnightCode: 'deployed'
        }
      ),
      result('maker', makerReady, derivedMaker, this.config.maker),
      result(
        'native-balance',
        nativeBalanceReady,
        nativeBalance,
        this.config.nativeReserve,
        `fund ${this.config.maker} with native token to at least ${this.config.nativeReserve}`
      ),
      result(
        'loan-allowance',
        allowanceReady,
        allowance,
        { spender: this.config.midnight, minimum: this.config.maximumLendExposure },
        {
          to: this.config.loanAsset,
          functionName: 'approve',
          args: [this.config.midnight, this.config.maximumLendExposure]
        }
      ),
      result(
        'ratifier',
        ratifierReady,
        ratifier,
        { listed: true, supportsEcrecover: true, authorized: true },
        ratifier.listed && ratifier.supportsEcrecover && !ratifier.authorized
          ? {
              to: this.config.midnight,
              functionName: 'setIsAuthorized',
              args: [this.config.ratifier, true, this.config.maker]
            }
          : 'select a Router-listed Ecrecover ratifier with the expected deployed surface'
      ),
      result('books', invalidBooks.length === 0, invalidBooks, 'all configured books valid'),
      result('reference', referenceReady, reference ?? { error: referenceError }, {
        referenceReadable: true,
        archiveReadable: true
      }),
      result('offers', offersReady, offers, {
        unknownNamespaces: [],
        invertedMarketIds: []
      }),
      {
        name: 'position-health',
        status: positionHealth.status,
        observed: positionHealth,
        required: 'not-required for V0'
      }
    ]

    return { ready: checks.every(check => check.status !== 'failed'), checks }
  }
}
