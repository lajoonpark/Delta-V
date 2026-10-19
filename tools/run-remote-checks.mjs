// Bundles and runs the Delta-V check scripts. They import the `@shared` /
// `@renderer` aliases, so they must be bundled with esbuild before they run
// under Node.
// Cross-platform: uses esbuild's API (esbuild ships as a transitive dependency
// of vite) plus os.tmpdir() - no shell, no hard-coded paths.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = ['crash-fx-check', 'remote-bridge-check', 'remote-client-pure-check', 'remote-client-check']
const outDir = mkdtempSync(join(tmpdir(), 'deltav-remote-checks-'))
let failed = false

try {
  for (const name of checks) {
    const outfile = join(outDir, `${name}.cjs`)
    await build({
      entryPoints: [resolve(root, 'tools', `${name}.ts`)],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      alias: {
        '@shared': resolve(root, 'src', 'shared'),
        '@renderer': resolve(root, 'src', 'renderer', 'src')
      },
      outfile,
      logLevel: 'warning'
    })
    console.log(`\n> ${name}`)
    execFileSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root })
  }
} catch (err) {
  failed = true
  console.error(err instanceof Error ? err.message : String(err))
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
