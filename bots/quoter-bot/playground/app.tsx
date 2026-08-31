import type { ErrorInfo, ReactNode } from 'react'

import { useForm } from '@tanstack/react-form'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable
} from '@tanstack/react-table'
import React, { Component, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { FieldDefinition } from './field-visibility.utils'
import type {
  AssetFormatter,
  BootstrapGraphicModel,
  BootstrapInput,
  LadderGraphicModel,
  LadderInput,
  PlaygroundState
} from './model'

import {
  DEFAULT_ASSET_DECIMALS,
  MAXIMUM_ASSET_DECIMALS,
  assetFormatter,
  resolveDecimals
} from './asset-format.utils'
import { CollectionImportError } from './collection-import.error'
import {
  maturityPremiumSelection,
  visibleFields,
  withoutMaximumPremium
} from './field-visibility.utils'
import {
  BOOTSTRAP_FIELDS,
  LADDER_FIELDS,
  clampPlotPercent,
  createDefaultBootstrap,
  createDefaultLadder,
  createDefaultPlaygroundState,
  createPlaygroundShareUrl,
  decodePlaygroundFragment,
  deriveBootstrapGraphicModels,
  encodePlaygroundFragment,
  exportBootstrapJson,
  exportBootstrapMarketsEnvValue,
  exportLadderJson,
  exportLadderMarketsEnvValue,
  generateLadderGraphicModels,
  parseCollectionsImport,
  validateBootstrapCollection,
  validateLadderCollection,
  validatePlaygroundState
} from './model'
import { playgroundErrorMessage } from './playground-error.utils'
import { PlaygroundInitializationError } from './playground-initialization.error'

type CollectionKind = keyof PlaygroundState
type ExportFormat = 'bootstrap-json' | 'bootstrap-string' | 'ladder-json' | 'ladder-string'
type Status = { message: string; status?: 'ok' | 'error' }
const EXPORT_FORMATS: ExportFormat[] = [
  'bootstrap-json',
  'bootstrap-string',
  'ladder-json',
  'ladder-string'
]
const EXPORT_LABELS: Record<ExportFormat, string> = {
  'bootstrap-json': 'Bootstrap JSON',
  'bootstrap-string': 'Bootstrap JSON string',
  'ladder-json': 'Ladder JSON',
  'ladder-string': 'Ladder JSON string'
}
const newId = (() => {
  let sequence = 0
  return (kind: CollectionKind) => `${kind}-${++sequence}`
})()
const idsFor = (state: PlaygroundState) => ({
  bootstrap: state.bootstrap.map(() => newId('bootstrap')),
  ladder: state.ladder.map(() => newId('ladder'))
})
const nextMarketId = (items: readonly { marketId: string }[]) => {
  const existing = new Set(items.map(item => item.marketId.toLowerCase()))
  for (let value = 1n; ; value++) {
    const candidate = `0x${value.toString(16).padStart(64, '0')}`
    if (!existing.has(candidate)) return candidate
  }
}
const initial = () => {
  try {
    return { state: decodePlaygroundFragment(window.location.hash), error: '' }
  } catch (error) {
    return {
      state: createDefaultPlaygroundState(),
      error: `Share URL ignored: ${playgroundErrorMessage(error)}`
    }
  }
}

const columnHelper = createColumnHelper<LadderGraphicModel['rungs'][number]>()
/** Renders one display amount while keeping its exact raw integer reachable on hover. */
const amountCell = (rawAmount: string, display: string) => (
  <span title={rawAmount} data-raw-amount={rawAmount}>
    {display}
  </span>
)
const rungColumnsFor = (format: AssetFormatter) => [
  columnHelper.accessor('sideLabel', { header: 'Side', cell: info => info.getValue() }),
  columnHelper.accessor('rateBps', { header: 'Rate (BPS)', cell: info => info.getValue() }),
  columnHelper.accessor('allocationAssets', {
    header: 'Allocation',
    cell: info => amountCell(info.getValue(), format(info.getValue()))
  }),
  columnHelper.accessor('offerMaxAssets', {
    header: 'Offer maxAssets',
    cell: info => amountCell(info.getValue(), format(info.getValue()))
  })
]

const RungTable = ({
  format,
  graphic,
  index
}: {
  format: AssetFormatter
  graphic: LadderGraphicModel
  index: number
}) => {
  const columns = useMemo(() => rungColumnsFor(format), [format])
  const table = useReactTable({
    data: graphic.rungs,
    columns,
    getCoreRowModel: getCoreRowModel()
  })
  return (
    <table className="semantic-table" aria-labelledby={`ladder-title-${index}`}>
      <caption>
        Ladder rate, allocation, and offer cap correspondence; hover an amount for its exact raw
        value
      </caption>
      <thead>
        {table.getHeaderGroups().map(group => (
          <tr key={group.id}>
            {group.headers.map(header => (
              <th key={header.id} scope="col">
                {flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map(row => (
          <tr key={row.id}>
            {row.getVisibleCells().map(cell => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const BootstrapGraphic = ({
  format,
  graphic,
  index
}: {
  format: AssetFormatter
  graphic: BootstrapGraphicModel
  index: number
}) => {
  const title = `Bootstrap market ${index + 1}`
  const minimum = BigInt(graphic.minimumRateBps)
  const maximum = BigInt(graphic.maximumRateBps)
  const range = maximum - minimum || 1n
  const position = (value: string) => Number(((BigInt(value) - minimum) * 10_000n) / range) / 100
  const quoteText =
    graphic.maximumQuotedRateBps === undefined
      ? `quote ${graphic.quotedRateBps} BPS`
      : `quote range ${graphic.quotedRateBps} to ${graphic.maximumQuotedRateBps} BPS across maturities`
  const description = `${title}, market ${graphic.marketId}. Configured range ${graphic.minimumRateBps} to ${graphic.maximumRateBps} BPS. Deterministic reference ${graphic.referenceRateBps} BPS produces ${quoteText}. Credit target ${format(graphic.creditTarget)}, completion threshold ${format(graphic.acceptedCredit)}, pending-offer cap ${format(graphic.offerSize)}. ${graphic.callouts.map(item => `${item.label}: ${item.value}.`).join(' ')} Explicitly no live offers or balances.`
  return (
    <article className="preview-card bootstrap-preview" data-preview="bootstrap">
      <h3 id={`bootstrap-title-${index}`}>{title}</h3>
      <code>{graphic.marketId}</code>
      <figure role="img" aria-labelledby={`bootstrap-title-${index}`} aria-label={description}>
        <div className="rate-track" aria-hidden="true">
          <span className="range-label range-label--min">{graphic.minimumRateBps} BPS min</span>
          <span className="range-label range-label--max">{graphic.maximumRateBps} BPS max</span>
          <i
            className="reference-marker"
            style={{ left: `${position(graphic.referenceRateBps)}%` }}
          >
            <b>Reference {graphic.referenceRateBps} BPS</b>
          </i>
          <i className="quote-marker" style={{ left: `${position(graphic.quotedRateBps)}%` }}>
            <b>Quote {graphic.quotedRateBps} BPS</b>
          </i>
          {graphic.maximumQuotedRateBps === undefined ? null : (
            <i
              className="quote-marker quote-marker--maximum"
              style={{ left: `${position(graphic.maximumQuotedRateBps)}%` }}
            >
              <b>Far maturity {graphic.maximumQuotedRateBps} BPS</b>
            </i>
          )}
        </div>
        <figcaption>◆ Reference · ● Quote · values are also in the tiles below</figcaption>
      </figure>
      <dl className="callouts">
        {graphic.callouts.map(item => (
          <div key={item.label}>
            <dt>
              {item.label}
              {item.parameters.length === 0 ? null : <code>{item.parameters.join(' · ')}</code>}
            </dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

const ReferenceStrip = ({ graphic, index }: { graphic: LadderGraphicModel; index: number }) => {
  const { band, strip, totalRungs } = graphic.referenceResponse
  const description = `Reference response for ladder market ${index + 1}. Across references ${graphic.minimumRateBps} to ${graphic.maximumRateBps} BPS, ${
    band === undefined
      ? 'every reference pins at least one rung to a hard bound'
      : `references ${band.lowestRateBps} to ${band.highestRateBps} BPS pin no rung`
  }. Taller bars pin more of the ${totalRungs} rungs.`
  return (
    <figure className="reference-strip" role="img" aria-label={description}>
      <div className="strip-track" aria-hidden="true">
        {strip.map(point => (
          <i
            key={point.referenceRateBps}
            className={point.pinnedRungs === 0 ? 'strip-bar strip-bar--clean' : 'strip-bar'}
            style={{ height: `${Math.max(6, (point.pinnedRungs / totalRungs) * 100)}%` }}
            title={`Reference ${point.referenceRateBps} BPS: ${point.pinnedRungs}/${totalRungs} rungs pinned`}
          />
        ))}
      </div>
      <figcaption>
        Rungs pinned to a bound by reference · {graphic.minimumRateBps}–{graphic.maximumRateBps} BPS
      </figcaption>
    </figure>
  )
}

const LadderGraphic = ({
  format,
  graphic,
  index
}: {
  format: AssetFormatter
  graphic: LadderGraphicModel
  index: number
}) => {
  const maturityText =
    graphic.maximumCenterRateBps === undefined
      ? ''
      : ` The maturity premium raises the quote to ${graphic.maximumCenterRateBps} BPS at far maturities.`
  const description = `Ladder market ${index + 1}, ${graphic.marketId}. Range ${graphic.minimumRateBps} to ${graphic.maximumRateBps} BPS. Deterministic reference ${graphic.referenceRateBps} BPS and quote ${graphic.centerRateBps} BPS.${maturityText} Triangle markers are lend rungs and circle markers are reduce-only rungs. Exact allocations and caps are in the semantic table. No live offers, balances, positions, or book.`
  return (
    <article className="preview-card ladder-preview" data-preview="ladder">
      <h3 id={`ladder-title-${index}`}>Ladder market {index + 1}</h3>
      <code>{graphic.marketId}</code>
      <figure role="img" aria-labelledby={`ladder-title-${index}`} aria-label={description}>
        <div className="ladder-plot" aria-hidden="true">
          <span className="range-label range-label--min">{graphic.minimumRateBps} BPS min</span>
          <span className="range-label range-label--max">{graphic.maximumRateBps} BPS max</span>
          {graphic.rungs.map((rung, rungIndex) => (
            <i
              key={`${rung.side}-${rung.index}-${rungIndex}`}
              className={`rung rung--${rung.side}`}
              style={{ top: `${rung.y}%` }}
              title={`${rung.sideLabel}: ${rung.rateBps} BPS, allocation ${format(rung.allocationAssets)}, cap ${format(rung.offerMaxAssets)}`}
            >
              {rung.side === 'higher' ? '▲' : '●'} {rung.rateBps}
            </i>
          ))}
          <b
            className="ladder-marker ladder-reference-marker"
            style={{ top: `${graphic.rateToY(graphic.referenceRateBps)}%` }}
          >
            Reference {graphic.referenceRateBps} BPS
          </b>
          <b
            className="ladder-marker ladder-center-marker"
            style={{ top: `${clampPlotPercent(graphic.rateToY(graphic.centerRateBps))}%` }}
          >
            Quote {graphic.centerRateBps} BPS
          </b>
          {graphic.maximumCenterRateBps === undefined ? null : (
            <b
              className="ladder-marker ladder-center-marker ladder-center-marker--maximum"
              style={{
                top: `${clampPlotPercent(graphic.rateToY(graphic.maximumCenterRateBps))}%`
              }}
            >
              Far-maturity quote {graphic.maximumCenterRateBps} BPS
            </b>
          )}
        </div>
        <figcaption>▲ Lend · ● Reduce-only · values are also available in the table</figcaption>
      </figure>
      <ReferenceStrip graphic={graphic} index={index} />
      <RungTable format={format} graphic={graphic} index={index} />
      <dl className="callouts">
        {graphic.callouts.map(item => (
          <div key={item.label}>
            <dt>
              {item.label}
              {item.parameters.length === 0 ? null : <code>{item.parameters.join(' · ')}</code>}
            </dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

const DisplayUnits = ({
  decimals,
  onChange
}: {
  decimals: string
  onChange: (value: string) => void
}) => (
  <section className="units-card" aria-labelledby="units-title">
    <div className="section-heading">
      <div>
        <span>Display units</span>
        <h2 id="units-title">Loan asset decimals</h2>
      </div>
    </div>
    <div className="units-row">
      <label className="field" htmlFor="loan-asset-decimals">
        <span>Decimals</span>
        <small>LOAN_ASSET_ADDRESS · 6 assumes USDC</small>
        <input
          id="loan-asset-decimals"
          inputMode="numeric"
          type="number"
          min={0}
          max={MAXIMUM_ASSET_DECIMALS}
          step={1}
          value={decimals}
          placeholder="raw"
          aria-invalid={decimals !== '' && resolveDecimals(decimals) === undefined}
          aria-label="Loan asset decimals; empty renders raw amounts"
          aria-describedby="units-help"
          onChange={event => onChange(event.target.value)}
        />
      </label>
      <p id="units-help">
        One scale covers both collections: a quoter-bot process has a single{' '}
        <code>LOAN_ASSET_ADDRESS</code>, and every configured amount — credit targets, offer sizes,
        budgets, and exposure caps — is a raw smallest-unit amount of that one loan asset.
        Collateral tokens never appear in a market collection, so their decimals are irrelevant
        here. Display only. It starts at 6 for USDC as a convenience, not because the playground
        resolved it — no chain data is read, so correct it for any other loan asset, and clear it to
        return every amount to its exact raw integer. The scale rounds amounts to whole units so
        magnitudes stay scannable; hover any amount to read its exact raw value. The editors, the
        four outputs, and the share URL always keep the exact raw integers.
      </p>
    </div>
  </section>
)

const InvalidPreview = ({ kind, errors }: { kind: CollectionKind; errors: string[] }) => (
  <div className="invalid-preview" role="alert" data-preview-error={kind}>
    <strong>{kind === 'bootstrap' ? 'Bootstrap' : 'Ladder'} preview unavailable</strong>
    <ul>
      {errors.map(error => (
        <li key={error}>{error}</li>
      ))}
    </ul>
    <span>No misleading graphic was generated.</span>
  </div>
)

const FragmentSync = ({
  state,
  onStatus,
  onUnexpected,
  suspendInitial
}: {
  state: PlaygroundState
  onStatus: (status: Status) => void
  onUnexpected: (error: unknown) => void
  suspendInitial: boolean
}) => {
  const lastFragment = useRef(window.location.hash)
  const lastMessage = useRef('')
  const initialErrorState = useRef(suspendInitial ? JSON.stringify(state) : undefined)
  useEffect(() => {
    const preserveInitialError =
      initialErrorState.current !== undefined && JSON.stringify(state) === initialErrorState.current
    if (initialErrorState.current !== undefined && !preserveInitialError) {
      initialErrorState.current = undefined
    }
    const validation = validatePlaygroundState(state)
    if (!validation.valid) {
      const message = 'Share URL remains at the last valid configuration while edits are invalid.'
      if (!preserveInitialError && lastMessage.current !== message) {
        lastMessage.current = message
        onStatus({ message, status: 'error' })
      }
      return
    }
    try {
      const fragment = encodePlaygroundFragment(state)
      const message = 'Share URL synchronized.'
      if (fragment === lastFragment.current) {
        if (!preserveInitialError && lastMessage.current !== message) {
          lastMessage.current = message
          onStatus({ message, status: 'ok' })
        }
        return
      }
      const nextUrl = `${window.location.pathname}${window.location.search}${fragment}`
      history.replaceState(null, '', nextUrl)
      lastFragment.current = fragment
      if (!preserveInitialError && lastMessage.current !== message) {
        lastMessage.current = message
        onStatus({ message, status: 'ok' })
      }
    } catch (error) {
      let message: string
      try {
        message = playgroundErrorMessage(error)
      } catch (unexpected) {
        onUnexpected(unexpected)
        return
      }
      if (!preserveInitialError && lastMessage.current !== message) {
        lastMessage.current = message
        onStatus({ message, status: 'error' })
      }
    }
  }, [state, onStatus, onUnexpected])
  return null
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Playground render failed', error, info.componentStack)
  }
  render() {
    if (this.state.error)
      return (
        <main role="alert">
          <h1>Playground unavailable</h1>
          <p>Reload or report this failure.</p>
        </main>
      )
    return this.props.children
  }
}

const Playground = () => {
  const initialValue = useRef(initial()).current
  const form = useForm({ defaultValues: initialValue.state })
  const [uiIds, setUiIds] = useState(() => idsFor(initialValue.state))
  const [importText, setImportText] = useState('')
  const [importStatus, setImportStatus] = useState<Status>({ message: '' })
  const [urlStatus, setUrlStatus] = useState<Status>({
    message: initialValue.error,
    status: initialValue.error ? 'error' : undefined
  })
  const [copyStatus, setCopyStatus] = useState<Status>({ message: '' })
  const [decimals, setDecimals] = useState(DEFAULT_ASSET_DECIMALS)
  const format = useMemo(() => assetFormatter(decimals), [decimals])
  const [unexpectedFailure, setUnexpectedFailure] = useState<{ error: unknown }>()
  const [activeExport, setActiveExport] = useState<ExportFormat>('bootstrap-json')
  const outputRefs = useRef<Record<ExportFormat, HTMLTextAreaElement | null>>({
    'bootstrap-json': null,
    'bootstrap-string': null,
    'ladder-json': null,
    'ladder-string': null
  })
  const shareUrlRef = useRef<HTMLInputElement | null>(null)
  const onUrlStatus = React.useCallback((status: Status) => setUrlStatus(status), [])
  const onUnexpected = React.useCallback((error: unknown) => setUnexpectedFailure({ error }), [])

  useEffect(() => {
    document.documentElement.dataset.playgroundReady = 'true'
    return () => {
      delete document.documentElement.dataset.playgroundReady
    }
  }, [])

  if (unexpectedFailure) throw unexpectedFailure.error

  const copy = async (
    value: string,
    fallback: HTMLInputElement | HTMLTextAreaElement | null,
    label: string
  ) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus({ message: `${label} copied.`, status: 'ok' })
    } catch {
      if (fallback) {
        fallback.focus()
        fallback.select()
        setCopyStatus({
          message: `Copy blocked; ${label} selected. Press Ctrl/Cmd+C.`,
          status: 'error'
        })
        return
      }
      setCopyStatus({
        message: `Copy blocked; ${label} could not be selected.`,
        status: 'error'
      })
    }
  }

  return (
    <form.Subscribe selector={state => state.values}>
      {state => {
        const bootstrapValidation = validateBootstrapCollection(state.bootstrap)
        const ladderValidation = validateLadderCollection(state.ladder)
        let bootstrapGraphics: BootstrapGraphicModel[] = []
        let ladderGraphics: LadderGraphicModel[] = []
        let bootstrapErrors = [...bootstrapValidation.errors]
        let ladderErrors = [...ladderValidation.errors]
        if (bootstrapValidation.valid) {
          try {
            bootstrapGraphics = deriveBootstrapGraphicModels(state.bootstrap, format)
          } catch (error) {
            bootstrapErrors = [playgroundErrorMessage(error)]
          }
        }
        if (ladderValidation.valid) {
          try {
            ladderGraphics = generateLadderGraphicModels(state.ladder, format)
          } catch (error) {
            ladderErrors = [playgroundErrorMessage(error)]
          }
        }
        const outputs: Record<ExportFormat, { value: string; invalid: boolean }> = {
          'bootstrap-json': exportResult(() => exportBootstrapJson(state.bootstrap)),
          'bootstrap-string': exportResult(() => exportBootstrapMarketsEnvValue(state.bootstrap)),
          'ladder-json': exportResult(() => exportLadderJson(state.ladder)),
          'ladder-string': exportResult(() => exportLadderMarketsEnvValue(state.ladder))
        }
        const shareUrl = exportResult(() => createPlaygroundShareUrl(state, window.location))
        const move = (kind: CollectionKind, from: number, to: number) => {
          if (to < 0 || to >= state[kind].length) return
          form.moveFieldValues(kind, from, to)
          setUiIds(previous => {
            const next = { ...previous, [kind]: [...previous[kind]] }
            const [id] = next[kind].splice(from, 1)
            if (id) next[kind].splice(to, 0, id)
            return next
          })
          // A zero-delay timer runs after React's commit without requestAnimationFrame's
          // paint-coupled scheduling, which throttled headless/background documents can starve.
          setTimeout(() => document.getElementById(`${kind}-${to}-marketId`)?.focus(), 0)
        }
        const remove = (kind: CollectionKind, index: number) => {
          void form.removeFieldValue(kind, index)
          setUiIds(previous => ({
            ...previous,
            [kind]: previous[kind].filter((_, i) => i !== index)
          }))
          setTimeout(() => document.getElementById(`add-${kind}`)?.focus(), 0)
        }
        const add = (kind: CollectionKind) => {
          const marketId = nextMarketId(state[kind])
          const item =
            kind === 'bootstrap' ? createDefaultBootstrap(marketId) : createDefaultLadder(marketId)
          form.pushFieldValue(kind, item as never)
          setUiIds(previous => ({ ...previous, [kind]: [...previous[kind], newId(kind)] }))
          setTimeout(
            () => document.getElementById(`${kind}-${state[kind].length}-marketId`)?.focus(),
            0
          )
        }
        const editor = <Item extends BootstrapInput | LadderInput>(
          kind: CollectionKind,
          items: Item[],
          fields: readonly FieldDefinition[]
        ) => (
          <section className="editor-section" aria-labelledby={`${kind}-editor-title`}>
            <div className="section-heading">
              <div>
                <span>{kind === 'bootstrap' ? 'BOOTSTRAP_MARKETS' : 'LADDER_MARKETS'}</span>
                <h2 id={`${kind}-editor-title`}>
                  {kind === 'bootstrap' ? 'Bootstrap markets' : 'Ladder markets'}
                </h2>
              </div>
              <button id={`add-${kind}`} type="button" onClick={() => add(kind)}>
                Add {kind} market
              </button>
            </div>
            {items.length === 0 ? (
              <p className="empty-state">Zero {kind} markets configured.</p>
            ) : null}
            {items.map((item, index) => (
              <fieldset className="market-card" key={uiIds[kind][index]} data-market-kind={kind}>
                <legend>
                  {kind === 'bootstrap' ? 'Bootstrap' : 'Ladder'} market {index + 1}
                </legend>
                <div className="item-actions">
                  <button
                    id={`${kind}-${index}-move-up`}
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(kind, index, index - 1)}
                  >
                    Move up
                  </button>
                  <button
                    id={`${kind}-${index}-move-down`}
                    type="button"
                    disabled={index === items.length - 1}
                    onClick={() => move(kind, index, index + 1)}
                  >
                    Move down
                  </button>
                  <button type="button" onClick={() => remove(kind, index)}>
                    Remove {kind}
                  </button>
                </div>
                <div className="field-grid">
                  {visibleFields(
                    fields,
                    item.targetRate,
                    'maturityPremium' in item ? item.maturityPremium : undefined
                  ).map(([key, label, help, type]) => (
                    <form.Field
                      key={`${uiIds[kind][index]}-${key}`}
                      name={`${kind}.${index}.${key}` as never}
                    >
                      {field => (
                        <label className="field" htmlFor={`${kind}-${index}-${key}`}>
                          <span>{label}</span>
                          <small>
                            {key} · {help}
                          </small>
                          {type === 'target-rate-select' ? (
                            <select
                              id={`${kind}-${index}-${key}`}
                              value={item.targetRate.strategy}
                              onBlur={field.handleBlur}
                              onChange={event =>
                                form.setFieldValue(
                                  `${kind}.${index}.targetRate` as never,
                                  (event.target.value === 'hardcoded'
                                    ? {
                                        strategy: 'hardcoded',
                                        hardcodedRateBps:
                                          item.targetRate.strategy === 'hardcoded'
                                            ? item.targetRate.hardcodedRateBps
                                            : '500'
                                      }
                                    : { strategy: 'variable_rate_avg' }) as never
                                )
                              }
                            >
                              <option value="variable_rate_avg">variable_rate_avg</option>
                              <option value="hardcoded">hardcoded</option>
                            </select>
                          ) : type === 'maturity-premium-select' ? (
                            <select
                              id={`${kind}-${index}-${key}`}
                              value={
                                'maturityPremium' in item && item.maturityPremium
                                  ? 'linear'
                                  : 'none'
                              }
                              onBlur={field.handleBlur}
                              onChange={event =>
                                form.setFieldValue(
                                  `${kind}.${index}.maturityPremium` as never,
                                  maturityPremiumSelection(
                                    'maturityPremium' in item ? item.maturityPremium : undefined,
                                    event.target.value
                                  ) as never
                                )
                              }
                            >
                              <option value="none">none</option>
                              <option value="linear">linear</option>
                            </select>
                          ) : type === 'select' ? (
                            <select
                              id={`${kind}-${index}-${key}`}
                              value={String(field.state.value)}
                              onBlur={field.handleBlur}
                              onChange={event => field.handleChange(event.target.value as never)}
                            >
                              <option value="shared-rung">shared-rung</option>
                              <option value="per-book">per-book</option>
                            </select>
                          ) : (
                            <input
                              id={`${kind}-${index}-${key}`}
                              type={type === 'checkbox' ? 'checkbox' : 'text'}
                              inputMode={
                                type === 'number' ||
                                type === 'target-rate-number' ||
                                type === 'maturity-premium-number'
                                  ? 'numeric'
                                  : undefined
                              }
                              checked={type === 'checkbox' ? Boolean(field.state.value) : undefined}
                              value={
                                type === 'checkbox'
                                  ? undefined
                                  : field.state.value === undefined
                                    ? ''
                                    : String(field.state.value)
                              }
                              disabled={
                                type === 'target-rate-number' &&
                                item.targetRate.strategy !== 'hardcoded'
                              }
                              onBlur={field.handleBlur}
                              onChange={event => {
                                if (
                                  key === 'maturityPremium.maximumPremiumBps' &&
                                  event.target.value.trim() === ''
                                ) {
                                  form.setFieldValue(
                                    `${kind}.${index}.maturityPremium` as never,
                                    withoutMaximumPremium(
                                      'maturityPremium' in item ? item.maturityPremium : undefined
                                    ) as never
                                  )
                                  return
                                }
                                field.handleChange(
                                  (type === 'checkbox'
                                    ? event.target.checked
                                    : event.target.value) as never
                                )
                              }}
                            />
                          )}
                        </label>
                      )}
                    </form.Field>
                  ))}
                </div>
              </fieldset>
            ))}
          </section>
        )
        const activateTab = (format: ExportFormat, focus = false) => {
          setActiveExport(format)
          if (focus) setTimeout(() => document.getElementById(`tab-${format}`)?.focus(), 0)
        }
        const tabKey = (event: React.KeyboardEvent, index: number) => {
          let next = index
          if (event.key === 'ArrowRight') next = (index + 1) % EXPORT_FORMATS.length
          else if (event.key === 'ArrowLeft')
            next = (index - 1 + EXPORT_FORMATS.length) % EXPORT_FORMATS.length
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = EXPORT_FORMATS.length - 1
          else return
          event.preventDefault()
          activateTab(EXPORT_FORMATS[next]!, true)
        }
        return (
          <>
            <FragmentSync
              state={state}
              onStatus={onUrlStatus}
              onUnexpected={onUnexpected}
              suspendInitial={Boolean(initialValue.error)}
            />
            <header className="topbar">
              <div>
                <p className="eyebrow">Morpho · stateless local planner</p>
                <h1>Bootstrap & ladder playground</h1>
              </div>
              <p>
                Only ordered BOOTSTRAP_MARKETS and LADDER_MARKETS. No secrets, scalar runtime setup,
                live offers, balances, backend, persistence, or network.
              </p>
            </header>
            <main>
              <DisplayUnits decimals={decimals} onChange={setDecimals} />
              <section className="monitor" aria-labelledby="monitor-title">
                <div className="section-heading">
                  <div>
                    <span>Sticky responsive monitor</span>
                    <h2 id="monitor-title">Every configured market</h2>
                  </div>
                </div>
                <div className="preview-group" aria-label="Bootstrap previews">
                  {bootstrapErrors.length ? (
                    <InvalidPreview kind="bootstrap" errors={bootstrapErrors} />
                  ) : bootstrapGraphics.length ? (
                    bootstrapGraphics.map((graphic, index) => (
                      <BootstrapGraphic
                        key={`${graphic.marketId}-${index}`}
                        format={format}
                        graphic={graphic}
                        index={index}
                      />
                    ))
                  ) : (
                    <p>No bootstrap graphics: collection is empty.</p>
                  )}
                </div>
                <div className="preview-group" aria-label="Ladder previews">
                  {ladderErrors.length ? (
                    <InvalidPreview kind="ladder" errors={ladderErrors} />
                  ) : ladderGraphics.length ? (
                    ladderGraphics.map((graphic, index) => (
                      <LadderGraphic
                        key={`${graphic.marketId}-${index}`}
                        format={format}
                        graphic={graphic}
                        index={index}
                      />
                    ))
                  ) : (
                    <p>No ladder graphics: collection is empty.</p>
                  )}
                </div>
              </section>
              <section className="workspace" aria-label="Configuration workspace">
                <section className="share-card" aria-labelledby="share-title">
                  <h2 id="share-title">Share URL</h2>
                  <p
                    id="url-status"
                    role="status"
                    aria-live="polite"
                    data-status={urlStatus.status}
                  >
                    {urlStatus.message}
                  </p>
                  <label htmlFor="share-url-output">
                    Canonical URL for the current configuration
                  </label>
                  <input
                    id="share-url-output"
                    readOnly
                    value={shareUrl.value}
                    aria-invalid={shareUrl.invalid}
                    ref={shareUrlRef}
                  />
                  <button
                    id="copy-share-url"
                    type="button"
                    disabled={shareUrl.invalid}
                    onClick={() => {
                      const value = createPlaygroundShareUrl(form.state.values, window.location)
                      if (shareUrlRef.current) shareUrlRef.current.value = value
                      void copy(value, shareUrlRef.current, 'Share URL')
                    }}
                  >
                    Copy share URL
                  </button>
                </section>
                <section className="import-card" aria-labelledby="import-title">
                  <h2 id="import-title">Paste JSON import</h2>
                  <p>
                    Paste bootstrap, ladder, or combined JSON. Applying is strict, bounded, and
                    atomic.
                  </p>
                  <label htmlFor="collection-import">
                    Paste bootstrap, ladder, or combined JSON
                  </label>
                  <textarea
                    id="collection-import"
                    rows={8}
                    value={importText}
                    onChange={event => setImportText(event.target.value)}
                  />
                  <button
                    id="apply-import"
                    type="button"
                    onClick={() => {
                      try {
                        const imported = parseCollectionsImport(importText)
                        const next = {
                          bootstrap: imported.bootstrap ?? state.bootstrap,
                          ladder: imported.ladder ?? state.ladder
                        }
                        if (!validatePlaygroundState(next).valid)
                          throw new CollectionImportError('Imported state is invalid')
                        form.setFieldValue('bootstrap', next.bootstrap)
                        form.setFieldValue('ladder', next.ladder)
                        setUiIds(idsFor(next))
                        setImportStatus({
                          message: 'Applied pasted JSON atomically.',
                          status: 'ok'
                        })
                      } catch (error) {
                        try {
                          setImportStatus({
                            message: playgroundErrorMessage(error),
                            status: 'error'
                          })
                        } catch (unexpected) {
                          setUnexpectedFailure({ error: unexpected })
                        }
                      }
                    }}
                  >
                    Apply pasted JSON
                  </button>
                  <p
                    id="import-status"
                    role="status"
                    aria-live="polite"
                    data-status={importStatus.status}
                  >
                    {importStatus.message}
                  </p>
                </section>
                {editor('bootstrap', state.bootstrap, BOOTSTRAP_FIELDS)}
                {editor('ladder', state.ladder, LADDER_FIELDS)}
                <section className="exports" aria-labelledby="exports-title">
                  <h2 id="exports-title">Four collection outputs</h2>
                  <div className="tabs" role="tablist" aria-label="Collection output">
                    {EXPORT_FORMATS.map((format, index) => (
                      <button
                        id={`tab-${format}`}
                        key={format}
                        type="button"
                        role="tab"
                        aria-selected={activeExport === format}
                        aria-controls={`panel-${format}`}
                        tabIndex={activeExport === format ? 0 : -1}
                        onClick={() => activateTab(format)}
                        onKeyDown={event => tabKey(event, index)}
                      >
                        {EXPORT_LABELS[format]}
                      </button>
                    ))}
                  </div>
                  {EXPORT_FORMATS.map(format => (
                    <section
                      id={`panel-${format}`}
                      key={format}
                      role="tabpanel"
                      aria-labelledby={`tab-${format}`}
                      hidden={activeExport !== format}
                    >
                      <textarea
                        readOnly
                        aria-label={`${EXPORT_LABELS[format]} output`}
                        value={outputs[format].value}
                        data-invalid={String(outputs[format].invalid)}
                        ref={element => {
                          outputRefs.current[format] = element
                        }}
                      />
                      <button
                        type="button"
                        disabled={outputs[format].invalid}
                        onClick={() =>
                          void copy(
                            outputs[format].value,
                            outputRefs.current[format],
                            EXPORT_LABELS[format]
                          )
                        }
                      >
                        Copy {EXPORT_LABELS[format]}
                      </button>
                    </section>
                  ))}
                  <p
                    id="copy-status"
                    role="status"
                    aria-live="polite"
                    data-status={copyStatus.status}
                  >
                    {copyStatus.message}
                  </p>
                </section>
              </section>
            </main>
          </>
        )
      }}
    </form.Subscribe>
  )
}

const exportResult = (operation: () => string) => {
  try {
    return { value: operation(), invalid: false }
  } catch (error) {
    return {
      value: playgroundErrorMessage(error),
      invalid: true
    }
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new PlaygroundInitializationError('Missing playground root')
createRoot(rootElement).render(
  <ErrorBoundary>
    <Playground />
  </ErrorBoundary>
)
