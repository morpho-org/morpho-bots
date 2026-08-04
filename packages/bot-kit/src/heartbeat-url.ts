/** Parses a heartbeat URL only when it uses the HTTP or HTTPS protocol. */
export const parseHttpHeartbeatUrl = (value: string): URL | undefined => {
  try {
    const parsed = new URL(value.trim())
    return /^https?:$/.test(parsed.protocol) ? parsed : undefined
  } catch {
    return undefined
  }
}
