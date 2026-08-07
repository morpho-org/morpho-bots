export const productionPlaygroundBuildArguments = outdir => [
  'build',
  'playground',
  '--outDir',
  outdir,
  '--target',
  'es2022',
  '--minify',
  'esbuild',
  '--assetsDir',
  '.',
  '--base',
  './',
  '--sourcemap',
  'false'
]
