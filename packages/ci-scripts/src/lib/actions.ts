import { randomUUID } from 'node:crypto'
import fs from 'node:fs'

/** Read a required env var; a missing or empty one fails loud with its name. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set`)
  }
  return value
}

export function getRepo(): { owner: string; repo: string } {
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/')
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be <owner>/<repo>')
  return { owner, repo }
}

export function getSha(): string {
  return requireEnv('GITHUB_SHA')
}

export function readPayload<T>(): T {
  return JSON.parse(fs.readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8')) as T
}

/**
 * Append a step output using the heredoc form, so values containing newlines or `=` survive.
 * https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions#multiline-strings
 */
export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (!file) {
    console.log(`[output] ${name}=${value}`)
    return
  }
  const delimiter = `ghadelimiter_${randomUUID()}`
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

export function info(message: string): void {
  console.log(message)
}

export function warning(message: string): void {
  console.log(`::warning::${escapeCommandData(message)}`)
}

export function setFailed(message: string): void {
  console.log(`::error::${escapeCommandData(message)}`)
  process.exitCode = 1
}

function escapeCommandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}
