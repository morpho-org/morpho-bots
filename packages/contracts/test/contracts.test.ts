import { describe, expect, it } from 'vitest'

import { CrossedBooksResolver, Executor } from '../dist/index.js'

/** The Midnight singleton `midnight-crossed-books` bakes into its resolver by default. */
const MIDNIGHT = '0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A'

// Both contracts are CREATE2 singletons deployed once per chain, and every consuming bot defaults
// to the address derived here, then refuses to start if it holds no code. That address covers the
// whole init code, so a compiler setting, a solc bump, or any edit to the `.sol` source — a comment
// included — retargets the bots at an address nobody deployed, with nothing failing until a bot
// boots. Pinning makes that a failing test instead.
//
// A pin change is therefore a deployment, not an edit: deploy at the new address on every chain the
// consuming bot runs before merging, with `deploy:executor` / `deploy:crossed-books-resolver`.
describe('deterministic singleton addresses', () => {
  it('derives the deployed Executor', () => {
    expect(Executor.with().address).toBe('0x844124693a429CB9eD04472a23d6aEBFd1395dFe')
  })

  it('derives the deployed CrossedBooksResolver', () => {
    expect(CrossedBooksResolver.with(MIDNIGHT).address).toBe(
      '0xc7FB5fB4967944336F866849043fc4d3cD163b81'
    )
  })
})
