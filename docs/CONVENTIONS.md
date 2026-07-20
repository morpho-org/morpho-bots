# Curator Bots Conventions

## File Structure Patterns

### Type Colocation

- **Colocate types with functions**: Define types inline in the function (or directly above it) unless they're explicitly meant to be reused
- **Shared types at the top**: If a type or symbol is used by multiple functions in the same file, place it at the top of the file
- **Avoid standalone type files**: Dedicated `.types.ts` files should generally be avoided. Only use them for pure type definitions that have no accompanying code (e.g., shared API response shapes, domain models referenced across many files). If a type has a related function, hook, or component, keep the type in that file instead.

## Code Style and Best Practices

### General Code Style

- **Simplicity First**: Prefer simple, readable code over clever solutions
- **Single Responsibility**: Functions and components should do one thing well
- **DRY Principle**: Don't repeat yourself - extract common logic into reusable utilities
- **Avoid Magic Numbers**: Use named constants for numeric values with meaning
- **Early Returns**: Use early returns to reduce nesting and improve readability
- **Strict Equality**: Always use `===`/`!==`; never `==`/`!=`

### Comments and Documentation

- **Self-Documenting Code**: Code should be self-explanatory through clear naming
- **When to Comment**:
  - Complex business logic that isn't immediately obvious
  - Non-obvious workarounds or bug fixes
  - Public API documentation (JSDoc for exported functions, particularly under `packages/`)
- **When NOT to Comment**:
  - Obvious code that describes what it does
  - Redundant information already clear from code
  - Commented-out code (remove it, use git history instead)

### Function and Method Organization

- **Function Length**: Keep functions focused and concise (ideally < 10 lines)
- **Parameter Count**: Functions with more than 3 parameters should be refactored to accept ≤3 parameters, with the last one being a destructured object
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
- **Logging**: Log errors appropriately for debugging and monitoring. Prefer structured logs with
  enough context (bot name, operation, relevant inputs) that an operator can answer "what did the
  bot do and why?" a day later.
- **Promises**: Use `tryCatch` from `@repo/utils` to handle promise throws.

### Environment Variables

- **Direct `Bun.env` access**: Bots read `Bun.env.VARIABLE_NAME` directly at the point of use.
  There is no helper wrapper and no runtime schema layer — if a required variable is missing,
  fail loudly at startup (throw and exit), don't silently degrade.
- **Exception — `bots/monitor-bot`**: validates its config at startup with t3-env + zod (still
  fail-loud) and reads `process.env` in test-reachable code, since its vitest suite executes under
  Node where the `Bun` global does not exist. See
  [TIB-2026-07-20-monitor-bot-nestjs-stack](./decisions/TIB-2026-07-20-monitor-bot-nestjs-stack.md).
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

### Test File Naming

- **Unit Tests**: `{module}.test.ts`
- **Integration Tests**: `{module}.integration.test.ts`

### Test Quality

- **Assertion Precision**: Use exact matchers (`toBe`, `toEqual`, `toStrictEqual`); only use
  approximate matchers (e.g., floating-point arithmetic, time-dependent values) with a comment
  explaining why exact matching is not feasible.
- **Bun test runner**: Tests run under `bun test`. The runner is Vitest-compatible; existing
  Vitest-style assertions and spies carry over.
- **Exception — `bots/monitor-bot`**: its suite runs under vitest
  (`bun run --filter @morpho-org/monitor-bot test`) because NestJS constructor injection needs
  decorator metadata that only the SWC transform emits; the package is excluded from `bun test`
  via the root `bunfig.toml`. See
  [TIB-2026-07-20-monitor-bot-nestjs-stack](./decisions/TIB-2026-07-20-monitor-bot-nestjs-stack.md).

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

- **Viem**: Bots use viem directly (no wagmi — there is no React surface).
- **Multi-chain**: Each bot declares its supported chains in its own config.
- **Viem Utilities**: Use `parseUnits`/`formatUnits` over raw `10n ** BigInt(decimals)` arithmetic;
  reserve raw BigInt only for math-heavy library code.
- **Address Types**: Use `Address` from viem, never inline `` `0x${string}` ``.
- **Address Narrowing**: Use `isAddress()` to validate and narrow `string` to `Address` — avoids
  `as Address` casts. For runtime normalization (checksumming), use `getAddress()` after an
  `isAddress` guard.
- **Address Comparison**: Use `isAddressEqual` from viem, never `.toLowerCase()` comparisons.
