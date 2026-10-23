# morpho-bots conventions

What a linter can check lives in `.oxlintrc.json` and `packages/oxlint-plugin`; this file holds the
rest.

## File structure patterns

- **Prefer flat directories.** Nest a folder only when it has its own entry point or would
  otherwise crowd its parent.

### Types and errors

Types and error classes follow the same rule.

- **Inline first**: Define one beside the code that uses it, or at the top of the file when several
  functions there share it.
- **Then the package's `types.ts` or `errors.ts`**: Move it there once inline definitions make
  imports messy or cyclic, or once it is exported for use outside the package. Each file declares
  only its kind; an `errors.ts` holds error classes and their types (`repo/errors-file`).

## Code style and best practices

### Comments and documentation

Default to no comment, and keep the ones that survive pithy. Necessary and sufficient applies to
prose as much as to code.

- **Encode meaning in the code first** — signatures, names, named constants, types. A behavior only
  visible in a comment is an API-design smell; fix the API instead.
- **A comment justifies its existence, and runs to ~3 lines at most.** If it needs more, the code
  needs restructuring or the explanation belongs in an ADR or the plan.
- **TSDoc on exports** only where there is real nuance, complexity, or high fan-in. State the
  guarantee or the hazard — never the algorithm, which the body already shows. Pithy is not absent:
  `bots/quoter-bot`'s public surface is checked by `jsdoc:check`, and a docstring passes by naming
  the contract, failures, and side effects in a sentence or two.
- **One home per explanation.** Document a rule once at its canonical symbol and `{@link}` it from
  everywhere else. Never restate the justification at each call site.
- **Inline comments only for code that looks wrong without them** — a spec quirk, an upstream bug, a
  workaround — and cite the external spec or upstream issue. No link usually means no comment:
  encode the constraint in a named constant or a type.
- **Never**: restating a type signature in prose, narrating a line that already reads as English, or
  commented-out code (git history holds it).
- **Never the history of how the code got here** — incident narratives, "the field that used to be
  missing". Git blame and the PR carry provenance. Likewise no "when adding X, do Y" checklists in
  code; that belongs in the PR description or docs.

### Prose

Docs, skills, PR bodies, and operator-facing messages follow the
[Microsoft Writing Style Guide](https://learn.microsoft.com/en-us/style-guide/welcome/), written as
plainly and tightly as Brian Kernighan writes. An agent's native style is optimized for the way it
thinks. Nothing is wrong with that as such, but some readers bounce off text simply because it
sounds like AI. Kernighan and the Microsoft guide give clear, concise, technical patterns to follow
instead.

### Function and method organization

- **Parameter Count**: Functions with more than 3 parameters should be refactored to accept ≤3
  parameters, with the last one being a destructured object
- **Arrow Constants**: Prefer declaring utilities as arrow constants (`export const helper = () => {}`)
  over `function` declarations, so hoisting never masks a definition-order mistake. This is a
  preference for new code, not a defect to churn. Overloaded signatures require `function` (see
  `tryCatch` in `@repo/utils`)
- **TypeScript Inference**: Omit type annotations TypeScript can infer (including return types)
- **Function Ordering**:
  - Export statements at top
  - Helper functions (defined before they're called)
  - Main function below helpers
  - Types colocated above their consuming function, or at the top if shared (see
    [File Structure Patterns](#file-structure-patterns))
- **Complex conditions**: Keep ternaries to simple conditions, and extract complex boolean logic
  into well-named variables

### Error handling

- **Named error classes**: Every expected domain, application, infrastructure, configuration, CLI,
  provider, or tooling failure uses a named `Error` subclass, never plain `Error`, placed per
  [Types and errors](#types-and-errors). A boundary wrapper may retain an unexpected third-party error as `cause`, but operator-visible
  fields and messages must exclude credentials, URLs, response bodies, and other untrusted data.
- **Logging**: Structured logs carry enough context (bot name, operation, relevant inputs) that an
  operator can answer "what did the bot do and why?" a day later.
- **Log a failure once, at the layer that owns it.** A caller that swallows and degrades logs it; a
  caller that rethrows does not. When a batch skips a failed item, the log carries that item's key.
- **One join key per subject**: every event scoped to the same subject carries that subject under
  **one** field name, with one shape and one casing, produced by a shared helper rather than
  assembled at each call site — so grouping needs no normalization in the query. The liquidators'
  subject is a position and the field is `id` (see `lensKey` in `@repo/utils`); a subject that
  subdivides adds a discriminator beside the key rather than changing it, named identically in every
  package that emits it. A key that is also **behavioral** (a map key, a dedupe set) keeps whatever
  name that role gave it — `PendingQueue`'s `SubmitArgs.label` is logged as `id` but stays `label` in
  the API, because its value is compared, not just displayed. Never re-derive the key at a call site.
- **Log shapes are not a contract.** No test pins a log line's event name, fields or shape: no
  snapshots of log output, no exact field sets. A BetterStack dashboard or query that parses a field
  never blocks a rename or a simplification. Change the log, and say in the PR which dashboards to
  update.
- **Promises**: Use `tryCatch` from `@repo/utils` to handle promise throws.

### Environment variables

- **Direct `process.env` access**: Bots read `process.env.VARIABLE_NAME` directly at the point of
  use. There is no helper wrapper and no runtime schema layer.

### RPC efficiency

- Batch onchain reads. Use `readDeploylessBatchLens` for entities well-modeled by a Lens contract,
  and `multicall` otherwise (e.g., one-off heterogeneous reads from unrelated contracts). Prefer
  `readContract` with explicit block tags for deterministic snapshots over loose calls that pick up
  whatever the provider last saw.

## TypeScript patterns

### Type definitions

- **Suffix Patterns**:
  - `Parameters` for function input objects (unabbreviated to match `viem` conventions)
  - `Config` for configuration objects
- **One owner per type**: Use the owning library's type (viem, the Morpho SDKs) or derive it from
  its source of truth (`z.infer`, an ABI); never hand-copy a union or object shape.
- **Narrow untrusted data with guards, not `as`**: an API response, chain id, or string is checked at
  runtime (`isAddress`, a schema, membership in a known set) before it takes the narrower type.

## Testing patterns

### Test organization

- **Mirror owning modules**: Unit tests mirror their owning modules; scenario, package-contract and
  adversarial trace suites may be organized by behavior under `test/`. Shared helpers live under
  `test/`, except those provided via a package's `./testing` entry point.
- **One file per module**: If a test file already exists for the module, add to it rather than
  creating a new one.

### Test quality

- **Assertion Precision**: Use exact matchers (`toBe`, `toEqual`, `toStrictEqual`); only use
  approximate matchers (e.g., floating-point arithmetic, time-dependent values) with a comment
  explaining why exact matching is not feasible.
- **Mocks**: Vitest's `vi` (`vi.fn`, `vi.spyOn`, `vi.restoreAllMocks`).
- **Error identity**: To assert an error propagates unchanged, assert the instance
  (`rejects.toBe(boom)`); `toBeInstanceOf` also passes when a new error is thrown.
- **Fixtures that expose the failure**: Pick values the bug would change. A zero amount passes a
  test that the amount is preserved even when the code drops it.

### Testing anti-patterns

Avoid these patterns that produce tests that pass but verify nothing useful:

- **Testing mock behavior instead of real behavior**: If your test only proves the mock returns what
  you told it to return, it's not testing anything
- **Adding test-only methods to production code**: Never expose internals solely for testing;
  test through the public API. Exporting a private helper so a test can import it is the same
  mistake
- **Mocking without understanding**: If you can't explain what the real dependency does, your mock
  is likely incomplete or incorrect
- **Incomplete mocks that diverge from real behavior**: Mocks that return hardcoded happy-path data
  without matching the real API's shape, edge cases, or error modes
- **No meaningful assertion**: A test that only checks `toBeDefined()` or `not.toThrow()` verifies
  nothing about the output
- **Pinning log output**: Logs are observations of behavior, not its contract (Error handling, "Log
  shapes are not a contract"). Assert what the code did, and let its log lines change freely

## Import patterns

- **Workspace References**: Use `@repo/{package}` for internal packages, imported from the package
  entry points
- **No re-export shims**: When code moves, update every import; don't leave a re-export behind

## Web3 integration

- **Address Comparison**: Use `isAddressEqual` from viem, never `.toLowerCase()` comparisons.
- **Checksum at the wire boundary**: Where an API or GraphQL response is mapped into bot types, pass
  every address through `getAddress()`, so every consumer after it can dedupe and compare safely.
- **Per-chain config in one module**: Anything keyed by chain (addresses, limits, market sets) lives
  in the bot's chain config, typed so that adding a chain fails to compile until every table has an
  entry.
- **Fixed-point math**: Never hand-roll `(a * b) / c` or a `x > y ? x - y : 0n` clamp. Use the
  `@repo/utils` bigint helpers (`mulDivDown`, `mulDivUp`, `zeroFloorSub`, `bigintMin`), or
  `MathLib` from `@morpho-org/morpho-ts` for what they lack, and pick the rounding direction the
  contract path uses.

## Dependencies

- **A dependency change is verified by a build**, not by typecheck alone: bundle the affected bots,
  and run `pnpm build` where soltag lenses are involved.
