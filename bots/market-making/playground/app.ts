import {
  BOOTSTRAP_FIELDS,
  LADDER_FIELDS,
  OBSERVABILITY_FIELDS,
  SCALAR_FIELDS,
  createDefaultPlaygroundState,
  exportEnvironment,
  exportJson,
  exportYaml,
  generatePreviewLadder
} from './model'

const state = createDefaultPlaygroundState()

const required = <ElementType extends Element>(selector: string) => {
  const element = document.querySelector<ElementType>(selector)
  if (!element) throw new Error(`Missing playground element: ${selector}`)
  return element
}

const controls = required<HTMLDivElement>('#controls')
const ladder = required<HTMLDivElement>('#ladder')
const ladderStatus = required<HTMLParagraphElement>('#ladder-status')
const exportOutput = required<HTMLTextAreaElement>('#export-output')
const copyStatus = required<HTMLParagraphElement>('#copy-status')
const exportTabs = [...document.querySelectorAll<HTMLButtonElement>('[data-export]')]
let activeExport: 'yaml' | 'env' | 'json' = 'yaml'
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
    render()
  })
  wrapper.htmlFor = input.id
  wrapper.append(heading, hint, input)
  return wrapper
}

const section = (
  title: string,
  eyebrow: string,
  fields: readonly Field[],
  resolve: (key: string) => string | boolean,
  update: (key: string, value: string | boolean) => void
) => {
  const element = document.createElement('section')
  element.className = 'control-section'
  element.dataset.section = eyebrow
  const heading = document.createElement('div')
  heading.className = 'section-heading'
  const headingLabel = document.createElement('span')
  headingLabel.textContent = eyebrow
  const headingTitle = document.createElement('h2')
  headingTitle.textContent = title
  heading.append(headingLabel, headingTitle)
  const grid = document.createElement('div')
  grid.className = 'field-grid'
  for (const field of fields)
    grid.append(inputFor(field, resolve(field[0]), value => update(field[0], value)))
  element.append(heading, grid)
  return element
}

controls.append(
  section(
    'Runtime & setup',
    'Core configuration',
    SCALAR_FIELDS,
    key => state.scalar[key as keyof typeof state.scalar],
    (key, value) => {
      state.scalar[key as keyof typeof state.scalar] = String(value)
    }
  ),
  section(
    'Position bootstrap',
    'BOOTSTRAP_MARKETS · one preview market',
    BOOTSTRAP_FIELDS,
    key => state.bootstrap[key as keyof typeof state.bootstrap],
    (key, value) => {
      const typedKey = key as keyof typeof state.bootstrap
      Object.assign(state.bootstrap, {
        [typedKey]: typedKey === 'autoRefill' ? Boolean(value) : String(value)
      })
    }
  ),
  section(
    'Live ladder',
    'LADDER_MARKETS · one preview market',
    LADDER_FIELDS,
    key => state.ladder[key as keyof typeof state.ladder],
    (key, value) => {
      state.ladder[key as keyof typeof state.ladder] = String(value)
    }
  ),
  section(
    'Observability',
    'Environment-only variables',
    OBSERVABILITY_FIELDS,
    key => state.observability[key as keyof typeof state.observability],
    (key, value) => {
      state.observability[key as keyof typeof state.observability] = String(value)
    }
  )
)

const previewReference = required<HTMLInputElement>('#preview-reference')
previewReference.value = state.referenceRateBps
previewReference.addEventListener('input', () => {
  state.referenceRateBps = previewReference.value
  render()
})

const formatAssets = (value: string) => Intl.NumberFormat('en-US').format(BigInt(value))

const renderLadder = () => {
  try {
    const preview = generatePreviewLadder(state)
    ladderStatus.textContent = `Effective center ${preview.centerRateBps} BPS · synthetic preview only`
    ladderStatus.dataset.status = 'ok'
    const rows = [
      ...preview.higher.toReversed().map(rung => ({ ...rung, side: 'higher' as const })),
      ...preview.lower.map(rung => ({ ...rung, side: 'lower' as const }))
    ]
    const maximumAssets = rows.reduce((maximum, row) => {
      const assets = BigInt(row.assets)
      return assets > maximum ? assets : maximum
    }, 1n)
    ladder.replaceChildren(
      ...rows.map(row => {
        const item = document.createElement('div')
        item.className = `rung rung--${row.side}`
        const width = Number((BigInt(row.assets) * 100n) / maximumAssets)
        const side = document.createElement('span')
        side.className = 'rung__side'
        side.textContent = row.side === 'higher' ? 'Lend buy' : 'Reduce-only sell'
        const rate = document.createElement('strong')
        rate.textContent = `${row.rateBps} `
        const unit = document.createElement('small')
        unit.textContent = 'BPS'
        rate.append(unit)
        const bar = document.createElement('span')
        bar.className = 'rung__bar'
        bar.style.setProperty('--rung-width', `${Math.max(width, 4)}%`)
        const assets = document.createElement('span')
        assets.className = 'rung__assets'
        assets.textContent = `${formatAssets(row.assets)} assets`
        item.append(side, rate, bar, assets)
        return item
      })
    )
  } catch (error) {
    ladder.replaceChildren()
    ladderStatus.textContent =
      error instanceof Error ? error.message : 'Invalid preview configuration'
    ladderStatus.dataset.status = 'error'
  }
}

const selectedExport = () => {
  if (activeExport === 'yaml') return exportYaml(state)
  if (activeExport === 'env') return exportEnvironment(state)
  return exportJson(state)
}

const renderExport = () => {
  exportOutput.value = selectedExport()
  for (const tab of exportTabs) {
    const selected = tab.dataset.export === activeExport
    tab.classList.toggle('is-active', selected)
    tab.setAttribute('aria-selected', String(selected))
  }
}

const render = () => {
  renderLadder()
  renderExport()
  copyStatus.textContent = ''
}

for (const tab of exportTabs) {
  tab.addEventListener('click', () => {
    activeExport = tab.dataset.export as typeof activeExport
    renderExport()
  })
}

const fallbackCopy = () => {
  exportOutput.focus()
  exportOutput.select()
  return document.execCommand('copy')
}

const copyExport = async () => {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(exportOutput.value)
    else if (!fallbackCopy()) throw new Error('Clipboard API unavailable')
    copyStatus.textContent = 'Copied to clipboard.'
    copyStatus.dataset.status = 'ok'
  } catch {
    exportOutput.focus()
    exportOutput.select()
    copyStatus.textContent = 'Copy was blocked. The full export is selected; press Ctrl/Cmd+C.'
    copyStatus.dataset.status = 'error'
  }
}

required<HTMLButtonElement>('#copy-export').addEventListener('click', () => {
  void copyExport()
})

required<HTMLButtonElement>('#select-export').addEventListener('click', () => {
  exportOutput.focus()
  exportOutput.select()
  copyStatus.textContent = 'Export selected. Press Ctrl/Cmd+C to copy.'
})

render()
