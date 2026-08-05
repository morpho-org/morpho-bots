import type { ErrorInfo, ReactNode } from 'react'

import { useForm } from '@tanstack/react-form'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable
} from '@tanstack/react-table'
import React, { Component, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

import type { BootstrapInput, LadderGraphicModel, LadderInput, PlaygroundState } from './model'

import {
  BOOTSTRAP_FIELDS,
  LADDER_FIELDS,
  OBSERVABILITY_FIELDS,
  SCALAR_FIELDS,
  SENSITIVE_UI_KEYS,
  createDefaultBootstrap,
  createDefaultLadder,
  createDefaultPlaygroundState,
  exportJson,
  exportLadderMarketsEnvValue,
  exportShell,
  exportYaml,
  generateLadderGraphicModels,
  getObservabilityStatuses,
  parseLadderMarketsImport,
  validatePreviewState,
  validateProductionState
} from './model'

const MAXIMUM_LADDER_IMPORT_BYTES = 128 * 1024
const textByteLength = (value: string) => new TextEncoder().encode(value).byteLength
const sensitiveUiKeys = new Set<string>(SENSITIVE_UI_KEYS)
type FieldDefinition = readonly [string, string, string, string]
type ExportFormat = 'yaml' | 'shell' | 'json' | 'ladder-env'
type QuickFieldKey = keyof LadderInput | 'referenceRateBps'

const exporters = {
  yaml: exportYaml,
  shell: exportShell,
  json: exportJson,
  'ladder-env': (state: PlaygroundState) => exportLadderMarketsEnvValue(state)
}

const quickGroups = [
  ['Market', ['marketId']],
  ['Center', ['referenceRateBps', 'quotePremiumBps']],
  ['Spacing & Gap', ['spreadBps', 'stepBps', 'rungCount']],
  ['Sizing & Skew', ['sizeSkewBps', 'minimumOfferAssets']],
  [
    'Budgets & Exposure',
    [
      'lowerRateBudgetAssets',
      'higherRateBudgetAssets',
      'targetMarketExposureAssets',
      'maximumTotalExposureAssets'
    ]
  ],
  [
    'Runtime & Bounds',
    ['groupMode', 'loopIntervalSeconds', 'movementToleranceBps', 'minimumRateBps', 'maximumRateBps']
  ]
] as const

const ladderFieldsByKey = new Map<string, FieldDefinition>(
  LADDER_FIELDS.map(field => [field[0], field])
)
const quickFieldDefinition = (key: QuickFieldKey): FieldDefinition =>
  key === 'referenceRateBps'
    ? [
        'referenceRateBps',
        'Reference rate (BPS)',
        'Preview-only market input · not exported',
        'number'
      ]
    : (ladderFieldsByKey.get(key) as FieldDefinition)
const firstAllowlistedMarket = (state: PlaygroundState) =>
  state.scalar.MARKET_IDS.split(',')
    .map(value => value.trim())
    .find(Boolean)
const formatAssets = (value: string) => Intl.NumberFormat('en-US').format(BigInt(value))
const synchronously = (operation: () => void) => flushSync(operation)

const columnHelper = createColumnHelper<LadderGraphicModel['rungs'][number]>()
const rungColumns = [
  columnHelper.accessor('sideLabel', { header: 'Side', cell: info => info.getValue() }),
  columnHelper.accessor('rateBps', { header: 'Rate (BPS)', cell: info => info.getValue() }),
  columnHelper.accessor('allocationAssets', {
    header: 'Allocation (assets)',
    cell: info => info.getValue()
  }),
  columnHelper.accessor('offerMaxAssets', {
    header: 'Offer maxAssets (assets)',
    cell: info => info.getValue()
  })
]

const RungTable = ({
  graphic,
  previewIndex
}: {
  graphic: LadderGraphicModel
  previewIndex: number
}) => {
  const table = useReactTable({
    data: graphic.rungs,
    columns: rungColumns,
    getCoreRowModel: getCoreRowModel()
  })
  return (
    <div className="visually-hidden">
      <table
        className="rung-table"
        aria-labelledby={`ladder-heading-${previewIndex}`}
        aria-describedby={`ladder-description-${previewIndex}`}
      >
        <caption>
          Exact allocation and offer maxAssets rungs for ladder market {previewIndex + 1}
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
              {row.getVisibleCells().map((cell, index) =>
                index === 0 ? (
                  <th key={cell.id} scope="row">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </th>
                ) : (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const LadderGraphic = ({
  graphic,
  previewIndex
}: {
  graphic: LadderGraphicModel
  previewIndex: number
}) => {
  const titleId = `ladder-heading-${previewIndex}`
  const descriptionId = `ladder-description-${previewIndex}`
  const scrollHintId = `ladder-scroll-hint-${previewIndex}`
  const chartWidth = 1120
  const chartHeight = graphic.plotHeight + 64
  const axisX = 180
  const rightX = 1096
  const referenceY = graphic.rateToY(graphic.axis.referenceRateBps)
  const centerY = graphic.rateToY(graphic.axis.centerRateBps)
  const nearestHigher = graphic.rungs.findLast(rung => rung.side === 'higher')
  const nearestLower = graphic.rungs.find(rung => rung.side === 'lower')
  const gapTop = nearestHigher ? nearestHigher.y + 11 : 0
  const gapBottom = nearestLower ? nearestLower.y - 11 : 0
  const description = `Allocation is the configured asset amount assigned to one rung. Offer maxAssets is the protocol maximum asset amount for that rung’s offer. In shared-rung mode, allocation and offer maxAssets are equal and their rectangles share identical geometry. In per-book mode, each rung allocation is nested inside its side-wide offer maxAssets cap. This stateless graphic does not model live capacities, current offers, or the current book. The vertical rate axis runs from ${graphic.axis.minimumRateBps} to ${graphic.axis.maximumRateBps} BPS, with reference ${graphic.axis.referenceRateBps} BPS and quote center ${graphic.axis.centerRateBps} BPS.`
  return (
    <section className="ladder-market">
      <div className="ladder-heading">
        <h3 id={titleId}>Ladder market {previewIndex + 1}: allocation and offer maxAssets</h3>
        <code data-parameter="marketId">MARKET ID · {graphic.marketId}</code>
      </div>
      <figure className="ladder-graphic" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <p id={descriptionId} className="visually-hidden">
          {description}
        </p>
        <p id={scrollHintId} className="ladder-scroll-hint">
          Scroll the plot horizontally or vertically to reach every exact rung.
        </p>
        <div
          className="ladder-scroll"
          tabIndex={0}
          role="region"
          aria-labelledby={titleId}
          aria-describedby={`${descriptionId} ${scrollHintId}`}
        >
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            width={chartWidth}
            height={chartHeight}
            role="img"
            aria-labelledby={`ladder-title-${previewIndex}`}
            aria-describedby={descriptionId}
            preserveAspectRatio="xMidYMid meet"
          >
            <title id={`ladder-title-${previewIndex}`}>
              Ladder market {previewIndex + 1}: allocation and offer maxAssets graphic
            </title>
            <line
              x1={axisX}
              y1={24}
              x2={axisX}
              y2={graphic.plotHeight + 40}
              className="ladder-axis"
              data-parameter="minimumRateBps maximumRateBps"
            />
            <line x1={172} y1={24} x2={188} y2={24} className="axis-tick" />
            <text x={164} y={28} className="axis-label" textAnchor="end">
              MAX {graphic.axis.maximumRateBps} BPS
            </text>
            <line
              x1={172}
              y1={graphic.plotHeight + 40}
              x2={188}
              y2={graphic.plotHeight + 40}
              className="axis-tick"
            />
            <text x={164} y={graphic.plotHeight + 44} className="axis-label" textAnchor="end">
              MIN {graphic.axis.minimumRateBps} BPS
            </text>
            {nearestHigher && nearestLower ? (
              <>
                <rect
                  x={axisX}
                  y={gapTop}
                  width={rightX - axisX}
                  height={Math.max(0, gapBottom - gapTop)}
                  className="spread-gap"
                  data-parameter="spreadBps"
                />
                <text x={axisX + 16} y={(gapTop + gapBottom) / 2 + 4} className="spread-gap-label">
                  SPREAD GAP · {graphic.gapBps} BPS
                </text>
              </>
            ) : null}
            <line
              x1={axisX}
              y1={referenceY}
              x2={rightX}
              y2={referenceY}
              className="reference-line"
              data-parameter="referenceRateBps"
            />
            <text x={rightX - 8} y={referenceY - 7} className="reference-label" textAnchor="end">
              REFERENCE {graphic.axis.referenceRateBps}
            </text>
            <line
              x1={axisX}
              y1={centerY}
              x2={rightX}
              y2={centerY}
              className="center-line"
              data-parameter="quotePremiumBps"
            />
            <text x={rightX - 8} y={centerY + 15} className="center-label" textAnchor="end">
              CENTER {graphic.axis.centerRateBps}
            </text>
            {graphic.rungs.map((rung, index) => {
              const equal = rung.allocationAssets === rung.offerMaxAssets
              const equalWidth = Math.max(28, Math.round(470 * rung.allocationBarRatio))
              const offerWidth = equal
                ? equalWidth
                : Math.max(28, Math.round(470 * rung.offerMaxBarRatio))
              const allocationWidth = equal
                ? equalWidth
                : Math.min(offerWidth, Math.max(12, Math.round(470 * rung.allocationBarRatio)))
              return (
                <g
                  key={`${rung.side}-${rung.index}-${index}`}
                  className={`rung-group rung-group--${rung.side}`}
                >
                  <title>
                    {rung.sideLabel}; {rung.rateBps} BPS; allocation{' '}
                    {formatAssets(rung.allocationAssets)} assets; offer maxAssets{' '}
                    {formatAssets(rung.offerMaxAssets)} assets
                  </title>
                  <line x1={190} y1={rung.y} x2={rightX - 12} y2={rung.y} className="rung-guide" />
                  <rect
                    x={206}
                    y={rung.y - 10}
                    width={offerWidth}
                    height={20}
                    rx={3}
                    className={`ladder-rung offer-cap-bar offer-cap-bar--${rung.side}`}
                    data-rate-bps={rung.rateBps}
                    data-allocation-assets={rung.allocationAssets}
                    data-offer-max-assets={rung.offerMaxAssets}
                    data-side={rung.side}
                    data-parameter="sizeSkewBps lowerRateBudgetAssets higherRateBudgetAssets targetMarketExposureAssets maximumTotalExposureAssets minimumOfferAssets"
                  />
                  <rect
                    x={206}
                    y={rung.y - 4}
                    width={allocationWidth}
                    height={8}
                    rx={2}
                    className={`allocation-bar allocation-bar--${rung.side}`}
                    data-allocation-assets={rung.allocationAssets}
                    data-offer-max-assets={rung.offerMaxAssets}
                    data-side={rung.side}
                  />
                  {rung.side === 'higher' ? (
                    <path
                      d={`M 172 ${rung.y} l -8 -6 v 12 z`}
                      className="rung-marker rung-marker--higher"
                    />
                  ) : (
                    <circle cx={166} cy={rung.y} r={6} className="rung-marker rung-marker--lower" />
                  )}
                  <text x={216} y={rung.y + 4} className="rung-rate">
                    {rung.rateBps} BPS
                  </text>
                  <text x={rightX - 8} y={rung.y + 4} className="rung-details" textAnchor="end">
                    {rung.sideLabel.toUpperCase()} · allocation{' '}
                    {formatAssets(rung.allocationAssets)} · offer maxAssets{' '}
                    {formatAssets(rung.offerMaxAssets)}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
        <RungTable graphic={graphic} previewIndex={previewIndex} />
        <div className="ladder-legend">
          <span>
            <i className="legend-marker legend-marker--triangle" />
            Higher rate · LEND
          </span>
          <span>
            <i className="legend-marker legend-marker--circle" />
            Lower rate · REDUCE-ONLY
          </span>
          <span>
            <i className="legend-marker legend-marker--offer-cap" />
            Outlined bar = offer maxAssets
          </span>
          <span>
            <i className="legend-marker legend-marker--allocation" />
            Nested fill = allocation
          </span>
          <strong>
            Stateless configured output · live capacities and current offers remain excluded
          </strong>
        </div>
      </figure>
      <dl className="ladder-callouts">
        {graphic.callouts.map(callout => (
          <div
            key={callout.label}
            className="ladder-callout"
            data-parameter={callout.parameters.join(' ')}
          >
            <dt>{callout.label}</dt>
            <dd>{callout.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const InvalidGraphic = ({ errors }: { errors: readonly string[] }) => (
  <div
    className="ladder-invalid"
    role="img"
    aria-label={`Invalid ladder graphic. No offers shown. ${errors.join('. ')}`}
  >
    <strong>Invalid ladder graphic</strong>
    <span>No synthetic offers are shown until the configuration is valid.</span>
  </div>
)

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
        <main id="playground-failure" role="alert" aria-live="assertive" tabIndex={-1}>
          <h1>Market maker playground unavailable</h1>
          <p>The local interface could not render. Reload the page or report this failure.</p>
        </main>
      )
    return this.props.children
  }
}

const Playground = () => {
  const form = useForm({ defaultValues: createDefaultPlaygroundState() })
  const [selectedLadderIndex, setSelectedLadderIndex] = useState(0)
  const [activeExport, setActiveExport] = useState<ExportFormat>('yaml')
  const [includeSensitiveValues, setIncludeSensitiveValues] = useState(false)
  const [copyStatus, setCopyStatus] = useState<{ message: string; status?: 'ok' | 'error' }>({
    message: ''
  })
  const [importText, setImportText] = useState('')
  const [importStatus, setImportStatus] = useState<{ message: string; status?: 'ok' | 'error' }>({
    message: ''
  })
  const [dragging, setDragging] = useState(false)
  const importGeneration = useRef(0)
  const importTextArea = useRef<HTMLTextAreaElement | null>(null)
  const outputRefs = useRef<Record<ExportFormat, HTMLTextAreaElement | null>>({
    yaml: null,
    shell: null,
    json: null,
    'ladder-env': null
  })

  useEffect(() => {
    rootElement.dataset.reactMounted = 'true'
    document.documentElement.dataset.playgroundReady = 'true'
    return () => {
      delete rootElement.dataset.reactMounted
      delete document.documentElement.dataset.playgroundReady
    }
  }, [])

  const sectionHeading = (title: string, eyebrow: string, action?: ReactNode) => (
    <div className="section-heading">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      {action}
    </div>
  )
  const fieldInput = (
    path: string,
    field: FieldDefinition,
    quick = false,
    errors: readonly string[] = []
  ) => {
    const [key, label, help, type] = field
    const sensitive = sensitiveUiKeys.has(key)
    const hintId = quick ? `quick-hint-${key}` : undefined
    const errorId = quick ? `quick-error-${key}` : undefined
    const id = quick
      ? key === 'referenceRateBps'
        ? 'preview-reference'
        : `quick-${key}`
      : `field-${path.replaceAll('.', '-').replaceAll('[', '-').replaceAll(']', '')}`
    return (
      <form.Field key={`${quick ? 'quick' : 'full'}-${path}`} name={path as never}>
        {fieldApi => {
          const value = fieldApi.state.value as string | boolean
          const common = {
            id,
            'data-field': quick ? undefined : key,
            'data-quick-field': quick ? key : undefined,
            'aria-describedby': quick ? `${hintId} ${errorId}` : undefined,
            'aria-invalid': quick ? errors.length > 0 : undefined,
            onBlur: fieldApi.handleBlur
          }
          const control =
            type === 'select' ? (
              <select
                {...common}
                value={String(value)}
                onInput={event =>
                  synchronously(() => fieldApi.handleChange(event.currentTarget.value as never))
                }
              >
                <option value="shared-rung">shared-rung</option>
                <option value="per-book">per-book</option>
              </select>
            ) : (
              <input
                {...common}
                type={
                  type === 'checkbox'
                    ? 'checkbox'
                    : sensitive
                      ? includeSensitiveValues
                        ? 'text'
                        : 'password'
                      : 'text'
                }
                inputMode={type === 'number' ? 'numeric' : undefined}
                pattern={type === 'number' ? '-?[0-9]*' : undefined}
                autoComplete={sensitive ? 'off' : undefined}
                data-sensitive={sensitive ? 'true' : undefined}
                checked={type === 'checkbox' ? Boolean(value) : undefined}
                value={type === 'checkbox' ? undefined : String(value)}
                onInput={event =>
                  synchronously(() =>
                    fieldApi.handleChange(
                      (type === 'checkbox'
                        ? event.currentTarget.checked
                        : event.currentTarget.value) as never
                    )
                  )
                }
              />
            )
          return quick ? (
            <label className="quick-field" htmlFor={id}>
              <span className="quick-field__label">{label}</span>
              <span className="quick-field__hint" id={hintId}>
                {key} · {help}
              </span>
              {control}
              <span className="quick-field__error" id={errorId} role="status">
                {errors[0] ?? ''}
              </span>
            </label>
          ) : (
            <label className="field" htmlFor={id}>
              <span className="field__heading">{label}</span>
              <span className="field__hint">
                {key} · {help}
              </span>
              {control}
            </label>
          )
        }}
      </form.Field>
    )
  }

  const beginImport = () => ++importGeneration.current
  const applyImport = (text: string, values: PlaygroundState, generation = beginImport()) => {
    if (generation !== importGeneration.current) return false
    if (textByteLength(text) > MAXIMUM_LADDER_IMPORT_BYTES) {
      setImportStatus({ message: 'Import exceeds the 128 KiB size limit.', status: 'error' })
      return false
    }
    try {
      const imported = parseLadderMarketsImport(text, values.scalar.MARKET_IDS)
      if (generation !== importGeneration.current) return false
      form.setFieldValue('ladder', imported)
      setSelectedLadderIndex(0)
      setImportText(text)
      setImportStatus({
        message: `Applied ${imported.length} ladder market${imported.length === 1 ? '' : 's'}.`,
        status: 'ok'
      })
      return true
    } catch (error) {
      setImportStatus({
        message: error instanceof Error ? error.message : 'Invalid ladder JSON.',
        status: 'error'
      })
      return false
    }
  }
  const applyFile = async (files: FileList | readonly File[]) => {
    const generation = beginImport()
    if (files.length !== 1) {
      setImportStatus({ message: 'Choose or drop exactly one JSON file.', status: 'error' })
      return
    }
    const file = files[0]
    if (!file) return
    const supportedMime =
      file.type === '' || file.type === 'application/json' || file.type === 'text/json'
    if (!file.name.toLowerCase().endsWith('.json') || !supportedMime) {
      setImportStatus({
        message: 'Choose a .json JSON file with a supported JSON MIME type.',
        status: 'error'
      })
      return
    }
    if (file.size > MAXIMUM_LADDER_IMPORT_BYTES) {
      setImportStatus({ message: 'Import exceeds the 128 KiB size limit.', status: 'error' })
      return
    }
    try {
      const text = await file.text()
      if (generation !== importGeneration.current) return
      const currentValues = form.state.values
      if (applyImport(text, currentValues, generation) && generation === importGeneration.current)
        setImportText(text)
    } catch {
      if (generation === importGeneration.current)
        setImportStatus({ message: 'The JSON file could not be read.', status: 'error' })
    }
  }

  const activateTab = (format: ExportFormat, focus = false) => {
    synchronously(() => setActiveExport(format))
    if (focus) globalThis.document.getElementById(`tab-${format}`)?.focus()
  }
  const tabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const formats: ExportFormat[] = ['yaml', 'shell', 'json', 'ladder-env']
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % formats.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + formats.length) % formats.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = formats.length - 1
    else return
    event.preventDefault()
    activateTab(formats[next], true)
  }
  const copyExport = async (value: string) => {
    const output = outputRefs.current[activeExport]
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
      else {
        output?.focus()
        output?.select()
        if (!document.execCommand('copy')) throw new Error('Clipboard API unavailable')
      }
      synchronously(() => setCopyStatus({ message: 'Copied to clipboard.', status: 'ok' }))
    } catch {
      output?.focus()
      output?.select()
      synchronously(() =>
        setCopyStatus({
          message: 'Copy was blocked. The full export is selected; press Ctrl/Cmd+C.',
          status: 'error'
        })
      )
    }
  }

  return (
    <form.Subscribe selector={formState => formState.values}>
      {values => {
        const state = values
        const selectedIndex = Math.min(selectedLadderIndex, Math.max(0, state.ladder.length - 1))
        const selected = state.ladder[selectedIndex]
        const productionValidation = validateProductionState(state)
        const previewValidation = validatePreviewState(state)
        let graphics: LadderGraphicModel[] = []
        let graphicErrors: string[] = []
        if (previewValidation.valid) {
          try {
            graphics = generateLadderGraphicModels(state)
          } catch (error) {
            graphicErrors = [
              error instanceof Error ? error.message : 'Invalid preview configuration'
            ]
          }
        }
        const graphicValid = previewValidation.valid && graphicErrors.length === 0
        const validationErrors = [...productionValidation.errors, ...previewValidation.errors]
        const outputs = Object.fromEntries(
          Object.entries(exporters).map(([format, exporter]) => {
            try {
              return [
                format,
                { value: exporter(state, { includeSensitiveValues }), invalid: false }
              ]
            } catch (error) {
              return [
                format,
                {
                  value: error instanceof Error ? error.message : 'Configuration is invalid',
                  invalid: true
                }
              ]
            }
          })
        ) as Record<ExportFormat, { value: string; invalid: boolean }>
        const observability = getObservabilityStatuses(state)
        const observabilityWarnings = observability.some(status => status.level === 'warning')
        const move = (kind: 'bootstrap' | 'ladder', from: number, to: number) => {
          if (to < 0 || to >= state[kind].length) return
          synchronously(() => {
            form.moveFieldValues(kind, from, to)
            if (kind === 'ladder')
              setSelectedLadderIndex(current =>
                current === from ? to : current === to ? from : current
              )
          })
        }
        const remove = (kind: 'bootstrap' | 'ladder', index: number) => {
          synchronously(() => {
            void form.removeFieldValue(kind, index)
            if (kind === 'ladder')
              setSelectedLadderIndex(current =>
                current === index
                  ? Math.min(index, state.ladder.length - 2)
                  : current > index
                    ? current - 1
                    : current
              )
          })
        }
        const collection = <Item extends BootstrapInput | LadderInput>(
          kind: 'bootstrap' | 'ladder',
          title: string,
          fields: readonly FieldDefinition[],
          items: Item[]
        ) => (
          <section className="control-section">
            {sectionHeading(
              title,
              `${kind === 'bootstrap' ? 'BOOTSTRAP_MARKETS' : 'LADDER_MARKETS'} · ordered list`,
              <button
                type="button"
                className="button"
                onClick={() => {
                  const item =
                    kind === 'bootstrap'
                      ? createDefaultBootstrap(firstAllowlistedMarket(state))
                      : createDefaultLadder(firstAllowlistedMarket(state))
                  synchronously(() => {
                    form.pushFieldValue(kind, item as never)
                    if (kind === 'ladder') setSelectedLadderIndex(state.ladder.length)
                  })
                }}
              >
                Add {kind} market
              </button>
            )}
            {items.length === 0 ? (
              <p className="empty-state">No {kind} markets configured.</p>
            ) : null}
            {items.map((item, index) => (
              <fieldset className="market-card" key={`${kind}-${index}`}>
                <legend>
                  {title} {index + 1}
                </legend>
                <div className="item-actions">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => move(kind, index, index - 1)}
                  >
                    Move up
                  </button>
                  <button
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
                  {fields.map(field => fieldInput(`${kind}.${index}.${field[0]}`, field))}
                </div>
              </fieldset>
            ))}
          </section>
        )
        const ladderStatus = !previewValidation.valid
          ? 'Preview unavailable while configuration is invalid.'
          : graphicErrors.length > 0
            ? graphicErrors[0]
            : graphics.length === 0
              ? 'No ladder markets configured.'
              : `${graphics.length} production-equivalent synthetic ladder graphic${graphics.length === 1 ? '' : 's'} · quick editing market ${selectedIndex + 1}.`
        return (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">Morpho · Midnight · Monitor / Configure</p>
                <h1>Market maker parameter playground</h1>
              </div>
              <p className="scope-note">
                <span>Stateless preview</span> · Complete current config surface; no live offers,
                market book, persistence, backend, or runtime network requests.
              </p>
            </header>
            <main>
              <section className="configure-surface" aria-labelledby="configure-heading">
                <div className="configure-heading">
                  <p className="eyebrow">Configure · validated handoff</p>
                  <h2 id="configure-heading">Runtime parameters and export</h2>
                </div>
                <div className="workbench">
                  <section className="monitor-surface" aria-labelledby="monitor-heading">
                    <div className="monitor-header">
                      <div className="section-heading">
                        <span>Monitor · instant simulation</span>
                        <h2 id="monitor-heading">Offer ladder monitor</h2>
                      </div>
                    </div>
                    <div className="monitor-body">
                      <p
                        id="ladder-status"
                        className="status"
                        role="status"
                        aria-live="polite"
                        data-status={graphicValid ? 'ok' : 'error'}
                      >
                        {ladderStatus}
                      </p>
                      <div id="ladders" className="ladders" aria-live="polite">
                        {graphicValid ? (
                          graphics.map((graphic, index) => (
                            <LadderGraphic
                              key={`${graphic.marketId}-${index}`}
                              graphic={graphic}
                              previewIndex={index}
                            />
                          ))
                        ) : (
                          <InvalidGraphic
                            errors={
                              graphicErrors.length > 0 ? graphicErrors : previewValidation.errors
                            }
                          />
                        )}
                      </div>
                      <section
                        id="quick-edit"
                        className="quick-edit"
                        aria-labelledby="quick-edit-heading"
                      >
                        <div className="quick-edit__header">
                          <h3 id="quick-edit-heading">Quick edit</h3>
                          <a href="#generated-controls">Open full configuration</a>
                        </div>
                        {!selected ? (
                          <p className="empty-state">
                            Add a ladder market in the full configuration to enable quick edit.
                          </p>
                        ) : (
                          <>
                            <label className="quick-market-switcher">
                              <span>Selected ladder market</span>
                              <select
                                id="quick-market-select"
                                aria-label="Selected ladder market"
                                value={selectedIndex}
                                onChange={event =>
                                  setSelectedLadderIndex(Number(event.target.value))
                                }
                              >
                                {state.ladder.map((ladder, index) => (
                                  <option key={index} value={index}>
                                    Market {index + 1} · {ladder.marketId.slice(0, 10)}…
                                  </option>
                                ))}
                              </select>
                            </label>
                            {quickGroups.map(([groupName, keys], groupIndex) => (
                              <details
                                className="quick-group"
                                open={groupIndex < 2}
                                key={groupName}
                              >
                                <summary>{groupName}</summary>
                                <fieldset>
                                  <legend>{groupName}</legend>
                                  <div className="quick-grid">
                                    {keys.map(key => {
                                      const prefix = `ladder[${selectedIndex}]`
                                      const errors = validationErrors.filter(
                                        message =>
                                          message.includes(key) &&
                                          (key === 'referenceRateBps' ||
                                            !message.includes('ladder[') ||
                                            message.includes(prefix))
                                      )
                                      const path =
                                        key === 'referenceRateBps'
                                          ? 'referenceRateBps'
                                          : `ladder.${selectedIndex}.${key}`
                                      return fieldInput(
                                        path,
                                        quickFieldDefinition(key),
                                        true,
                                        errors
                                      )
                                    })}
                                  </div>
                                </fieldset>
                              </details>
                            ))}
                          </>
                        )}
                      </section>
                      <p className="future-scope">
                        Production generator and validators are reused locally. Dynamic balances,
                        credit, and live order books remain outside this stateless preview.
                      </p>
                    </div>
                  </section>
                  <div id="controls" className="controls">
                    <section
                      id="ladder-import"
                      className="control-section ladder-import"
                      aria-labelledby="ladder-import-heading"
                    >
                      {sectionHeading('Import ladder JSON', 'LADDER_MARKETS · local only')}
                      <p id="ladder-import-help" className="format-note">
                        Drop or choose one .json file, or paste JSON below. Accepts only the exact
                        LADDER_MARKETS array, one exact ladder object, or a JSON string literal
                        containing either. The production parser rejects unknown keys; applying
                        replaces every ladder only after the complete input validates. Maximum 128
                        KiB.
                      </p>
                      <div className="ladder-import__file-picker">
                        <label className="button" htmlFor="ladder-import-file">
                          Choose ladder JSON file
                        </label>
                        <input
                          id="ladder-import-file"
                          type="file"
                          accept=".json,application/json"
                          aria-describedby="ladder-import-help"
                          onChange={event => {
                            synchronously(() => {
                              void applyFile(event.target.files ?? [])
                            })
                            event.target.value = ''
                          }}
                        />
                      </div>
                      <div
                        id="ladder-import-drop"
                        className={`ladder-import__drop${dragging ? ' is-dragging' : ''}`}
                        role="group"
                        aria-label="JSON file drop region"
                        aria-describedby="ladder-import-help"
                        onDragEnter={event => {
                          event.preventDefault()
                          synchronously(() => setDragging(true))
                        }}
                        onDragOver={event => {
                          event.preventDefault()
                          synchronously(() => setDragging(true))
                        }}
                        onDragLeave={() => synchronously(() => setDragging(false))}
                        onDragEnd={() => synchronously(() => setDragging(false))}
                        onDrop={event => {
                          event.preventDefault()
                          synchronously(() => {
                            setDragging(false)
                            void applyFile(event.dataTransfer.files)
                          })
                        }}
                      >
                        <strong>Drop one ladder .json file here</strong>
                        <span>or use the file chooser above</span>
                      </div>
                      <label className="field" htmlFor="ladder-import-text">
                        <span className="field__heading">Paste ladder JSON</span>
                        <span className="field__hint">
                          Exact JSON only; no shell assignment or persistence.
                        </span>
                        <textarea
                          id="ladder-import-text"
                          rows={6}
                          spellCheck={false}
                          aria-describedby="ladder-import-help"
                          value={importText}
                          ref={importTextArea}
                          onChange={event => setImportText(event.target.value)}
                        />
                      </label>
                      <button
                        id="apply-ladder-import"
                        type="button"
                        className="button"
                        onClick={() =>
                          synchronously(() => {
                            applyImport(importTextArea.current?.value ?? importText, state)
                          })
                        }
                      >
                        Apply ladder JSON
                      </button>
                      <p
                        id="ladder-import-status"
                        className="status"
                        role="status"
                        aria-live="polite"
                        data-status={importStatus.status}
                      >
                        {importStatus.message}
                      </p>
                    </section>
                    <div id="generated-controls" className="controls">
                      <section className="control-section">
                        {sectionHeading('Runtime & setup', 'Core configuration')}
                        <div className="field-grid">
                          {SCALAR_FIELDS.map(field => fieldInput(`scalar.${field[0]}`, field))}
                        </div>
                      </section>
                      {collection(
                        'bootstrap',
                        'Position bootstrap',
                        BOOTSTRAP_FIELDS,
                        state.bootstrap
                      )}
                      {collection('ladder', 'Live ladder', LADDER_FIELDS, state.ladder)}
                      <section className="control-section">
                        {sectionHeading('Observability', 'Environment-only variables')}
                        <div className="field-grid">
                          {OBSERVABILITY_FIELDS.map(field =>
                            fieldInput(`observability.${field[0]}`, field)
                          )}
                        </div>
                      </section>
                    </div>
                  </div>
                </div>
                <section className="export-card">
                  {sectionHeading('Configuration export', 'Validated handoff')}
                  <div
                    id="validation-errors"
                    className="validation-errors"
                    role="alert"
                    aria-live="assertive"
                    hidden={productionValidation.valid}
                  >
                    {productionValidation.valid ? null : (
                      <>
                        <strong>
                          Configuration is invalid. Fix these errors before exporting:
                        </strong>
                        <ul>
                          {productionValidation.errors.map(error => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                  <div
                    id="observability-status"
                    className="observability-status"
                    role="status"
                    aria-live="polite"
                    data-status={observabilityWarnings ? 'warning' : 'status'}
                  >
                    <strong>
                      {observabilityWarnings
                        ? 'Core configuration remains exportable; observability has nonfatal warnings:'
                        : 'Best-effort observability status:'}
                    </strong>
                    <ul>
                      {observability.map(status => (
                        <li key={status.integration} data-level={status.level}>
                          {status.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <label className="sensitive-export-control" htmlFor="include-sensitive-values">
                    <input
                      id="include-sensitive-values"
                      type="checkbox"
                      aria-describedby="include-sensitive-warning"
                      checked={includeSensitiveValues}
                      onChange={event => {
                        const checked = event.target.checked
                        setIncludeSensitiveValues(checked)
                        setCopyStatus({
                          message: checked
                            ? 'Sensitive values are visible and will be copied.'
                            : 'Sensitive values are redacted.',
                          status: checked ? 'error' : 'ok'
                        })
                      }}
                    />
                    <span>
                      <strong>Reveal and include sensitive values</strong>
                      <small id="include-sensitive-warning">
                        Warning: reveals private keys, tokens, and complete RPC URLs in controls,
                        export text, and clipboard output; heartbeat URLs may contain credentials.
                      </small>
                    </span>
                  </label>
                  <div className="tabs" role="tablist" aria-label="Export format">
                    {(['yaml', 'shell', 'json', 'ladder-env'] as ExportFormat[]).map(
                      (format, index) => (
                        <button
                          id={`tab-${format}`}
                          key={format}
                          type="button"
                          role="tab"
                          aria-controls={`panel-${format}`}
                          aria-selected={activeExport === format}
                          tabIndex={activeExport === format ? 0 : -1}
                          data-export={format}
                          className={activeExport === format ? 'is-active' : undefined}
                          onClick={() => activateTab(format)}
                          onKeyDown={event => tabKeyDown(event, index)}
                        >
                          {format === 'yaml'
                            ? 'YAML'
                            : format === 'shell'
                              ? 'Shell-safe ENV'
                              : format === 'json'
                                ? 'JSON'
                                : 'LADDER_MARKETS env value'}
                        </button>
                      )
                    )}
                  </div>
                  {(['yaml', 'shell', 'json', 'ladder-env'] as ExportFormat[]).map(format => (
                    <section
                      id={`panel-${format}`}
                      key={format}
                      role="tabpanel"
                      aria-labelledby={`tab-${format}`}
                      data-panel={format}
                      hidden={activeExport !== format}
                    >
                      {format === 'shell' ? (
                        <p className="format-note">
                          POSIX-shell-safe ENV export statements with literal values.
                        </p>
                      ) : null}
                      {format === 'ladder-env' ? (
                        <p className="format-note">
                          Compact single-line JSON value for LADDER_MARKETS. This is the environment
                          value only, without a shell assignment or extra JSON string-literal
                          encoding.
                        </p>
                      ) : null}
                      <textarea
                        id={`export-${format}`}
                        readOnly
                        spellCheck={false}
                        aria-label={
                          format === 'yaml'
                            ? 'YAML configuration export'
                            : format === 'shell'
                              ? 'Shell-safe configuration export'
                              : format === 'json'
                                ? 'JSON configuration export'
                                : 'LADDER_MARKETS env value'
                        }
                        value={outputs[format].value}
                        data-invalid={String(outputs[format].invalid)}
                        ref={element => {
                          outputRefs.current[format] = element
                        }}
                      />
                    </section>
                  ))}
                  <div className="copy-actions">
                    <button
                      id="copy-export"
                      type="button"
                      className="button button--primary"
                      disabled={!productionValidation.valid}
                      onClick={() => void copyExport(outputs[activeExport].value)}
                    >
                      Copy export
                    </button>
                    <button
                      id="select-export"
                      type="button"
                      className="button"
                      onClick={() => {
                        outputRefs.current[activeExport]?.focus()
                        outputRefs.current[activeExport]?.select()
                        setCopyStatus({ message: 'Export selected. Press Ctrl/Cmd+C to copy.' })
                      }}
                    >
                      Select all
                    </button>
                  </div>
                  <p
                    id="copy-status"
                    className="status"
                    role="status"
                    aria-live="polite"
                    data-status={copyStatus.status}
                  >
                    {copyStatus.message}
                  </p>
                  <p className="secret-note">
                    Sensitive values are redacted by default. Deliberate opt-in affects displayed
                    exports and clipboard output only; this playground never stores or sends them. A
                    nonfatal observability warning means the runtime will disable that integration,
                    not that its observability settings are valid.
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

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing playground root')
createRoot(rootElement).render(
  <ErrorBoundary>
    <Playground />
  </ErrorBoundary>
)
