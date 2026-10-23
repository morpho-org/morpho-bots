import type { Graph } from './graph'

import { layout } from './core'

/** What a graph was built into, for tests that pin it; the layout is not API and may change. */
export const layoutOf = (graph: Graph) => graph[layout]
