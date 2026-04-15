import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT_DIR = resolve(import.meta.dir, '..')

function parseArgs(args: string[]): { configDir: string | null } {
  const idx = args.indexOf('--config')
  if (idx === -1 || idx + 1 >= args.length) return { configDir: null }
  return { configDir: resolve(args[idx + 1]!) }
}

function loadEnvFile(configDir: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const dir of [configDir, dirname(configDir)]) {
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) continue
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim()
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (key && !(key in vars)) vars[key] = value
    }
  }
  return vars
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

async function main() {
  const { configDir } = parseArgs(process.argv.slice(2))

  if (!configDir) {
    console.log('Deploying with in-tree config...')
    await run('npx', ['wrangler', 'deploy', '--minify'], ROOT_DIR)
    return
  }

  console.log(`Deploying with external config: ${configDir}`)
  const wranglerConfig = join(configDir, 'wrangler.jsonc')
  if (!existsSync(wranglerConfig)) {
    throw new Error(`wrangler.jsonc not found in ${configDir}`)
  }
  const envVars = loadEnvFile(configDir)
  // Pass entry as a positional arg so wrangler resolves it relative to ROOT_DIR
  // rather than to the external config file's location.
  await run(
    'npx',
    ['wrangler', 'deploy', 'src/index.ts', '--minify', '--config', wranglerConfig],
    ROOT_DIR,
    envVars,
  )
  console.log('Deploy complete.')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
