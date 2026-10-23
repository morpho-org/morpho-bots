/** Where a library fold's log events go: the bot's logger, under the names each fold documents. */
export type LogSink = Readonly<
  Record<'info' | 'warn', (event: string, fields?: Record<string, unknown>) => void>
>
