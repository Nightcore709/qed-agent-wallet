import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The development server serves every file under this folder by its path. data/ holds the running service's state
// (the database and its copies, the rail token, the review account's sign-in, fixture sessions), so it is refused,
// beside Vite's own default list (which setting `deny` replaces). Vite matches a pattern that contains a slash
// against the absolute path, so the folder is named absolutely, with glob characters escaped.
// server/dev-server-files.test.ts checks it against a running dev server.
const dataDir = fileURLToPath(new URL('./data', import.meta.url)).replaceAll('\\', '/').replace(/[()[\]{}*?!+@]/g, '\\$&')
const viteDefaultDeny = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**']

// Absolute base: the API serves the built interface at the root, and a page opened or reloaded on a nested route
// (/instructions/new) must still find its script and styles. A relative base made every such page blank.
// The page's Content-Security-Policy has a nonce made for each response (server/api.ts servePage): the build writes this
// placeholder in the nonce attribute of every script, style and preload tag of index.html, and in the csp-nonce meta tag
// Vite's preload helper reads for the tags it adds later; the server puts the response's own nonce in its place.
// server/static-compress.test.ts holds this equal to api.ts NONCE_PLACEHOLDER. Source maps are made but not referenced
// ('hidden'), and the server never serves them (ASVS 5.0 V13.4.2).
const CSP_NONCE_PLACEHOLDER = 'qedcspnonce0'

export default defineConfig({
  base: '/',
  plugins: [react()],
  html: { cspNonce: CSP_NONCE_PLACEHOLDER },
  build: { target: 'es2022', sourcemap: 'hidden' },
  // In development the interface is served by Vite and talks to the API service on its own port.
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.QED_API_PORT ?? 5175}`, changeOrigin: false } },
    fs: { deny: [...viteDefaultDeny, dataDir, `${dataDir}/**`] },
  },
  test: {
    include: ['src/**/*.test.ts', 'shared/**/*.test.ts', 'server/**/*.test.ts'],
    environment: 'node',
    // The route tests hash passwords with scrypt (slow on purpose) and drive chain stand-ins. With several worktrees
    // running suites at once (load average near 20, RISK-078) they overran the 5 s default and passed when run alone.
    // A test that truly hangs still fails, at 20 s.
    testTimeout: 20_000,
  },
})
