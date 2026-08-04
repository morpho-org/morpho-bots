import type { BootstrapInput, LadderInput } from './model'

import {
  BOOTSTRAP_FIELDS,
  LADDER_FIELDS,
  OBSERVABILITY_FIELDS,
  SCALAR_FIELDS,
  createDefaultBootstrap,
  createDefaultLadder,
  createDefaultPlaygroundState,
  exportJson,
  exportShell,
  exportYaml,
  generateLadderGraphicModels,
  getObservabilityStatuses,
  validatePreviewState,
  validateProductionState
} from './model'

const state = createDefaultPlaygroundState()
const required = <ElementType extends Element>(selector: string) => {
  const element = document.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing playground element: ${selector}`)
  return element
}

const controls = required<HTMLDivElement>('#controls')
const ladderContainer = required<HTMLDivElement>('#ladders')
const ladderStatus = required<HTMLParagraphElement>('#ladder-status')
const validationErrors = required<HTMLDivElement>('#validation-errors')
const observabilityStatus = required<HTMLDivElement>('#observability-status')
const copyStatus = required<HTMLParagraphElement>('#copy-status')
const exportTabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const exportPanels = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
const previewReference = required<HTMLInputElement>('#preview-reference')
const includeSensitiveValues = required<HTMLInputElement>('#include-sensitive-values')
let activeExport: 'yaml' | 'shell' | 'json' = 'yaml'
let fieldIndex = 0

type Field = readonly [string, string, string, string]

const inputFor = (
  field: Field,
  value: string | boolean,
  update: (value: string | boolean) => void
) => {
  const [key, label, help, type] = field
  const wrapper = document.createElement('label')
  wrapper.className = 'field'
  const heading = document.createElement('span')
  heading.className = 'field__heading'
  heading.textContent = label
  const hint = document.createElement('span')
  hint.className = 'field__hint'
  hint.textContent = `${key} · ${help}`
  let input: HTMLInputElement | HTMLSelectElement
  if (type === 'select') {
    input = document.createElement('select')
    for (const optionValue of ['shared-rung', 'per-book']) {
      const option = document.createElement('option')
      option.value = optionValue
      option.textContent = optionValue
      input.append(option)
    }
    input.value = String(value)
  } else {
    input = document.createElement('input')
    input.type = type === 'number' ? 'text' : type
    if (type === 'checkbox') input.checked = Boolean(value)
    else input.value = String(value)
    if (type === 'number') {
      input.inputMode = 'numeric'
      input.pattern = '-?[0-9]*'
    }
    if (type === 'password') input.autocomplete = 'off'
  }
  input.id = `field-${key}-${fieldIndex++}`
  input.dataset.field = key
  input.addEventListener('input', () => {
    update(
      input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value
    )
    renderDynamic()
  })
  wrapper.htmlFor = input.id
  wrapper.append(heading, hint, input)
  return wrapper
}

const heading = (title: string, eyebrow: string) => {
  const element = document.createElement('div')
  element.className = 'section-heading'
  const label = document.createElement('span')
  label.textContent = eyebrow
  const name = document.createElement('h2')
  name.textContent = title
  element.append(label, name)
  return element
}

const simpleSection = (
  title: string,
  eyebrow: string,
  fields: readonly Field[],
  resolve: (key: string) => string | boolean,
  update: (key: string, value: string | boolean) => void
) => {
  const element = document.createElement('section')
  element.className = 'control-section'
  const grid = document.createElement('div')
  grid.className = 'field-grid'
  for (const field of fields)
    grid.append(inputFor(field, resolve(field[0]), value => update(field[0], value)))
  element.append(heading(title, eyebrow), grid)
  return element
}

const itemControls = (kind: 'bootstrap' | 'ladder', index: number, count: number) => {
  const actions = document.createElement('div')
  actions.className = 'item-actions'
  const action = (label: string, operation: () => void, disabled = false) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.disabled = disabled
    button.addEventListener('click', operation)
    return button
  }
  const items = state[kind] as (BootstrapInput | LadderInput)[]
  actions.append(
    action('Move up', () => moveItem(items, index, index - 1), index === 0),
    action('Move down', () => moveItem(items, index, index + 1), index === count - 1),
    action(`Remove ${kind}`, () => {
      items.splice(index, 1)
      renderControls()
      renderDynamic()
    })
  )
  return actions
}

const moveItem = <Item>(items: Item[], from: number, to: number) => {
  if (to < 0 || to >= items.length) return
  const [item] = items.splice(from, 1)
  if (item !== undefined) items.splice(to, 0, item)
  renderControls()
  renderDynamic()
}

const collectionSection = <Item extends BootstrapInput | LadderInput>(
  kind: 'bootstrap' | 'ladder',
  title: string,
  fields: readonly Field[],
  items: Item[],
  create: () => Item
) => {
  const section = document.createElement('section')
  section.className = 'control-section'
  const top = heading(
    title,
    `${kind === 'bootstrap' ? 'BOOTSTRAP_MARKETS' : 'LADDER_MARKETS'} · ordered list`
  )
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'button'
  add.textContent = `Add ${kind} market`
  add.addEventListener('click', () => {
    items.push(create())
    renderControls()
    renderDynamic()
  })
  top.append(add)
  section.append(top)
  if (items.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-state'
    empty.textContent = `No ${kind} markets configured.`
    section.append(empty)
  }
  items.forEach((item, index) => {
    const card = document.createElement('fieldset')
    card.className = 'market-card'
    const legend = document.createElement('legend')
    legend.textContent = `${title} ${index + 1}`
    const grid = document.createElement('div')
    grid.className = 'field-grid'
    for (const field of fields) {
      const key = field[0] as keyof Item
      grid.append(
        inputFor(field, item[key] as string | boolean, value => {
          Object.assign(item, { [key]: key === 'autoRefill' ? Boolean(value) : String(value) })
        })
      )
    }
    card.append(legend, itemControls(kind, index, items.length), grid)
    section.append(card)
  })
  return section
}

const firstAllowlistedMarket = () =>
  state.scalar.MARKET_IDS.split(',')
    .map(value => value.trim())
    .find(Boolean)

const renderControls = () => {
  fieldIndex = 0
  controls.replaceChildren(
    simpleSection(
      'Runtime & setup',
      'Core configuration',
      SCALAR_FIELDS,
      key => state.scalar[key as keyof typeof state.scalar],
      (key, value) => {
        state.scalar[key as keyof typeof state.scalar] = String(value)
      }
    ),
    collectionSection('bootstrap', 'Position bootstrap', BOOTSTRAP_FIELDS, state.bootstrap, () =>
      createDefaultBootstrap(firstAllowlistedMarket())
    ),
    collectionSection('ladder', 'Live ladder', LADDER_FIELDS, state.ladder, () =>
      createDefaultLadder(firstAllowlistedMarket())
    ),
    simpleSection(
      'Observability',
      'Environment-only variables',
      OBSERVABILITY_FIELDS,
      key => state.observability[key as keyof typeof state.observability],
      (key, value) => {
        state.observability[key as keyof typeof state.observability] = String(value)
      }
    )
  )
}

previewReference.value = state.referenceRateBps
previewReference.addEventListener('input', () => {
  state.referenceRateBps = previewReference.value
  renderDynamic()
})

const formatAssets = (value: string) => Intl.NumberFormat('en-US').format(BigInt(value))
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const svgElement = <Name extends keyof SVGElementTagNameMap>(
  name: Name,
  attributes: Record<string, string | number> = {}
) => {
  const element = document.createElementNS(SVG_NAMESPACE, name)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value))
  return element
}

const renderGraphic = (
  graphic: ReturnType<typeof generateLadderGraphicModels>[number],
  previewIndex: number
) => {
  const section = document.createElement('section')
  section.className = 'ladder-market'
  const headingRow = document.createElement('div')
  headingRow.className = 'ladder-heading'
  const title = document.createElement('h3')
  title.id = `ladder-heading-${previewIndex}`
  title.textContent = `Ladder market ${previewIndex + 1}`
  const market = document.createElement('code')
  market.dataset.parameter = 'marketId'
  market.textContent = `MARKET ID · ${graphic.marketId}`
  headingRow.append(title, market)

  const figure = document.createElement('figure')
  figure.className = 'ladder-graphic'
  figure.setAttribute('aria-labelledby', title.id)
  const chartWidth = 1120
  const chartHeight = graphic.plotHeight + 64
  const svg = svgElement('svg', {
    viewBox: `0 0 ${chartWidth} ${chartHeight}`,
    width: chartWidth,
    height: chartHeight,
    role: 'img',
    'aria-labelledby': `ladder-title-${previewIndex} ladder-description-${previewIndex}`,
    preserveAspectRatio: 'xMidYMid meet'
  })
  const svgTitle = svgElement('title', { id: `ladder-title-${previewIndex}` })
  svgTitle.textContent = `Ladder market ${previewIndex + 1} rate, allocation, and offer maxAssets graphic`
  const description = svgElement('desc', { id: `ladder-description-${previewIndex}` })
  description.textContent = `Vertical rate axis from ${graphic.axis.minimumRateBps} to ${graphic.axis.maximumRateBps} BPS. Reference ${graphic.axis.referenceRateBps} BPS, quote center ${graphic.axis.centerRateBps} BPS, higher-rate lend rungs and lower-rate reduce-only rungs. Every rung has an outlined offer maxAssets bar and a nested allocation fill. An associated semantic table enumerates every exact rate, allocation, offer maxAssets, and side.`
  svg.append(svgTitle, description)

  const axisX = 180
  const rightX = 1096
  const axis = svgElement('line', {
    x1: axisX,
    y1: 24,
    x2: axisX,
    y2: graphic.plotHeight + 40,
    class: 'ladder-axis'
  })
  axis.dataset.parameter = 'minimumRateBps maximumRateBps'
  svg.append(axis)
  for (const [label, y] of [
    [`MAX ${graphic.axis.maximumRateBps}`, 24],
    [`MIN ${graphic.axis.minimumRateBps}`, graphic.plotHeight + 40]
  ] as const) {
    const tick = svgElement('line', { x1: 172, y1: y, x2: 188, y2: y, class: 'axis-tick' })
    const text = svgElement('text', { x: 164, y: y + 4, class: 'axis-label', 'text-anchor': 'end' })
    text.textContent = `${label} BPS`
    svg.append(tick, text)
  }
  const referenceY = graphic.rateToY(graphic.axis.referenceRateBps)
  const centerY = graphic.rateToY(graphic.axis.centerRateBps)
  const nearestHigher = graphic.rungs.findLast(rung => rung.side === 'higher')
  const nearestLower = graphic.rungs.find(rung => rung.side === 'lower')
  if (nearestHigher && nearestLower) {
    const top = nearestHigher.y + 11
    const bottom = nearestLower.y - 11
    const gapBand = svgElement('rect', {
      x: axisX,
      y: top,
      width: rightX - axisX,
      height: Math.max(0, bottom - top),
      class: 'spread-gap'
    })
    gapBand.dataset.parameter = 'spreadBps'
    const gapLabel = svgElement('text', {
      x: axisX + 16,
      y: (top + bottom) / 2 + 4,
      class: 'spread-gap-label'
    })
    gapLabel.textContent = `SPREAD GAP · ${graphic.gapBps} BPS`
    svg.append(gapBand, gapLabel)
  }
  const referenceLine = svgElement('line', {
    x1: axisX,
    y1: referenceY,
    x2: rightX,
    y2: referenceY,
    class: 'reference-line'
  })
  referenceLine.dataset.parameter = 'referenceRateBps'
  const referenceLabel = svgElement('text', {
    x: rightX - 8,
    y: referenceY - 7,
    class: 'reference-label',
    'text-anchor': 'end'
  })
  referenceLabel.textContent = `REFERENCE ${graphic.axis.referenceRateBps}`
  const centerLine = svgElement('line', {
    x1: axisX,
    y1: centerY,
    x2: rightX,
    y2: centerY,
    class: 'center-line'
  })
  centerLine.dataset.parameter = 'quotePremiumBps'
  const centerLabel = svgElement('text', {
    x: rightX - 8,
    y: centerY + 15,
    class: 'center-label',
    'text-anchor': 'end'
  })
  centerLabel.textContent = `CENTER ${graphic.axis.centerRateBps}`
  svg.append(referenceLine, referenceLabel, centerLine, centerLabel)

  for (const rung of graphic.rungs) {
    const group = svgElement('g', { class: `rung-group rung-group--${rung.side}` })
    const marker =
      rung.side === 'higher'
        ? svgElement('path', {
            d: `M 172 ${rung.y} l -8 -6 v 12 z`,
            class: 'rung-marker rung-marker--higher'
          })
        : svgElement('circle', {
            cx: 166,
            cy: rung.y,
            r: 6,
            class: 'rung-marker rung-marker--lower'
          })
    const baseline = svgElement('line', {
      x1: 190,
      y1: rung.y,
      x2: rightX - 12,
      y2: rung.y,
      class: 'rung-guide'
    })
    const offerCapWidth = Math.max(28, Math.round(470 * rung.offerMaxBarRatio))
    const allocationWidth = Math.max(12, Math.round(470 * rung.allocationBarRatio))
    const offerCap = svgElement('rect', {
      x: 206,
      y: rung.y - 10,
      width: offerCapWidth,
      height: 20,
      rx: 3,
      class: `ladder-rung offer-cap-bar offer-cap-bar--${rung.side}`
    })
    offerCap.dataset.rateBps = rung.rateBps
    offerCap.dataset.allocationAssets = rung.allocationAssets
    offerCap.dataset.offerMaxAssets = rung.offerMaxAssets
    offerCap.dataset.side = rung.side
    offerCap.dataset.parameter =
      'sizeSkewBps lowerRateBudgetAssets higherRateBudgetAssets targetMarketExposureAssets maximumTotalExposureAssets minimumOfferAssets'
    const allocation = svgElement('rect', {
      x: 206,
      y: rung.y - 4,
      width: allocationWidth,
      height: 8,
      rx: 2,
      class: `allocation-bar allocation-bar--${rung.side}`
    })
    allocation.dataset.allocationAssets = rung.allocationAssets
    allocation.dataset.offerMaxAssets = rung.offerMaxAssets
    allocation.dataset.side = rung.side
    const tooltip = svgElement('title')
    tooltip.textContent = `${rung.sideLabel}; ${rung.rateBps} BPS; allocation ${formatAssets(rung.allocationAssets)} assets; offer maxAssets ${formatAssets(rung.offerMaxAssets)} assets`
    const rate = svgElement('text', { x: 216, y: rung.y + 4, class: 'rung-rate' })
    rate.textContent = `${rung.rateBps} BPS`
    const details = svgElement('text', {
      x: rightX - 8,
      y: rung.y + 4,
      class: 'rung-details',
      'text-anchor': 'end'
    })
    details.textContent = `${rung.sideLabel.toUpperCase()} · allocation ${formatAssets(rung.allocationAssets)} · offer maxAssets ${formatAssets(rung.offerMaxAssets)}`
    group.append(tooltip, baseline, offerCap, allocation, marker, rate, details)
    svg.append(group)
  }
  const scrollHint = document.createElement('p')
  scrollHint.className = 'ladder-scroll-hint'
  scrollHint.textContent = 'Scroll the plot horizontally or vertically to reach every exact rung.'
  const scroll = document.createElement('div')
  scroll.className = 'ladder-scroll'
  scroll.tabIndex = 0
  scroll.setAttribute('role', 'region')
  scroll.setAttribute('aria-label', `Scrollable ladder plot for market ${previewIndex + 1}`)
  scroll.append(svg)
  figure.append(scrollHint, scroll)

  const semanticTable = document.createElement('div')
  semanticTable.className = 'visually-hidden'
  const table = document.createElement('table')
  table.className = 'rung-table'
  const caption = document.createElement('caption')
  caption.textContent = `Exact ladder rungs for market ${previewIndex + 1}`
  const tableHead = document.createElement('thead')
  const headingRowElement = document.createElement('tr')
  for (const headingText of [
    'Side',
    'Rate (BPS)',
    'Allocation (assets)',
    'Offer maxAssets (assets)'
  ]) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = headingText
    headingRowElement.append(cell)
  }
  tableHead.append(headingRowElement)
  const tableBody = document.createElement('tbody')
  for (const rung of graphic.rungs) {
    const row = document.createElement('tr')
    const side = document.createElement('th')
    side.scope = 'row'
    side.textContent = rung.sideLabel
    const rate = document.createElement('td')
    rate.textContent = rung.rateBps
    const allocation = document.createElement('td')
    allocation.textContent = rung.allocationAssets
    const offerMaxAssets = document.createElement('td')
    offerMaxAssets.textContent = rung.offerMaxAssets
    row.append(side, rate, allocation, offerMaxAssets)
    tableBody.append(row)
  }
  table.append(caption, tableHead, tableBody)
  semanticTable.append(table)
  figure.append(semanticTable)

  const legend = document.createElement('div')
  legend.className = 'ladder-legend'
  const legendItems: readonly (readonly [string, string])[] = [
    ['triangle', 'Higher rate · LEND'],
    ['circle', 'Lower rate · REDUCE-ONLY'],
    ['offer-cap', 'Outlined bar = offer maxAssets'],
    ['allocation', 'Nested fill = allocation']
  ]
  for (const [kind, label] of legendItems) {
    const item = document.createElement('span')
    const marker = document.createElement('i')
    marker.className = `legend-marker legend-marker--${kind}`
    item.append(marker, label)
    legend.append(item)
  }
  const stateless = document.createElement('strong')
  stateless.textContent =
    'Stateless configured output · live capacities and current offers remain excluded'
  legend.append(stateless)
  figure.append(legend)

  const callouts = document.createElement('dl')
  callouts.className = 'ladder-callouts'
  for (const callout of graphic.callouts) {
    const item = document.createElement('div')
    item.className = 'ladder-callout'
    item.dataset.parameter = callout.parameters.join(' ')
    const term = document.createElement('dt')
    term.textContent = callout.label
    const detail = document.createElement('dd')
    detail.textContent = callout.value
    item.append(term, detail)
    callouts.append(item)
  }
  section.append(headingRow, figure, callouts)
  return section
}

const invalidGraphic = (errors: readonly string[]) => {
  const element = document.createElement('div')
  element.className = 'ladder-invalid'
  element.setAttribute('role', 'img')
  element.setAttribute(
    'aria-label',
    `Invalid ladder graphic. No offers shown. ${errors.join('. ')}`
  )
  const title = document.createElement('strong')
  title.textContent = 'Invalid ladder graphic'
  const detail = document.createElement('span')
  detail.textContent = 'No synthetic offers are shown until the configuration is valid.'
  element.append(title, detail)
  return element
}

const renderLadders = () => {
  const validation = validatePreviewState(state)
  if (!validation.valid) {
    ladderContainer.replaceChildren(invalidGraphic(validation.errors))
    ladderStatus.textContent = 'Preview unavailable while configuration is invalid.'
    ladderStatus.dataset.status = 'error'
    return
  }
  try {
    const graphics = generateLadderGraphicModels(state)
    ladderStatus.textContent =
      graphics.length === 0
        ? 'No ladder markets configured.'
        : `${graphics.length} production-equivalent synthetic ladder graphic${graphics.length === 1 ? '' : 's'}.`
    ladderStatus.dataset.status = 'ok'
    ladderContainer.replaceChildren(...graphics.map(renderGraphic))
  } catch (error) {
    ladderContainer.replaceChildren(
      invalidGraphic([error instanceof Error ? error.message : 'Invalid preview configuration'])
    )
    ladderStatus.textContent =
      error instanceof Error ? error.message : 'Invalid preview configuration'
    ladderStatus.dataset.status = 'error'
  }
}

const exporters = { yaml: exportYaml, shell: exportShell, json: exportJson }
const renderObservabilityStatus = () => {
  const statuses = getObservabilityStatuses(state)
  const warnings = statuses.some(status => status.level === 'warning')
  const title = document.createElement('strong')
  title.textContent = warnings
    ? 'Core configuration remains exportable; observability has nonfatal warnings:'
    : 'Best-effort observability status:'
  const list = document.createElement('ul')
  for (const status of statuses) {
    const item = document.createElement('li')
    item.dataset.level = status.level
    item.textContent = status.message
    list.append(item)
  }
  observabilityStatus.dataset.status = warnings ? 'warning' : 'status'
  observabilityStatus.replaceChildren(title, list)
}
const renderExports = () => {
  const validation = validateProductionState(state)
  renderObservabilityStatus()
  validationErrors.replaceChildren()
  validationErrors.hidden = validation.valid
  if (!validation.valid) {
    const title = document.createElement('strong')
    title.textContent = 'Configuration is invalid. Fix these errors before exporting:'
    const list = document.createElement('ul')
    for (const error of validation.errors) {
      const item = document.createElement('li')
      item.textContent = error
      list.append(item)
    }
    validationErrors.append(title, list)
  }
  for (const panel of exportPanels) {
    const format = panel.dataset.panel as keyof typeof exporters
    const output = panel.querySelector<HTMLTextAreaElement>('textarea')
    if (!output) continue
    try {
      output.value = exporters[format](state, {
        includeSensitiveValues: includeSensitiveValues.checked
      })
      output.dataset.invalid = 'false'
    } catch (error) {
      output.value = error instanceof Error ? error.message : 'Configuration is invalid'
      output.dataset.invalid = 'true'
    }
  }
  required<HTMLButtonElement>('#copy-export').disabled = !validation.valid
}

const activateTab = (index: number, focus = false) => {
  const selectedTab = exportTabs[index]
  if (!selectedTab) return
  activeExport = selectedTab.dataset.export as typeof activeExport
  exportTabs.forEach((tab, tabIndex) => {
    const selected = tabIndex === index
    tab.classList.toggle('is-active', selected)
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    if (selected && focus) tab.focus()
  })
  exportPanels.forEach(panel => {
    panel.hidden = panel.dataset.panel !== activeExport
  })
}

exportTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(index))
  tab.addEventListener('keydown', event => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % exportTabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + exportTabs.length) % exportTabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = exportTabs.length - 1
    else return
    event.preventDefault()
    activateTab(next, true)
  })
})

const activeOutput = () => required<HTMLTextAreaElement>(`#export-${activeExport}`)
const fallbackCopy = (output: HTMLTextAreaElement) => {
  output.focus()
  output.select()
  return document.execCommand('copy')
}
const copyExport = async () => {
  const output = activeOutput()
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(output.value)
    else if (!fallbackCopy(output)) throw new Error('Clipboard API unavailable')
    copyStatus.textContent = 'Copied to clipboard.'
    copyStatus.dataset.status = 'ok'
  } catch {
    output.focus()
    output.select()
    copyStatus.textContent = 'Copy was blocked. The full export is selected; press Ctrl/Cmd+C.'
    copyStatus.dataset.status = 'error'
  }
}

required<HTMLButtonElement>('#copy-export').addEventListener('click', () => void copyExport())
includeSensitiveValues.addEventListener('change', () => {
  renderExports()
  copyStatus.textContent = includeSensitiveValues.checked
    ? 'Sensitive values are visible and will be copied.'
    : 'Sensitive values are redacted.'
  copyStatus.dataset.status = includeSensitiveValues.checked ? 'error' : 'ok'
})
required<HTMLButtonElement>('#select-export').addEventListener('click', () => {
  activeOutput().focus()
  activeOutput().select()
  copyStatus.textContent = 'Export selected. Press Ctrl/Cmd+C to copy.'
})

const renderDynamic = () => {
  renderLadders()
  renderExports()
  copyStatus.textContent = ''
}

renderControls()
activateTab(0)
renderDynamic()

// Browser smoke tests inspect this marker without exposing mutable application state.
document.documentElement.dataset.playgroundReady = 'true'
