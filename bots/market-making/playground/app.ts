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
  generatePreviewLadders,
  validatePlaygroundState
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
const copyStatus = required<HTMLParagraphElement>('#copy-status')
const exportTabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const exportPanels = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')]
const previewReference = required<HTMLInputElement>('#preview-reference')
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
const renderLadders = () => {
  const validation = validatePlaygroundState(state)
  if (!validation.valid) {
    ladderContainer.replaceChildren()
    ladderStatus.textContent = 'Preview unavailable while configuration is invalid.'
    ladderStatus.dataset.status = 'error'
    return
  }
  try {
    const previews = generatePreviewLadders(state)
    ladderStatus.textContent =
      previews.length === 0
        ? 'No ladder markets configured.'
        : `${previews.length} production-equivalent synthetic ladder preview${previews.length === 1 ? '' : 's'}.`
    ladderStatus.dataset.status = 'ok'
    ladderContainer.replaceChildren(
      ...previews.map((preview, previewIndex) => {
        const section = document.createElement('section')
        section.className = 'ladder-market'
        const title = document.createElement('h3')
        title.textContent = `Ladder market ${previewIndex + 1}`
        const market = document.createElement('code')
        market.textContent = preview.marketId
        const center = document.createElement('p')
        center.textContent = `Effective center ${preview.centerRateBps} BPS`
        const rows = [
          ...preview.higher.toReversed().map(rung => ({ ...rung, side: 'higher' as const })),
          ...preview.lower.map(rung => ({ ...rung, side: 'lower' as const }))
        ]
        const rungs = rows.map(row => {
          const item = document.createElement('div')
          item.className = `rung rung--${row.side}`
          const side = document.createElement('span')
          side.className = 'rung__side'
          side.textContent = row.side === 'higher' ? 'Lend buy' : 'Reduce-only sell'
          const rate = document.createElement('strong')
          rate.textContent = `${row.rateBps} BPS`
          const assets = document.createElement('span')
          assets.className = 'rung__assets'
          assets.textContent = `${formatAssets(row.assets)} assets`
          item.append(side, rate, assets)
          return item
        })
        section.append(title, market, center, ...rungs)
        return section
      })
    )
  } catch (error) {
    ladderContainer.replaceChildren()
    ladderStatus.textContent =
      error instanceof Error ? error.message : 'Invalid preview configuration'
    ladderStatus.dataset.status = 'error'
  }
}

const exporters = { yaml: exportYaml, shell: exportShell, json: exportJson }
const renderExports = () => {
  const validation = validatePlaygroundState(state)
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
      output.value = exporters[format](state)
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
