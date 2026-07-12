// AOT bundle for both `morpho-queued serve` and `submit`. The generic queue imports no bot core or
// soltag lens graph.

const result = await Bun.build({
  entrypoints: ['src/main.ts'],
  target: 'bun',
  outdir: 'dist'
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  // Fail loud: a bundler error must break the build layer, not ship a broken artifact.
  throw new AggregateError(result.logs, 'queued build failed')
}

console.log(`built ${result.outputs.length} file(s) → dist/`)
