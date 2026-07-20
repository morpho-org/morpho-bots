import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vitest transpiles TS with esbuild, which cannot emit decorator metadata — NestJS constructor
  // injection needs it, so test files are built with SWC instead (the official NestJS recipe).
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true }
      }
    })
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts']
  }
})
