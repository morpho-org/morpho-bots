// The prod-only AOT bundle for the queue daemon: `Bun.build` → `dist/main.js`. Deliberately NO
// soltag plugins — the daemon's whole module graph is lens/soltag-free (it imports only the cores'
// `./queue` subpaths, never the core index that carries the `sol``` lens templates). Registering a
// soltag plugin here would either be dead weight or, worse, silently pull the lens graph into the
// bundle; a `grep` for `sol\`` in `dist/main.js` must find nothing. The Dockerfile spells out the
// runtime invocation (`bun /repo/services/queued/dist/main.js --chain "$CHAIN_ID"`); dev/test stay
// source-run and the `bin` keeps pointing at `src/main.ts`.

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
