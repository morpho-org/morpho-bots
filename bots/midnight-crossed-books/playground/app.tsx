import { useForm } from '@tanstack/react-form'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable
} from '@tanstack/react-table'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { PlaygroundState, StrategyInput } from './model'

import {
  STRATEGY_FIELDS,
  createDefaultPlaygroundState,
  createPlaygroundShareUrl,
  decodePlaygroundFragment,
  encodePlaygroundFragment,
  exportCompactEnvironmentJson,
  exportReadableEnvironmentJson,
  parseStrategyImport,
  validateStrategy
} from './model'

type Status = { message: string; status?: 'ok' | 'error' }
type SummaryRow = { parameter: string; environment: string; value: string; meaning: string }

const initialState = (): { state: PlaygroundState; status: Status } => {
  try {
    return { state: decodePlaygroundFragment(window.location.hash), status: { message: '' } }
  } catch (error) {
    return {
      state: createDefaultPlaygroundState(),
      status: {
        message: `Share URL ignored: ${error instanceof Error ? error.message : 'invalid fragment'}`,
        status: 'error'
      }
    }
  }
}

const column = createColumnHelper<SummaryRow>()
const columns = [
  column.accessor('parameter', { header: 'Strategy parameter', cell: info => info.getValue() }),
  column.accessor('environment', { header: 'Environment key', cell: info => info.getValue() }),
  column.accessor('value', { header: 'Value', cell: info => info.getValue() }),
  column.accessor('meaning', { header: 'Meaning', cell: info => info.getValue() })
]

const StrategyTable = ({ strategy }: { strategy: StrategyInput }) => {
  const data = useMemo(
    () =>
      STRATEGY_FIELDS.map(([key, label, environment, meaning]) => ({
        parameter: label,
        environment,
        value: strategy[key],
        meaning
      })),
    [strategy]
  )
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <table className="summary-table">
      <caption>Ordered crossed-books strategy configuration</caption>
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

const FragmentSync = ({
  state,
  onStatus
}: {
  state: PlaygroundState
  onStatus: (s: Status) => void
}) => {
  const lastFragment = useRef(window.location.hash)
  useEffect(() => {
    if (!validateStrategy(state.strategy).valid) {
      onStatus({
        message: 'Share URL remains at the last valid configuration while edits are invalid.',
        status: 'error'
      })
      return
    }
    try {
      const fragment = encodePlaygroundFragment(state)
      if (fragment !== lastFragment.current) {
        history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}${fragment}`
        )
        lastFragment.current = fragment
      }
      onStatus({ message: 'Share URL synchronized.', status: 'ok' })
    } catch (error) {
      onStatus({
        message: error instanceof Error ? error.message : 'Unable to synchronize share URL',
        status: 'error'
      })
    }
  }, [state, onStatus])
  return null
}

const output = (operation: () => string) => {
  try {
    return { value: operation(), invalid: false }
  } catch (error) {
    return { value: error instanceof Error ? error.message : 'Invalid strategy', invalid: true }
  }
}

const Playground = () => {
  const initial = useRef(initialState()).current
  const form = useForm({ defaultValues: initial.state })
  const [importText, setImportText] = useState('')
  const [importStatus, setImportStatus] = useState<Status>({ message: '' })
  const [urlStatus, setUrlStatus] = useState<Status>(initial.status)
  const [copyStatus, setCopyStatus] = useState<Status>({ message: '' })
  const [activeExport, setActiveExport] = useState<'readable' | 'compact'>('readable')
  const shareRef = useRef<HTMLInputElement>(null)
  const outputRef = useRef<HTMLTextAreaElement>(null)
  const onUrlStatus = React.useCallback((status: Status) => setUrlStatus(status), [])

  useEffect(() => {
    document.documentElement.dataset.playgroundReady = 'true'
    return () => {
      delete document.documentElement.dataset.playgroundReady
    }
  }, [])

  const copy = async (
    value: string,
    fallback: HTMLInputElement | HTMLTextAreaElement | null,
    label: string
  ) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus({ message: `${label} copied.`, status: 'ok' })
    } catch {
      fallback?.focus()
      fallback?.select()
      setCopyStatus({
        message: `Copy blocked; ${label} selected. Press Ctrl/Cmd+C.`,
        status: 'error'
      })
    }
  }

  return (
    <form.Subscribe selector={state => state.values}>
      {state => {
        const validation = validateStrategy(state.strategy)
        const readable = output(() => exportReadableEnvironmentJson(state.strategy))
        const compact = output(() => exportCompactEnvironmentJson(state.strategy))
        const currentOutput = activeExport === 'readable' ? readable : compact
        const shareUrl = output(() => createPlaygroundShareUrl(state, window.location))
        return (
          <>
            <FragmentSync state={state} onStatus={onUrlStatus} />
            <header className="topbar">
              <div>
                <p className="eyebrow">Morpho · stateless local planner</p>
                <h1>Crossed-books configuration playground</h1>
              </div>
              <p>
                Only ordered crossed-books strategy and bot behavior. No core setup, runtime
                endpoints, signing material, observability, persistence, backend, or network access.
              </p>
            </header>
            <main>
              <section className="monitor" aria-labelledby="summary-title">
                <p className="section-label">Sticky strategy summary</p>
                <h2 id="summary-title">Resolver behavior</h2>
                {validation.valid ? (
                  <StrategyTable strategy={state.strategy} />
                ) : (
                  <div role="alert" data-status="error">
                    <strong>Summary unavailable</strong>
                    <ul>
                      {validation.errors.map(error => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="note">
                  Crossed-books has no bootstrap or ladder domain object, so this playground does
                  not invent one. The table mirrors the bot’s native matching, profitability, and
                  cadence controls without live book data.
                </p>
              </section>
              <section className="workspace" aria-label="Configuration workspace">
                <section className="card share" aria-labelledby="share-title">
                  <h2 id="share-title">Share URL</h2>
                  <p role="status" aria-live="polite" data-status={urlStatus.status}>
                    {urlStatus.message}
                  </p>
                  <label htmlFor="share-url">Canonical URL for the current valid strategy</label>
                  <input
                    id="share-url"
                    readOnly
                    value={shareUrl.value}
                    aria-invalid={shareUrl.invalid}
                    ref={shareRef}
                  />
                  <div className="actions">
                    <button
                      type="button"
                      disabled={shareUrl.invalid}
                      onClick={() => void copy(shareUrl.value, shareRef.current, 'Share URL')}
                    >
                      Copy share URL
                    </button>
                  </div>
                </section>
                <section className="card" aria-labelledby="import-title">
                  <h2 id="import-title">Paste-only JSON import</h2>
                  <p>
                    Paste strategy JSON or a compact JSON environment string. Applying is strict and
                    atomic.
                  </p>
                  <label htmlFor="strategy-import">Pasted crossed-books strategy JSON</label>
                  <textarea
                    id="strategy-import"
                    value={importText}
                    onChange={event => setImportText(event.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        const strategy = parseStrategyImport(importText)
                        form.setFieldValue('strategy', strategy)
                        setImportStatus({
                          message: 'Applied pasted JSON atomically.',
                          status: 'ok'
                        })
                      } catch (error) {
                        setImportStatus({
                          message: error instanceof Error ? error.message : 'Invalid import',
                          status: 'error'
                        })
                      }
                    }}
                  >
                    Apply pasted JSON
                  </button>
                  <p role="status" aria-live="polite" data-status={importStatus.status}>
                    {importStatus.message}
                  </p>
                </section>
                <section className="card" aria-labelledby="editor-title">
                  <p className="section-label">Strategy configuration</p>
                  <h2 id="editor-title">Ordered bot controls</h2>
                  <div className="field-grid">
                    {STRATEGY_FIELDS.map(([key, label, environment, meaning]) => (
                      <form.Field key={key} name={`strategy.${key}`}>
                        {field => (
                          <label className="field" htmlFor={key}>
                            <span>{label}</span>
                            <small>
                              {environment} · {meaning}
                            </small>
                            <input
                              id={key}
                              inputMode="numeric"
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={event => field.handleChange(event.target.value)}
                            />
                          </label>
                        )}
                      </form.Field>
                    ))}
                  </div>
                </section>
                <section className="card" aria-labelledby="exports-title">
                  <h2 id="exports-title">Configuration exports</h2>
                  <div className="tabs" role="tablist" aria-label="Configuration output">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeExport === 'readable'}
                      onClick={() => setActiveExport('readable')}
                    >
                      Readable JSON
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeExport === 'compact'}
                      onClick={() => setActiveExport('compact')}
                    >
                      Compact JSON environment string
                    </button>
                  </div>
                  <textarea
                    readOnly
                    aria-label={`${activeExport} JSON output`}
                    value={currentOutput.value}
                    aria-invalid={currentOutput.invalid}
                    ref={outputRef}
                  />
                  <button
                    type="button"
                    disabled={currentOutput.invalid}
                    onClick={() =>
                      void copy(
                        currentOutput.value,
                        outputRef.current,
                        activeExport === 'readable'
                          ? 'Readable JSON'
                          : 'Compact JSON environment string'
                      )
                    }
                  >
                    Copy output
                  </button>
                  <p role="status" aria-live="polite" data-status={copyStatus.status}>
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

const root = document.getElementById('root')
if (!root) throw new Error('Missing playground root')
createRoot(root).render(<Playground />)
