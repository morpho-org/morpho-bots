export const productionPlaygroundBuildArguments = outdir => [
  'build',
  'playground/index.html',
  '--outdir',
  outdir,
  '--target',
  'browser',
  '--production',
  '--entry-naming',
  '[name].[ext]',
  '--asset-naming',
  '[name].[ext]',
  '--define',
  'process.env.NODE_ENV="production"',
  '--sourcemap=none',
  '--env=disable'
]
