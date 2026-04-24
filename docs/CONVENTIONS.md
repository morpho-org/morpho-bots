# Curator Bots Conventions

## File Structure Patterns

### Type Colocation

- **Colocate types with functions**: Define types directly above the function that uses them to aid discoverability and navigation
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
  - Public API documentation (JSDoc for exported functions)
- **When NOT to Comment**:
  - Obvious code that describes what it does
  - Redundant information already clear from code
  - Commented-out code (remove it, use git history instead)

### Function and Method Organization

- **Function Length**: Keep functions focused and concise (ideally < 10 lines)
- **Parameter Count**: Functions with more than 3 parameters must accept a single destructured
  object argument
- **TypeScript Inference**: Omit type annotations TypeScript can infer (including return types)
- **Pure Functions**: Prefer pure functions without side effects when possible
- **Function Ordering**:
  - Export statements at top
  - Main function
  - Helper functions below
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
- **Never committed**: Secrets and runtime config live in local `.env` files or deploy-time
  environment — never in committed code. The repo's Strict Rules enforce this.

### Code Complexity

- **Cyclomatic Complexity**: Keep functions simple with minimal branching
- **Nesting Depth**: Limit nesting to 3 levels maximum
- **Ternary Operators**: Use for simple conditions; extract complex logic to variables
- **Boolean Expressions**: Extract complex boolean logic into well-named variables

### Performance Considerations

- **Premature Optimization**: Don't optimize until you measure and identify bottlenecks
- **RPC efficiency**: Batch on-chain reads where possible (multicall / Bundler3). Prefer
  `readContract` with explicit block tags for deterministic snapshots over loose calls that pick
  up whatever the provider last saw.
- **Bundle Size**: Be mindful of third-party dependencies and their impact — each bot ships as its
  own image, so a dep added in one bot doesn't have to cost the others.

## TypeScript Patterns

### Type Definitions

- **Suffix Patterns**:
  - `Props` for handler/component props
  - `Response` for function return types where the shape needs naming
  - `Config` for configuration objects

## Testing Patterns

### Test Organization

- **Co-location**: Tests alongside source files with `.test.ts` or `.spec.ts`
- **Test utilities**: Per-bot or per-package `test/` directory for shared test helpers

### Test File Naming

- **Unit Tests**: `{module}.test.ts` or `{module}.spec.ts`
- **Integration Tests**: `{module}.integration.test.ts`

### Test Quality

- **Assertion Precision**: Use exact matchers (`toBe`, `toEqual`, `toStrictEqual`); only use
  approximate matchers (e.g., floating-point arithmetic, time-dependent values) with a comment
  explaining why exact matching is not feasible.
- **Bun test runner**: Tests run under `bun test`. The runner is Vitest-compatible; existing
  Vitest-style assertions and spies carry over.

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
- **Tests with no meaningful assertions**: A test that only checks `toBeDefined()` or
  `not.toThrow()` without verifying actual output is a false safety net

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

## API and Data Fetching Patterns

### oRPC Procedures

If a bot exposes an RPC-style service boundary (e.g. for a control plane, an internal trigger
API, or a future UI wrapper), follow **resource-oriented routing** — structure procedures around
resources (nouns), not actions (verbs). This keeps the procedure tree navigable as it grows.

#### Singular vs. plural distinguishes single resource from collection

Use the **plural** form for a collection and the **singular** form for a single resource. The
singular/plural distinction replaces action verbs (`get`, `list`, `find`, etc.) — no verb is needed
when the resource is a leaf procedure. The one exception is when a resource becomes a namespace
because it has children (see [Router structure](#router-structure)).

```typescript
orpc.vaults              // → collection of vaults
orpc.vault               // → single vault (by address, id, etc.)
```

#### Nest child resources under parents

When a resource belongs to another, nest the child under the parent in the procedure path. Use
nesting to express different scopes rather than action-verb suffixes — e.g., a user's vaults are
`orpc.user.vaults`, not `orpc.vaults.listByUser`.

```typescript
orpc.user.vaults         // → vaults belonging to a user (collection)
orpc.user.vault          // → single vault belonging to a user
orpc.vault.markets       // → markets within a vault (collection)
orpc.vault.market        // → single market within a vault
```

#### Resource-specific base procedures

When a resource scopes all of its children, define a **resource-specific base procedure** that
validates and injects the resource's context — similar to how `chainSpecificProcedure` guarantees
`chainId` and a viem client. Procedures nested under that resource then extend the base and inherit
the context without re-validating it.

```typescript
// Guarantees userAddress is present in context for all child procedures
export const userSpecificProcedure = o
  .use(errorLoggingMiddleware)
  .use(async ({ context, next }) => {
    if (!context.userAddress) {
      throw new Error('userAddress is required in context for this procedure')
    }
    return next({ context: { userAddress: context.userAddress } })
  })

// All procedures under orpc.user.* extend userSpecificProcedure
const userVaultsProcedure = userSpecificProcedure
  .handler(async ({ context }) => {
    // context.userAddress is guaranteed
  })
```

#### Router structure

A resource is either a callable procedure (leaf) or a router with children (namespace) — oRPC does
not support both on the same key. When a resource has no children, it is a procedure. When it gains
children, it becomes a router and the self-lookup moves to a `get` key.

```typescript
// Leaf resources — no children, callable directly
const appRouter = {
  vaults: vaultsProcedure,     // orpc.vaults — collection
  vault: vaultProcedure,       // orpc.vault — single resource
  user: userRouter,            // orpc.user.* — has children, so it's a router
}

// When a resource has children, it becomes a router.
// The self-lookup moves to `get`, following the HTTP method convention.
const userRouter = {
  get: userGetProcedure,           // user.get (the user itself)
  vaults: userVaultsProcedure,     // user.vaults (user-scoped collection)
  vault: userVaultProcedure,       // user.vault (user-scoped single)
}
```

#### File organization

Each resource gets its own router directory or procedure file:

```
lib/orpc/routers/
├── index.ts              # Top-level router composition
├── vaults.ts             # vaultsProcedure (collection, leaf)
├── vault/
│   ├── index.ts          # vaultRouter — composes child procedures
│   ├── markets.ts        # vaultMarketsProcedure (child collection)
│   └── market.ts         # vaultMarketProcedure (single child)
└── user/
    ├── index.ts          # userRouter — composes child procedures
    ├── vaults.ts         # userVaultsProcedure (user-scoped collection)
    └── vault.ts          # userVaultProcedure (user-scoped single)
```

### Web3 Integration

- **Viem**: Bots use viem directly (no wagmi — there is no React surface).
- **Multi-chain**: Each bot declares its supported chains in its own config.
- **Viem Utilities**: Use `parseUnits`/`formatUnits` over raw `10n ** BigInt(decimals)` arithmetic;
  reserve raw BigInt only for math-heavy library code.
- **Address Types**: Use `Address` from viem, never inline `` `0x${string}` ``.
- **Address Narrowing**: Use `isAddress()` to validate and narrow `string` to `Address` — avoids
  `as Address` casts. For runtime normalization (checksumming), use `getAddress()` after an
  `isAddress` guard.
- **Address Comparison**: Use `isAddressEqual` from viem, never `.toLowerCase()` comparisons.

### Resolvers (`@repo/resolvers`)

If a bot imports `@repo/resolvers` (not shipped with the repo today; would arrive via a future
package TIB):

- **Event log resolvers** (`getLogs`-based) may require a `MorphoClient` since they depend on
  deployment metadata (e.g. `startBlock`) from the chain config.
- **State read resolvers** (`readContract`-based) should accept a generic `Client` with optional
  contract address params so they can be called from any chain client configured in the bot.
