# Curator Bots Conventions

## File Structure Patterns

### Type Colocation

- **Colocate types with functions**: Define types inline in the function (or directly above it) unless they're explicitly meant to be reused
- **Shared types at the top**: If a type or symbol is used by multiple functions in the same file, place it at the top of the file
- **Avoid standalone type files**: Dedicated `.types.ts` files should generally be avoided. Only use them for pure type definitions that have no accompanying code (e.g., shared API response shapes, domain models referenced across many files). If a type has a related function, hook, or component, keep the type in that file instead.

### Utility Isolation

- **Utilities live apart from classes**: Utility functions belong in a different file from any
  class — a focused `*.utils.ts` or a dedicated module. This constrains where _classes and
  functions_ live, not where _types_ live: a type consumed by both a class file and its
  `*.utils.ts` sibling stays in the class file and is imported by the utils file.

## Code Style and Best Practices

### General Code Style

- **Simplicity First**: Prefer simple, readable code over clever solutions
- **Single Responsibility**: Functions and components should do one thing well
- **DRY Principle**: Don't repeat yourself - extract common logic into reusable utilities
- **Avoid Magic Numbers**: Use named constants for numeric values with meaning
- **Early Returns**: Use early returns to reduce nesting and improve readability
- **Strict Equality**: Always use `===`/`!==`; never `==`/`!=`

### Comments and Documentation

Default to no comment, and keep the ones that survive pithy. Necessary and sufficient applies to
prose as much as to code.

- **Encode meaning in the code first** — signatures, names, named constants, types. A behavior only
  visible in a comment is an API-design smell; fix the API instead.
- **A comment justifies its existence, and runs to ~3 lines at most.** If it needs more, the code
  needs restructuring or the explanation belongs in a TIB.
- **TSDoc on exports** only where there is real nuance, complexity, or high fan-in. State the
  guarantee or the hazard — never the algorithm, which the body already shows. Pithy is not absent:
  `bots/quoter-bot`'s public surface is checked by `jsdoc:check`, and a docstring passes by naming
  the contract, failures, and side effects in a sentence or two.
- **One home per explanation.** Document a rule once at its canonical symbol and `{@link}` it from
  everywhere else. Never restate the justification at each call site.
- **Inline comments only for code that looks wrong without them** — a spec quirk, an upstream bug, a
  workaround — and cite the external spec or upstream issue. No link usually means no comment:
  encode the constraint in a named constant or a type.
- **Never**: section-header comments, step numbering, restating a type signature in prose, narrating
  a line that already reads as English, or commented-out code (git history holds it).
- **Never the history of how the code got here** — ticket numbers, incident narratives, "the field
  that used to be missing". Git blame and the PR carry provenance. Likewise no "when adding X, do Y"
  checklists in code; that belongs in the PR description or docs.

### Function and Method Organization

- **Function Length**: Keep functions focused and concise (ideally < 10 lines)
- **Parameter Count**: Functions with more than 3 parameters should be refactored to accept ≤3 parameters, with the last one being a destructured object
- **Arrow Constants**: Prefer declaring utilities as arrow constants (`export const helper = () => {}`)
  over `function` declarations, so hoisting never masks a definition-order mistake. This is a
  preference for new code, not a defect to churn — ~145 exported `function` declarations exist
  today and are fine where they are. Overloaded signatures require `function` (see `tryCatch` in
  `@repo/utils`)
- **TypeScript Inference**: Omit type annotations TypeScript can infer (including return types)
- **Pure Functions**: Prefer pure functions without side effects when possible
- **Function Ordering**:
  - Export statements at top
  - Helper functions (defined before they're called)
  - Main function below helpers
  - Types colocated above their consuming function, or at the top if shared (see [File Structure Patterns](#file-structure-patterns))

### Error Handling

- **Explicit Error Handling**: Handle errors explicitly, don't silently swallow them
- **Type-Safe Errors**: Use typed error objects rather than throwing strings
- **Typed Error Isolation**: Every expected domain, application, infrastructure, configuration, CLI,
  provider, or tooling failure uses a named exported `Error` subclass. Put exactly one error class
  in its own kebab-case `*.error.ts` file named for the class (`SetupFailedError` in
  `setup-failed.error.ts`); those files hold only imports, supporting types, and that class. Do not
  define error classes in services, utilities, configuration, CLI, or script files, and do not use
  plain `Error` for an expected failure. A boundary wrapper may retain an unexpected third-party
  error as `cause`, but operator-visible fields and messages must exclude credentials, URLs,
  response bodies, and other untrusted data.
- **Logging**: Log errors appropriately for debugging and monitoring. Prefer structured logs with
  enough context (bot name, operation, relevant inputs) that an operator can answer "what did the
  bot do and why?" a day later.
- **One join key per subject**: every event scoped to the same subject carries that subject under
  **one** field name, with one shape and one casing, produced by a shared helper rather than
  assembled at each call site — so grouping needs no normalization in the query. The liquidators'
  subject is a position and the field is `id` (see `lensKey` in `@repo/utils`); a subject that
  subdivides adds a discriminator beside the key rather than changing it, named identically in every
  package that emits it. A key that is also **behavioral** (a map key, a dedupe set) keeps whatever
  name that role gave it — `PendingQueue`'s `SubmitArgs.label` is logged as `id` but stays `label` in
  the API, because its value is compared, not just displayed. Never re-derive the key at a call site.
- **Promises**: Use `tryCatch` from `@repo/utils` to handle promise throws.

### Environment Variables

- **Direct `process.env` access**: Bots read `process.env.VARIABLE_NAME` directly at the point of use.
  There is no helper wrapper and no runtime schema layer — if a required variable is missing,
  fail loudly at startup (throw and exit), don't silently degrade.
- **Never committed**: Secrets and runtime config live in local `.env` files or deploy-time
  environment — never in committed code. The repo's Strict Rules enforce this.

### Code Complexity

- **Cyclomatic Complexity**: Keep functions simple with minimal branching
- **Nesting Depth**: Limit nesting to 3 levels maximum
- **Ternary Operators**: Use for simple conditions; extract complex logic to variables
- **Boolean Expressions**: Extract complex boolean logic into well-named variables

### Performance Considerations

- **Premature Optimization**: Don't optimize until you measure and identify bottlenecks
- **RPC efficiency**: Batch on-chain reads where possible. Use `readDeploylessBatchLens` for fetching entities that would be well-modeled by a Lens contract, and `multicall` otherwise (e.g., for one-off fetching of heterogenous data / data sourced from multiple, unrelated contracts). Prefer `readContract` with explicit block tags for deterministic snapshots over loose calls that pick up whatever the provider last saw.
- **Bundle Size**: Be mindful of third-party dependencies and their impact — each bot ships as its
  own image, so a dep added in one bot doesn't have to cost the others.

## TypeScript Patterns

### Type Definitions

- **Suffix Patterns**:
  - `Props` for handler/component props
  - `Parameters` for function input objects (unabbreviated to match `viem` conventions)
  - `Config` for configuration objects

## Testing Patterns

### Test Organization

- **Centralized under `test/`**: Each bot / package keeps all tests in a top-level `test/` directory whose hierarchy mirrors `src/`. Shared test helpers live alongside the tests in the same `test/` tree.
- **One file per module**: If a test file already exists for the module, add to it rather than creating a new one.

### Test File Naming

- **Unit Tests**: `{module}.test.ts`
- **Integration Tests**: `{module}.integration.test.ts`

### Test Quality

- **Assertion Precision**: Use exact matchers (`toBe`, `toEqual`, `toStrictEqual`); only use
  approximate matchers (e.g., floating-point arithmetic, time-dependent values) with a comment
  explaining why exact matching is not feasible.
- **Test runners**: `pnpm test` drives every workspace project listed in the root
  `vitest.config.ts` plus the quoter-bot playground's Node `*.test.mjs` suites. TypeScript tests
  use Vitest; mocks and spies come from `vi` (`vi.fn`, `vi.spyOn`, `vi.restoreAllMocks`).

### Testing Anti-Patterns

Avoid these patterns that produce tests that pass but verify nothing useful:

- **Testing mock behavior instead of real behavior**: If your test only proves the mock returns what
  you told it to return, it's not testing anything
- **Adding test-only methods to production code**: Never expose internals solely for testing;
  test through the public API
- **Mocking without understanding**: If you can't explain what the real dependency does, your mock
  is likely incomplete or incorrect
- **Incomplete mocks that diverge from real behavior**: Mocks that return hardcoded happy-path data
  without matching the real API's shape, edge cases, or error modes

## Import Patterns

### Internal Package Imports

- **Workspace References**: Use `@repo/{package}` for internal packages
- **Direct Imports**: Import directly from package entry points
- **Type-only Imports**: Use `import type` for type-only imports

### Export Patterns

- **Named Exports**: No default exports except where a runtime requires them.
- **Barrel Exports**: Use with caution — barrel files can hurt tree shaking. Ensure packages are
  properly configured or minimize barrel file usage.

### External Library Patterns

- **SDK first**: Inspect the installed package's real exports and how the repo already uses them,
  then reuse `@morpho-org/midnight-sdk` and Morpho SDK helpers, entities, ABIs, types, and
  constants wherever their semantics match. Never invent an export or a dependency.
- **Re-export Pattern**: Internal packages re-export external dependencies so the bots import from
  a single, versioned surface.
- **Lodash**: Import individual functions from `lodash-es/{fn}` instead of the barrel
  `lodash-es`. Barrel imports pull in the entire library (~70 kB parsed) even when only one
  function is used.

  ```typescript
  // Good
  import isNil from 'lodash-es/isNil'

  // Bad — imports the entire lodash-es barrel
  import { isNil } from 'lodash-es'
  ```

## Web3 Integration

- **Viem**: Bots use viem directly. The only React surface in the repo is the quoter-bot
  playground (`bots/quoter-bot/playground/`); bot runtimes have none.
- **Multi-chain**: Each bot declares its supported chains in its own config.
- **Viem Utilities**: Use `parseUnits`/`formatUnits` over raw `10n ** BigInt(decimals)` arithmetic;
  reserve raw BigInt only for math-heavy library code.
- **Address Types**: Use `Address` from viem, never inline `` `0x${string}` ``.
- **Address Narrowing**: Use `isAddress()` to validate and narrow `string` to `Address` — avoids
  `as Address` casts. For runtime normalization (checksumming), use `getAddress()` after an
  `isAddress` guard.
- **Address Comparison**: Use `isAddressEqual` from viem, never `.toLowerCase()` comparisons.
- **Hashing and byte size**: Use viem's `keccak256`, `size`, and `hexToBytes`/`bytesToHex` rather
  than local equivalents.
