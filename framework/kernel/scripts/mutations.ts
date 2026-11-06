type Edit = Readonly<{ find: string; replace: string }>

type Cover = Edit & Readonly<{ why: string }>

/**
 * Single-guard mutations of the reducer, or of the source `file` names. Each removes or weakens one
 * check the specification relies on, and the traces must fail for every one of them, except a guard
 * another one already enforces. That one names its cover, and the traces must fail once both are
 * disabled. Every `find` must match its file, `src/kernel.ts` by default, exactly once.
 */
type Mutation = Edit & Readonly<{ id: string; file?: string; coveredBy?: Cover }>

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'a chain refused at start runs anyway',
    find: "if (s.lifecycle.kind === 'starting') stop(s, out, 'refused', event.reason)",
    replace: ''
  },
  {
    id: 'the adapter starts on finality lagging past its window',
    file: 'src/chain-adapter.ts',
    find: 'if (lag >= options.reorgDepth)',
    replace: 'if (false)'
  },
  {
    id: 'finality below the window is not held',
    file: 'src/chain-adapter.ts',
    find: 'if (finalized.number <= tip.number - options.reorgDepth) {',
    replace: 'if (false) {'
  },
  {
    id: 'an unserved finality tag is retried forever',
    file: 'src/chain-adapter.ts',
    find: "if (!tip) return dispatch({ type: 'Refuse', reason })",
    replace: ''
  },
  {
    id: 'a chain without a safe tag leaves enrollment waiting',
    file: 'src/chain-adapter.ts',
    find: 'if (safe === null)',
    replace: 'if (false)'
  },
  {
    id: 'held finality alarms on every poll',
    file: 'src/chain-adapter.ts',
    find: 'if (!holding)',
    replace: 'if (true)'
  },
  {
    id: 'held finality never clears its alarm',
    file: 'src/chain-adapter.ts',
    find: '    holding = false\n',
    replace: ''
  },
  {
    id: 'a fresh start takes a nonce that is not final',
    find: 'if (event.safe !== event.latest) return',
    replace: ''
  },
  {
    id: 'finality ignores canonicality',
    find: 'e.block <= s.finalized.number && canonical(s, e)',
    replace: 'e.block <= s.finalized.number',
    coveredBy: {
      find: 'if (record.resolution && record.resolution.block > fork) delete record.resolution',
      replace: '',
      why: 'evidence is admitted only when canonical, and a reorg deletes everything above the fork in the same step'
    }
  },
  {
    id: 'the latch allows new risk',
    find: "s.lifecycle.kind === 'running' && !latched(s)",
    replace: "s.lifecycle.kind === 'running'"
  },
  {
    id: 'a nonce fill runs outside recovery',
    find: "mode === 'recovery' && payload.value === 0n",
    replace: 'payload.value === 0n'
  },
  {
    id: 'the policy target is not checked',
    find: 'if (!allowed.some(target => sameAddress(target, payload.to)))',
    replace: 'if (false)'
  },
  {
    id: 'the policy target is compared by spelling',
    find: 'allowed.some(target => sameAddress(target, payload.to))',
    replace: 'allowed.includes(payload.to)'
  },
  {
    id: 'a signature or release retires unrecorded',
    find: 'reading.retires.length > 0 || positive(reading.consumes)',
    replace: 'positive(reading.consumes)'
  },
  {
    id: 'a signature or release consumes unrecorded',
    find: 'reading.retires.length > 0 || positive(reading.consumes)',
    replace: 'reading.retires.length > 0'
  },
  {
    id: 'a release creates unrecorded',
    find: "(payload.kind === 'release' && reading.creates.length > 0)",
    replace: 'false'
  },
  {
    id: 'a transaction counts as unrecorded',
    find: "(payload.kind !== 'tx' && (reading.retires",
    replace: '((reading.retires'
  },
  {
    id: 'an Affirm reaches an inherited entry',
    find: 'if (Object.hasOwn(s.entries, id))',
    replace: 'if (s.entries[id])'
  },
  {
    id: 'a malformed Affirm is applied',
    find: "if (!Array.isArray(event.ids) || !event.ids.every(id => typeof id === 'string')) {",
    replace: 'if (false) {'
  },
  {
    id: 'an Affirm id that is not a string is coerced to one',
    find: " || !event.ids.every(id => typeof id === 'string')",
    replace: ''
  },
  {
    id: 'a re-send is judged as a first dispatch at handoff',
    find: "if (resent?.[1].sent !== 'unknown') return withholdReason(s, plan)",
    replace: 'return withholdReason(s, plan)'
  },
  {
    id: 'a re-send outlives its revocation at handoff',
    find: "return resendable(s, resent[1]) ? undefined : 're-send revoked'",
    replace: 'return undefined'
  },
  { id: 'recovery accepts risk', find: "if (mode === 'recovery' && risky)", replace: 'if (false)' },
  {
    id: 'a stopped kernel runs risk-reducing work',
    find: "(riskReducing(plan) && s.lifecycle.kind !== 'stopped')",
    replace: 'riskReducing(plan)',
    coveredBy: {
      find: "s.lifecycle.kind === 'stopped' || (s.lifecycle.kind === 'idle' && event.type !== 'Start')",
      replace: "s.lifecycle.kind === 'idle' && event.type !== 'Start'",
      why: 'a stopped kernel handles no further event'
    }
  },
  {
    id: 'a neutral act stays bound to its evidence after commit',
    find: '    if (!biddingUncommitted(plan) && !riskIncreasing(plan)) return undefined\n',
    replace: ''
  },
  {
    id: 'a risk-increasing act escapes its evidence after commit',
    find: 'if (!biddingUncommitted(plan) && !riskIncreasing(plan)) return undefined',
    replace: 'if (!biddingUncommitted(plan)) return undefined'
  },
  {
    id: 'a failed plan keeps its outstanding requests',
    find: '    withdraw(s, plan)\n    plan.reason = reason',
    replace: '    plan.reason = reason'
  },
  {
    id: 'an expired intent stays authorized',
    find: 'if (s.now < plan.notAfter) return undefined',
    replace: 'return undefined'
  },
  {
    id: 'a stale simulation counts as fresh',
    find: 'plan.sim.block >= s.head.number - config.maxSimLagBlocks &&',
    replace: 'true &&'
  },
  {
    id: 'a simulation before the last inclusion counts as fresh',
    find: '(plan.lastInclusion === undefined || plan.sim.block >= plan.lastInclusion)',
    replace: 'true'
  },
  {
    id: 'an orphaned simulation counts as fresh',
    find: '    canonical(s, plan.sim) &&\n    plan.sim.block >=',
    replace: '    plan.sim.block >='
  },
  {
    id: 'a result of the wrong kind is accepted',
    find: 'if (!outstanding || !kinds.includes(outstanding.kind)) return undefined',
    replace: 'if (!outstanding) return undefined'
  },
  {
    id: 'a step exposes a commitment no earlier step signed',
    find: 'if (reading.exposes.some(id => !created().includes(id)))',
    replace: 'if (false)'
  },
  {
    id: 'a step retires a commitment the kernel does not own',
    find: "if (reading.retires.some(id => !owned(s, id)))\n        return unauthorized('neutralizes a commitment the kernel does not own')",
    replace: "if (false) return ''"
  },
  {
    id: 'an existing commitment is created again',
    find: 'if (s.entries[commitment.id] || created().includes(commitment.id))',
    replace: 'if (false)'
  },
  {
    id: 'a step kind and its payload may disagree',
    find: 'if (STEP_PAYLOAD[spec.kind] !== spec.payload.kind)',
    replace: 'if (false)'
  },
  {
    id: 'capacity is used without a reading since our last effect',
    find: 'observedAt < (s.watermarks[resource] ?? 0)',
    replace: 'false'
  },
  {
    id: 'capacity is not checked',
    find: 'if (available(config, s, resource) < amount)',
    replace: 'if (false)'
  },
  {
    id: 'no fee is reserved',
    find: 'addTo(need, { native: config.feeReserve * BigInt(txSteps) })',
    replace: 'addTo(need, { native: 0n })'
  },
  {
    id: 'an intent with unresolved exposure is admitted again',
    find: 'if (referencesUnresolved(s, input.intentId))',
    replace: 'if (false)'
  },
  {
    id: 'a zero fee ceiling is accepted',
    find: 'input.maxSpendWei <= 0n',
    replace: 'input.maxSpendWei < 0n'
  },
  {
    id: 'a conflicting submission is accepted',
    find: 'if (first !== undefined && first !== digest) {',
    replace: 'if (false) {'
  },
  {
    id: 'admission ignores the lifecycle',
    find: 'if (!lifecycleAllows(trial, plan))\n      return',
    replace: 'if (false)\n      return'
  },
  {
    id: 'a step after an inclusion skips its stage boundary',
    find: '    if (atStageBoundary(plan)) {',
    replace: '    if (false) {'
  },
  {
    id: 'a stage advances on evidence read before its own inclusion',
    find: '      predatesInclusion(next, next.basisBlock, next.evidence) ??',
    replace: ''
  },
  {
    id: 'an inclusion leaves the ids its plan writes unmarked',
    find: '    if (candidate) raiseConflictMarks(s, candidate.writes, at.block)\n',
    replace: ''
  },
  {
    id: 'a candidate does not carry the ids its plan writes',
    find: '      writes: writesOf(plan),\n',
    replace: '      writes: [],\n'
  },
  {
    id: 'a release leaves the ids its plan writes unmarked',
    find: '      raiseConflictMarks(s, release.writes, release.after)\n',
    replace: ''
  },
  {
    id: 'a read at the head a release went out at counts as after it',
    find: 'release.after = Math.max(release.after + lag, s.head.number + lag + 1)',
    replace: 'release.after = Math.max(release.after + lag, s.head.number + lag)'
  },
  {
    id: 'a restored release is marked only up to the bound past what it saw',
    find: 'const lag = release.restored ? config.maxEvidenceAgeBlocks + 1 : 0',
    replace: 'const lag = release.restored ? config.maxEvidenceAgeBlocks : 0'
  },
  {
    id: 'a restored release trusts a restart lagging past the bound',
    find: 'release.after = Math.max(release.after + lag, s.head.number + lag + 1)',
    replace: 'release.after = Math.max(release.after, s.head.number + lag + 1)'
  },
  {
    id: 'a release is marked past the head it is answered at, not the highest seen',
    find: 'raiseConflictMarks(s, release.writes, release.after)',
    replace: 'raiseConflictMarks(s, release.writes, s.head.number + 1)'
  },
  {
    id: 'a release is marked while it may still leave',
    find: '      if (releaseInFlight(s, intentId)) continue\n',
    replace: ''
  },
  {
    id: 'a release owes no mark until it is answered',
    find: '    else s.releases[plan.intentId] = releaseOf(s, plan)\n',
    replace: ''
  },
  {
    id: 'a conflict mark is not persisted',
    find: '      s.conflictMarks = Object.fromEntries(ledger.conflictMarks)\n',
    replace: ''
  },
  {
    id: 'a release owed before a restart is forgotten',
    find: '      for (const [intentId, release] of Object.entries(ledger.releases))\n        s.releases[intentId] = { ...release, restored: true }\n',
    replace: ''
  },
  {
    id: 'a conflict id that names an inherited property is admitted',
    find: '      liveAuthorityDefect(submitted.evidence, submitted.decision) ??\n      conflictsDefect(submitted.conflicts)',
    replace: '      liveAuthorityDefect(submitted.evidence, submitted.decision)'
  },
  {
    id: 'live evidence may name no basis',
    find: "  if (evidence.some(fact => fact.basis === undefined)) return 'evidence names no basis'\n",
    replace: ''
  },
  {
    id: 'an id that is not a string is admitted',
    find: "    if (!ids.every(id => typeof id === 'string')) return malformed('ids are not strings')\n",
    replace: ''
  },
  {
    id: 'a fee ceiling that is not an amount is admitted',
    find: "    if (submitted.maxSpendWei !== undefined && typeof submitted.maxSpendWei !== 'bigint')\n      return malformed('fee ceiling is not an amount')\n",
    replace: ''
  },
  {
    id: 'recovery races the superseding plan that cancels what it replaced',
    find: '    if (!recovering && !stale && retiredNextBy(s, entry)) return false',
    replace: ''
  },
  {
    id: 'a submission the kernel is not taking goes unanswered',
    find: "      refuse(out, event.plan.intentId, asRefusal('lifecycle', lifecycle))",
    replace: ''
  },
  {
    id: 'a stage boundary is judged on the stage it finished before it parks',
    find: "    if (atStageBoundary(plan)) {\n      plan.phase = 'awaiting-advance'\n      const lapsed = expired(s, plan)\n      return lapsed ? failPlan(s, out, plan, lapsed) : undefined\n    }\n    const refusal = decisionRefusal(s, plan)\n    if (refusal) return failPlan(s, out, plan, refusal)",
    replace:
      "    const refusal = stillAuthorized(s, plan)\n    if (refusal) return failPlan(s, out, plan, refusal)\n    if (atStageBoundary(plan)) {\n      plan.phase = 'awaiting-advance'\n      return\n    }"
  },
  {
    id: 'startup waits on its reads before recovering a foreign record',
    find: "if (Object.values(s.nonces).some(r => r.foreign))\n      return enterRecovering(s, out, 'foreign nonce outstanding at start')",
    replace: ''
  },
  {
    id: 'a failed simulation proceeds',
    find: "if (!event.ok) return failPlan(s, out, taken.plan, 'simulation failed', 'reverted')",
    replace: ''
  },
  {
    id: 'the final check at a typed signature is skipped',
    find: '      if (refusal) return failPlan(s, out, plan, `final check: ${refusal}`)\n      plan.signatures',
    replace: '      plan.signatures'
  },
  {
    id: 'the final check at a signed transaction is skipped',
    find: '    if (refusal) return failPlan(s, out, plan, `final check: ${refusal}`)\n    if (!simFresh',
    replace: '    if (!simFresh'
  },
  {
    id: 'a timed-out broadcast counts as rejected',
    find: 'if (found && answerable(found[1])) markUnknown(s, found[1])',
    replace: "if (found && answerable(found[1])) found[1].sent = 'rejected'"
  },
  {
    id: 'dispatch ignores an orphaned simulation',
    find: "(plan.sim && !canonical(s, plan.sim) ? 'simulation orphaned by a reorg' : undefined) ??",
    replace: 'undefined ??'
  },
  {
    id: 'dispatch ignores its time bound',
    find: 's.now - (plan.committedAt ?? s.now) > config.maxDispatchLagMs',
    replace: 'false'
  },
  {
    id: 'dispatch runs before its flush is acknowledged',
    find: '      if (!waitsOn(plan, event.seq)) continue\n      const step = plan.steps[plan.cursor]!',
    replace:
      "      if (plan.status !== 'executing' || plan.phase !== 'commit') continue\n      const step = plan.steps[plan.cursor]!"
  },
  {
    id: 'recovery ignores its time bound',
    find: 'if (s.now - s.lifecycle.since >= config.recoveryBoundMs)',
    replace: 'if (false)'
  },
  {
    id: 'recovery ignores its attempt bound',
    find: '      if (!continued && entry.recoveryAttempts >= config.maxRecoveryAttempts)\n        return markStuck(s, out, entry)\n',
    replace: ''
  },
  {
    id: 'a stuck nonce is never bid again',
    find: 'if (s.head.number - sent < config.stuckBlocks) continue',
    replace: 'continue'
  },
  {
    id: 'a failed recovery fill retries without a later head',
    find: 'record.failedFillHead !== undefined && (s.head?.number ?? 0) <= record.failedFillHead',
    replace: 'false'
  },
  {
    id: 'the reducer keeps references to its caller’s event',
    find: 'cloned = structuredClone(event)',
    replace: 'cloned = event'
  },
  {
    id: 'an inherited property is accepted as an id',
    find: 'id => id !== undefined && id in Object.prototype',
    replace: '() => false'
  },
  {
    id: 'a foreign winner is not recorded as foreign',
    find: '    record.foreign = true\n',
    replace: ''
  },
  {
    id: 'admission ignores our own final effects',
    find: 'capacityRefusal(trial, admitted) ??\n      staleBasis(',
    replace: 'capacityRefusal(trial, admitted) ??\n      ((..._: unknown[]) => undefined)('
  },
  {
    id: 'a later step ignores our own final effects',
    find: 'return staleBasis(s, plan, specs)',
    replace: 'return void (s, plan, specs)'
  },
  {
    id: 'a decision is held to our own final effects by its latest read alone',
    find: 'const oldest = Math.min(plan.basisBlock, ...chainBlocks(plan.evidence))',
    replace: 'const oldest = plan.basisBlock'
  },
  {
    id: 'a commit that changes nothing durable is never flushed',
    find: 'if (text === s.lastDurable && !awaited) return',
    replace: 'if (text === s.lastDurable) return',
    coveredBy: {
      find: '    else s.releases[plan.intentId] = releaseOf(s, plan)\n',
      replace: '',
      why: 'a release records the conflict ids it owes, so its commit changes the ledger whenever a head has marked the last one'
    }
  },
  {
    id: 'startup suspends the dead-man switch',
    find: "if (lapsed) return enterRecovering(s, out, 'affirmation lapsed during startup')",
    replace: ''
  },
  {
    id: 'admission accepts a malformed basis or expiry',
    find: 'if (![input.basisBlock, input.notAfter, input.validUntil ?? 0].every(isBlockOrTime))',
    replace: 'if (false)'
  },
  {
    id: 'an advance accepts a malformed basis or expiry',
    find: 'if (!times.every(isBlockOrTime))',
    replace: 'if (false)'
  },
  {
    id: 'the clock accepts a malformed reading',
    find: 'if (!isBlockOrTime(event.now)) {',
    replace: 'if (false) {'
  },
  {
    id: 'headers are never pruned',
    find: "if (event.type === 'Head') pruneHeaders(s)",
    replace: ''
  },
  {
    id: 'headers above finality are pruned',
    find: 'Math.min(\n      s.finalized.number,\n      (s.head?.number ?? 0) - Math.max(config.maxSimLagBlocks, config.maxEvidenceAgeBlocks)\n    )',
    replace: '(s.head?.number ?? 0)'
  },
  {
    id: 'a vouched header from beyond the head is kept',
    find: ' || event.number > s.head.number) return',
    replace: ') return'
  },
  {
    id: 'a header that contradicts a known one is not a reorg',
    find: 'if (known !== undefined && known !== hash) reorg(',
    replace: 'if (false) reorg('
  },
  {
    id: 'a header stored evidence names is pruned',
    find: 'if (block < below && !pinned.has(block))',
    replace: 'if (block < below)'
  },
  {
    id: 'a retired entry keeps its headers',
    find: "        e.state === 'retired'\n          ? []",
    replace: '        false\n          ? []'
  },
  {
    id: 'finished plans are never pruned',
    find: '    pruneFinished(s)\n',
    replace: ''
  },
  {
    id: 'a plan an open nonce record names is pruned',
    find: '      ...candidates.map(c => c.intentId),\n',
    replace: ''
  },
  {
    id: 'a self-call carrying calldata is read as a nonce fill',
    find: "mode === 'recovery' && payload.value === 0n && payload.data === '0x'",
    replace: "mode === 'recovery' && payload.value === 0n",
    coveredBy: {
      find: '!reading?.ok || !reading.retires.includes(id)',
      replace: '!reading?.ok',
      why: 'a fill reading retires nothing, so a stored neutralizer that is a self-call is refused for not retiring its entry'
    }
  },
  {
    id: 'the kernel starts on an account that has code',
    find: "if (event.accountCode !== '0x')",
    replace: 'if (false)'
  },
  {
    id: 'the account spelled in another case escapes the self-call rule',
    find: 'sameAddress(payload.to, config.account)',
    replace: 'payload.to === config.account'
  },
  {
    id: 'calldata that is not whole bytes of hex is read',
    find: "if (payload.kind === 'tx' && !isCalldata(payload.data))",
    replace: 'if (false)'
  },
  {
    id: 'digests distinguish hex case',
    find: '          data: step.payload.data.toLowerCase()',
    replace: '          data: step.payload.data'
  },
  {
    id: 'an observed expiry never lowers a deadline',
    find: '          ? Math.min(plan.notAfter, ...seen)',
    replace: '          ? plan.notAfter'
  },
  {
    id: 'an observed expiry relaxes a deadline',
    find: '          ? Math.min(plan.notAfter, ...seen)',
    replace: '          ? Math.max(plan.notAfter, ...seen)'
  },
  {
    id: 'an observed expiry lowers the deadline of a plan not resting on it',
    find: '(plan.evidence ?? []).flatMap(fact => expiries.get(fact.id) ?? [])',
    replace: '[...expiries.values()]'
  },
  {
    id: 'an expiry that is not a safe integer is trusted',
    find: "if (typeof expiry !== 'number' || !isBlockOrTime(expiry)) {",
    replace: "if (typeof expiry !== 'number') {"
  },
  {
    id: 'a malformed expiry leaves the last observation standing',
    find: "s.observations[id] = { id, unavailable: 'failed' }",
    replace: 'void id'
  },
  {
    id: 'a new plan ignores the expiries observed with it',
    find: 'notAfter: withDeadline(s, Math.min(input.notAfter, input.validUntil ?? NEVER), input.evidence),',
    replace: 'notAfter: Math.min(input.notAfter, input.validUntil ?? NEVER),'
  },
  {
    id: 'a new stage ignores the expiries observed with it',
    find: 'notAfter: withDeadline(s, Math.min(event.notAfter, validUntil ?? NEVER), event.evidence),',
    replace: 'notAfter: Math.min(event.notAfter, validUntil ?? NEVER),'
  },
  {
    id: 'a fact read below the evidence floor is admitted',
    find: "      if (chain && fact.basis.block < floor)\n        return asRefusal('evidence_too_old'",
    replace: "      if (false)\n        return asRefusal('evidence_too_old'"
  },
  {
    id: 'a pruned mark leaves the durable floor below it',
    find: '      s.evidenceFloor = Math.max(s.evidenceFloor, mark)\n',
    replace: ''
  },
  {
    id: 'marks are pruned after the flush that should record the floor',
    find: '    pruneConflictMarks(s)\n    flushIfChanged(s, out)',
    replace: '    flushIfChanged(s, out)\n    pruneConflictMarks(s)'
  },
  {
    id: 'a restart forgets the durable floor',
    find: '      s.evidenceFloor = ledger.evidenceFloor\n',
    replace: ''
  },
  {
    id: 'a restored release is marked as if the restart missed no head',
    find: '        s.releases[intentId] = { ...release, restored: true }',
    replace: '        s.releases[intentId] = release'
  },
  {
    id: 'headers inside the evidence age bound are dropped below finality',
    find: 'Math.max(config.maxSimLagBlocks, config.maxEvidenceAgeBlocks)',
    replace: 'config.maxSimLagBlocks'
  },
  {
    id: 'an unknown send is rebroadcast past its deadline',
    find: "plan?.status === 'executing' && s.now < plan.notAfter && s.lifecycle.kind === 'running'",
    replace: "plan?.status === 'executing' && s.lifecycle.kind === 'running'"
  },
  {
    id: 'a plan that parks past its deadline waits for an advance',
    find: '      return lapsed ? failPlan(s, out, plan, lapsed) : undefined',
    replace: '      return void lapsed',
    coveredBy: {
      find: '      if (reason && occupiesNonce(s, plan)) cancel(s, out, plan, reason)\n',
      replace: '      if (reason && occupiesNonce(s, plan)) void 0\n',
      why: 'the clock cancels a step waiting in include at its deadline, before it can park'
    }
  },
  {
    id: 'an advance revives a plan parked past its deadline',
    find: '    if (lapsed) return failPlan(s, out, plan!, lapsed)\n',
    replace: ''
  },
  {
    id: 'an equal re-read never keeps a resting plan alive',
    find: '      const refreshed = settled && resting(s, plan) ? reread(s, plan) : undefined',
    replace: '      const refreshed = undefined'
  },
  {
    id: 'an observation batch is judged before all of it is in',
    find: '      s.observations[id] = { id, version, expiry }\n',
    replace:
      "      s.observations[id] = { id, version, expiry }\n      for (const plan of Object.values(s.plans)) if (plan.status === 'executing' && plan.evidence?.some(f => f.id === id) && resting(s, plan)) plan.notAfter = reread(s, plan) ?? plan.notAfter\n"
  },
  {
    id: 'a batch reading a fact twice extends on its last reading',
    find: '      const settled = !plan.evidence!.some(fact => seenTwice.has(fact.id))',
    replace: '      const settled = true'
  },
  {
    id: 'a step landing again leaves its stage floor at the orphaned block',
    find: '    plan.lastInclusion = Math.max(plan.lastInclusion ?? 0, block)\n',
    replace: ''
  },
  {
    id: 'an equal re-read revives a resting plan past its deadline',
    find: "(plan.phase === 'include' || plan.phase === 'awaiting-advance') && s.now < plan.notAfter",
    replace: "plan.phase === 'include' || plan.phase === 'awaiting-advance'"
  },
  {
    id: 'a changed re-read keeps a resting plan alive',
    find: "seen && 'version' in seen && seen.version === fact.version ? seen.expiry : undefined",
    replace: "seen && 'version' in seen ? seen.expiry : undefined"
  },
  {
    id: 'the clock ends no plan at its deadline',
    find: '      if (reason && occupiesNonce(s, plan)) cancel(s, out, plan, reason)\n      else if (reason) failPlan(s, out, plan, reason)',
    replace: '      void reason'
  },
  {
    id: 'a new deadline starts at the latest expiry',
    find: 'deadline = Math.min(deadline, seen.expiry)',
    replace: 'deadline = Math.max(deadline, seen.expiry)'
  },
  {
    id: 'a plan bidding at its nonce reserves another fee',
    find: 'const committed = occupiesNonce(state, plan) ? plan.cursor + 1 : plan.cursor',
    replace: 'const committed = plan.cursor'
  },
  {
    id: 'a plan bidding again at its nonce is superseded',
    find: 'if (replaced && (occupiesNonce(s, replaced) || !biddingUncommitted(replaced)))',
    replace: 'if (replaced && !biddingUncommitted(replaced))'
  },
  {
    id: 'a resolved record is pruned before its plan reads the winner',
    find: '((p.terms?.nonce === record.nonce && occupiesNonce(s, p)) ||',
    replace: '(false ||',
    coveredBy: {
      find: '    progressPlans(s, out)\n    settleNonces(s)',
      replace: '    settleNonces(s)',
      why: 'plans read their winners before the records are settled, in the same transition'
    }
  },
  {
    id: 'a stop ends clean with a plan out at its nonce',
    find: "Object.values(s.plans).some(p => p.status === 'executing' && occupiesNonce(s, p))",
    replace: 'false',
    coveredBy: {
      find: 'const openNonces = Object.keys(s.nonces).length > 0',
      replace: 'const openNonces = false',
      why: 'a plan out at a nonce keeps that nonce record open'
    }
  },
  {
    id: 'a re-bid escapes its decision deadline',
    find: 'if (plan.recovery || !biddingUncommitted(plan)) return undefined',
    replace: 'if (plan.recovery || occupiesNonce(s, plan)) return undefined',
    coveredBy: {
      find: '      if (reason && occupiesNonce(s, plan)) cancel(s, out, plan, reason)\n',
      replace: '      if (reason && occupiesNonce(s, plan)) void 0\n',
      why: 'the clock cancels a plan out at its nonce at its deadline, before any re-bid'
    }
  },
  {
    id: 'a neutral re-bid escapes its evidence',
    find: 'if (!biddingUncommitted(plan) && !riskIncreasing(plan)) return undefined',
    replace: 'if (occupiesNonce(s, plan) && !riskIncreasing(plan)) return undefined'
  },
  {
    id: 'a stop leaves a re-bid bidding',
    find: "if (plan.status !== 'executing' || !biddingUncommitted(plan) || lifecycleAllows(s, plan))",
    replace:
      "if (plan.status !== 'executing' || occupiesNonce(s, plan) || lifecycleAllows(s, plan))",
    coveredBy: {
      find: '      cancel(s, out, step, `recovering: ${s.lifecycle.reason}`)\n',
      replace: '',
      why: 'a re-bid only runs at a stuck nonce, which recovery cancels the step at in the same transition'
    }
  },
  {
    id: 'a stop fails a plan waiting in include',
    find: "if (plan.status !== 'executing' || !biddingUncommitted(plan) || lifecycleAllows(s, plan))",
    replace: "if (plan.status !== 'executing' || lifecycleAllows(s, plan))"
  },
  {
    id: 'a re-bid skips the checks of its first bid',
    find: "  const rebid = (s: KernelState, out: Command[], plan: Plan) => {\n    plan.phase = 'ready'\n    advance(s, out, plan)",
    replace:
      "  const rebid = (s: KernelState, out: Command[], plan: Plan) => {\n    plan.phase = 'await-slot'"
  },
  {
    id: 'a step bids before its predecessor executed',
    find: "    if (!predecessorsExecuted(s, plan)) return 'ready'\n",
    replace: '',
    coveredBy: {
      find: '      if (!predecessorsExecuted(s, plan)) return\n',
      replace: '',
      why: 'a step waiting on its predecessor never simulates, so never reaches the slot'
    }
  },
  {
    id: 'a covered unknown still counts as uncertain',
    find: "  !record.candidates.some(d => d.feeLevel > c.feeLevel && d.sent === 'accepted')",
    replace: '  true'
  },
  {
    id: 'an uncertain nonce is re-sent more than once',
    find: '!record.resent?.includes(c.hash)',
    replace: 'true'
  },
  {
    id: 'an uncertain nonce is bid over while its re-send is out',
    find: '    if (sending(s, record)) return false\n',
    replace: ''
  },
  {
    id: 'a step re-bids while latched',
    find: "step.phase === 'include' && !step.terms!.capped && !latched(s)",
    replace: "step.phase === 'include' && !step.terms!.capped",
    coveredBy: {
      find: "return !plan.recovery && occupiesNonce(s, plan) && latched(s) ? 'include' : undefined",
      replace: 'return undefined',
      why: 'the slot holds a latched re-bid back too'
    }
  },
  {
    id: 'an acceptance keeps the age of an earlier uncertainty',
    find: '    delete candidate.unknownSince\n',
    replace: ''
  },
  {
    id: 'the bytes of a recovery bid at a resolved nonce are handed off',
    find: "    if (resent?.[0].resolution) return 'its nonce resolved'\n",
    replace: ''
  },
  {
    id: 'a step at its cap bids again',
    find: '    plan.terms!.capped = true\n',
    replace: ''
  },
  {
    id: 'a plan waiting in ready bids before its resolved nonce settles it',
    find: "      if (occupiesNonce(s, plan) && s.nonces[plan.terms!.nonce]!.resolution)\n        settleByWinner(s, out, plan)\n      else if (plan.phase === 'ready') advance(s, out, plan)",
    replace:
      "      if (plan.phase === 'ready') advance(s, out, plan)\n      else if (occupiesNonce(s, plan) && s.nonces[plan.terms!.nonce]!.resolution)\n        settleByWinner(s, out, plan)"
  },
  {
    id: 'hand-off ignores the deadline of a plan its evidence does not bind',
    find: '    expired(s, plan) ??\n    stillAuthorized(s, plan) ??',
    replace: '    stillAuthorized(s, plan) ??'
  },
  {
    id: 'a cancel whose step executed still ends cancelled',
    find: '&& !plan.neutralized && included.length === 0)',
    replace: '&& !plan.neutralized)'
  },
  {
    id: 'a compensating notice says cancelled',
    find: "    notify(out, plan.intentId, 'compensating', reason)\n",
    replace:
      "    emit(out, { type: 'notify', intentId: plan.intentId, notice: 'compensating', reason, ...(plan.cancelled && { code: 'cancelled' }) })\n"
  },
  {
    id: 'the fee ceiling fails its recovery',
    find: "    plan.terms!.capped = true\n    plan.phase = 'include'\n    if (!plan.recovery) return\n",
    replace:
      "    if (plan.recovery) return failPlan(s, out, plan, 'ceiling')\n    plan.terms!.capped = true\n    plan.phase = 'include'\n"
  },
  {
    id: 'a rejected candidate re-sent at the ceiling stays rejected',
    find: "candidate.sent === 'unsent' || candidate.sent === 'rejected'",
    replace: "candidate.sent === 'unsent'"
  },
  {
    id: 'a cancel whose compensation acted ends cancelled',
    find: '    if (owner) owner.neutralized = true\n',
    replace: ''
  },
  {
    id: 'a refreshed observation outlives what the decision is valid until',
    find: '          : Math.min(refreshed, plan.validUntil ?? NEVER)',
    replace: '          : refreshed'
  },
  {
    id: 'recovery fills a step it never cancelled',
    find: '      cancel(s, out, step, `recovering: ${s.lifecycle.reason}`)\n',
    replace: ''
  },
  {
    id: 'an advance that names no validity drops the one its plan was decided with',
    find: 'const validUntil = event.validUntil ?? plan.validUntil',
    replace: 'const validUntil = event.validUntil'
  },
  {
    id: 'a recovery bid rejected at its own nonce waits there forever',
    find: '      if (rejectedOnly(record)) {\n        rebidRejected(s, out, record)\n        continue\n      }',
    replace: '      if (rejectedOnly(record)) continue'
  },
  {
    id: 'a restart revives the age of an unknown that was covered',
    find: 'const aged = unknownSince !== undefined && uncovered(record, c)',
    replace: 'const aged = unknownSince !== undefined'
  }
]
