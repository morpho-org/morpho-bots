export const productionPlaygroundBuildArguments = outdir => [
  'build',
  'playground/index.html',
  '--outdir',
  outdir,
  '--target',
  'browser',
  '--production',
  '--minify',
  '--define',
  'process.env.NODE_ENV="production"',
  '--sourcemap=none',
  '--env=disable'
]
