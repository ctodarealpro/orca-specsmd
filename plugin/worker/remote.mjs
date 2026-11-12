// Remote mode: this Orca (for example the desktop app on Windows) shows the panel, and the copy of
// the plugin on a paired Orca server reads the files. The worker asks that copy through Orca's own
// CLI (`orca plugin dev request --environment <server>`), so it rides the existing pairing: no new
// port, no token of ours.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const REMOTE_PLUGIN_KEY = 'local.specsmd-fire'

/**
 * How to run Orca's CLI from inside the plugin worker. The worker runs as `<Orca executable>
 * plugin-host-entry.js` with ELECTRON_RUN_AS_NODE, so the CLI is the `cli/index.js` next to it,
 * run the same way (that is what `resources/bin/orca-ide` does).
 * @param {string} [override] path to `cli/index.js` or to an executable
 */
export function cliCommand(override) {
  const asNode = (file) => ({ command: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: '1' } })
  if (override) return override.endsWith('.js') ? asNode(override) : { command: override, args: [], env: {} }
  const dir = path.dirname(process.execPath)
  const candidates = [
    path.join(dir, 'resources', 'app.asar.unpacked', 'out', 'cli', 'index.js'), // Windows, Linux
    path.join(dir, '..', 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js') // macOS
  ]
  const found = candidates.find((file) => existsSync(file))
  return found ? asNode(found) : null
}

/**
 * The plugin host starts the worker with a trimmed environment. On Windows that leaves out APPDATA,
 * and the CLI then cannot find the saved servers ("APPDATA is not set, so the Orca runtime metadata
 * path cannot be resolved"). Fill the user folders back in from the home folder.
 */
export function cliEnvironment(base = process.env, platform = process.platform, home = os.homedir()) {
  const env = { ...base }
  // Windows names are case-insensitive: an empty "AppData" must not hide our "APPDATA".
  const fill = (name, value) => {
    const keys = Object.keys(env).filter((key) => (platform === 'win32' ? key.toUpperCase() === name : key === name))
    if (keys.some((key) => env[key])) return
    for (const key of keys) delete env[key]
    env[name] = value
  }
  if (platform === 'win32' && home) {
    fill('USERPROFILE', home)
    fill('APPDATA', path.win32.join(home, 'AppData', 'Roaming'))
    fill('LOCALAPPDATA', path.win32.join(home, 'AppData', 'Local'))
  } else if (home) {
    fill('HOME', home)
  }
  return env
}

function runCli(args, { cliPath = '', timeoutMs = 30000 } = {}) {
  const cli = cliCommand(cliPath)
  if (!cli) {
    return Promise.reject(
      Object.assign(new Error(`CLI do Orca não encontrado ao lado de ${process.execPath}. Informe o caminho em "CLI do Orca".`), {
        code: 'cli_not_found'
      })
    )
  }
  return new Promise((resolve, reject) => {
    execFile(
      cli.command,
      [...cli.args, ...args],
      { env: { ...cliEnvironment(), ...cli.env }, timeout: timeoutMs + 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        let parsed = null
        try {
          parsed = JSON.parse(String(stdout))
        } catch {
          // not JSON: report stderr below
        }
        if (parsed?.ok) return resolve(parsed.result)
        const message =
          parsed?.error?.message ?? String(stderr || error?.message || 'o CLI do Orca não respondeu').trim().slice(0, 500)
        reject(Object.assign(new Error(message), { code: parsed?.error?.code ?? 'remote_failed' }))
      }
    )
  })
}

/**
 * The paired Orca servers saved on this machine (`orca environment list`), as { id, name }.
 * The JSON shape is read loosely: any array of objects with an id or a name.
 */
export async function listEnvironments({ cliPath = '' } = {}) {
  const result = await runCli(['environment', 'list', '--json'], { cliPath, timeoutMs: 15000 })
  const found = []
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object' && (item.id || item.name)) found.push({ id: item.id ?? null, name: item.name ?? null })
        else walk(item)
      }
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) walk(child)
    }
  }
  walk(result)
  return found
}

/**
 * Calls a handler of the plugin on the paired server and resolves with what it returned.
 * @param {{ environment: string, name: string, data?: unknown, cliPath?: string, timeoutMs?: number }} options
 */
export function runRemote({ environment, name, data = {}, cliPath = '', timeoutMs = 30000 }) {
  const args = ['plugin', 'dev', 'request', REMOTE_PLUGIN_KEY, name, '--environment', environment, '--data', JSON.stringify(data), '--timeout-ms', String(timeoutMs), '--json']
  return runCli(args, { cliPath, timeoutMs }).then((result) => result?.result)
}
