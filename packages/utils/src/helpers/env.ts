import type { RequiredByCondition, RequiredByImplication } from '../types/index'
import type { Parser } from './json'

export type EnvVarGetter<V> = (name: string, parse: Parser<V>) => V | undefined

// Despite extending an ordinary `string`, `Keys` is expected to be a union of
// env var names. The constraint on `name` says "be one of the keys, not a plain
// string", and the constraint on `env` says "contain every key".
//
// The more intuitive alternative is to have a generic
// `Env extends Record<string, string | undefined>`
// and then let `name: keyof Env`.
//
// That's worse for two reasons:
//   1. It's actually more complicated than that, because you need to exclude
//      symbol | number from the Record
//   2. On hover, the IDE would display the entire env type (whereas now
//      it's unobtrusive, just showing the key you asked for)
export type GetEnvVarOptions<Keys extends string, V = string> = {
  /** The name of the environment variable to retrieve */
  name: [string] extends [Keys] ? never : Keys
  /** The object to retrieve `name` from in production */
  env: { [K in Keys]: string | undefined }
} & RequiredByCondition<
  {
    /** The parser to apply to the raw string (default: no-op) */
    parse: Parser<V>
  },
  // If the expected output type (V) is string, a parser isn't required
  V extends string ? false : true
> &
  RequiredByImplication<
    {
      /** Whether to search `overrides` (in order) before `env` (default: false) */
      enableOverrides: boolean
      /** An array of override functions (e.g., `[getCookie, getLocalStorage]`) */
      overrides: EnvVarGetter<V>[]
    },
    'enableOverrides'
  >

/**
 * Helper for reading environment variables in a way that's compatible with
 * E2E testing.
 *
 * @dev By default, values are returned without any `parse` method applied,
 * which is expected for `process.env` strings. On the other hand,
 * `setCookie` and `setLocalStorage` default to `JSON.stringify`-like encoding,
 * so if/when using them to set env vars you should override *their*
 * stringifier with a no-op, `x => x`.
 *
 * @dev In Next.js apps, you **cannot** just pass `{ env: process.env }`.
 * In client-side code, Next looks for usages in the form
 * `process.env.NEXT_PUBLIC_{string}` and replaces them with their
 * build-time values. You **must** pass either:
 * ```
 * { env: { NEXT_PUBLIC_SOME_NAME: process.env.NEXT_PUBLIC_SOME_NAME } }
 * ```
 * at the call site, or a similar object (e.g. from a util file) that
 * references all required client-side env vars.
 */
export function getEnvVar<Keys extends string, V = string>(opts: GetEnvVarOptions<Keys, V>) {
  const parse: Parser<V> = opts.parse ?? ((v: string) => v as V)

  const name = opts.name
  const env = opts.env
  const value = env[name] !== undefined ? parse(env[name]) : undefined

  if (value === undefined) {
    console.group()
    console.debug(`${name} not in env`)
    if (env === undefined || Object.keys(env).length === 0) {
      console.warn('env:', env)
    }
    console.groupEnd()
  }

  if (opts.enableOverrides) {
    for (const getter of opts.overrides) {
      const alt = getter(name, parse)
      if (alt !== undefined) {
        return alt
      }
    }
  }

  return value
}

export function requireEnvVar<
  Keys extends string,
  V = string,
  Name = GetEnvVarOptions<Keys, V>['name']
>(getter: (name: Name) => V | undefined, name: Name): V {
  const value = getter(name)
  if (value === undefined) {
    throw new Error(`${String(name)} is not set`)
  }
  return value
}
