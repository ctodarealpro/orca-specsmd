// Worker. The focused workspace decides where the project is read:
// - its folder exists on this computer: read the `.specs-fire` from this disk (local);
// - it lives on another Orca host (a paired server): ask the copy of this plugin on that server,
//   through Orca's CLI (./remote.mjs), passing the workspace folder so the server reads that project.
// Either way the worker answers the panel, keeps the status bar item current and polls for changes
// (fs.watch is unreliable on WSL and network folders).
// The same worker also serves remote peers: `specs.status`, `specs.snapshot` and `specs.read` take a
// `start` folder (on this host) from a peer and read the project above it.
import { stat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { findSpecsRoot, fingerprint, readSnapshot, statusLine } from './model.mjs'
import { cliEnvironment, listEnvironments, runRemote } from './remote.mjs'

const DEFAULT_POLL_SECONDS = 5
const MIN_REMOTE_POLL_SECONDS = 10
const MAX_READ_BYTES = 512 * 1024
/** Bumped on every change, so `specs.where` shows which code a worker runs. */
const REVISION = 5
let timer = null

/**
 * Lower-case path without a trailing separator. POSIX paths stay POSIX even on Windows, where a
 * paired server's workspaces are listed with their Linux paths.
 * @param {string} p
 */
const norm = (p) => (p.startsWith('/') ? path.posix.normalize(p) : path.resolve(p)).replace(/[\\/]+$/, '').toLowerCase()
const isInside = (file, dir) => {
  const f = norm(file)
  const d = norm(dir)
  return f.startsWith(`${d}/`) || f.startsWith(`${d}\\`)
}
/** Is this workspace folder on this computer's disk? A Linux path seen from Windows never is. */
async function isHere(folder) {
  if (!folder || (process.platform === 'win32' && folder.startsWith('/'))) return false
  try {
    return (await stat(folder)).isDirectory()
  } catch {
    return false
  }
}
const notFound = (message) => Object.assign(new Error(message), { code: 'not_found' })
const isUnknownServer = (error) => /unknown orca server|no paired orca server/i.test(String(error?.message))

/**
 * @type {import('orca/worker').Activate}
 * @param {{ runRemote?: typeof runRemote, listEnvironments?: typeof listEnvironments, isHere?: typeof isHere }} [deps]
 *   stand-ins for tests
 */
export default async function activate(orca, deps = {}) {
  const callRemote = deps.runRemote ?? runRemote
  const savedEnvironments = deps.listEnvironments ?? listEnvironments
  const folderIsHere = deps.isHere ?? isHere

  /**
   * Where the panel's project comes from.
   * @type {{ kind: 'none' | 'local' | 'remote', root: string | null, hostId?: string, start?: string,
   *   environment?: string | null, source: string, error: string | null }}
   */
  let target = { kind: 'none', root: null, source: 'none', error: null }
  // local
  let snapshot = null
  let lastPrint = null
  // remote
  let remoteAnswer = null
  let remoteReadAt = null
  /** hostId → environment selector that worked */
  const environmentOf = new Map()
  // serving peers: project root → { snapshot, print }
  const served = new Map()
  let busy = false

  const setting = async (key, fallback) => {
    try {
      const value = await orca.settings.get(key)
      return value === null || value === undefined || value === '' ? fallback : value
    } catch {
      return fallback
    }
  }
  const cliPath = async () => String(await setting('orcaCliPath', '')).trim()

  async function workspaces() {
    try {
      return (await orca.host.call('workspace.list', {})).workspaces
    } catch (error) {
      orca.log(`workspace.list falhou: ${error.code ?? error.message}`)
      return []
    }
  }

  const readContext = () => orca.host.call('workspace.readContext', {}).catch(() => null)

  /** Paired servers this Orca can ask: the setting, or the ones saved with `orca environment add`. */
  let serversCache = { at: 0, list: [] }
  async function servers() {
    const configured = String(await setting('remoteEnvironment', '')).trim()
    if (configured) return [configured]
    if (Date.now() - serversCache.at > 60000) {
      const saved = await savedEnvironments({ cliPath: await cliPath() }).catch(() => [])
      serversCache = { at: Date.now(), list: [...new Set(saved.map((env) => env.id ?? env.name).filter(Boolean))] }
    }
    return serversCache.list
  }

  async function localTarget(ws) {
    if (!(await folderIsHere(ws.path))) return null
    const root = await findSpecsRoot(ws.path)
    return root ? { kind: 'local', root, source: `workspace ${ws.name}`, error: null } : null
  }

  async function resolveTarget() {
    const configured = String(await setting('specsRoot', '')).trim()
    if (configured) {
      const root = await findSpecsRoot(configured)
      return root
        ? { kind: 'local', root, source: 'pasta configurada', error: null }
        : { kind: 'none', root: null, source: 'pasta configurada', error: `Nenhum .specs-fire/state.yaml em ${configured} nem acima dele` }
    }
    const list = await workspaces()
    const context = await readContext()
    const sameName = (ws) => Boolean(context) && ws.name === context.displayName
    const exact = list.find((ws) => sameName(ws) && (ws.branch ?? '') === (context.branch ?? '')) ?? null

    if (exact) {
      // The focused workspace is one this Orca lists: read it here, or ask its host when it is another one.
      const local = await localTarget(exact)
      // The same name and branch may also be a workspace of the paired server, and Orca does not tell
      // plugins which host the focus is on: let the person choose (setting "whenBoth", panel toggle).
      if ((await folderIsHere(exact.path)) && (await serverHas(context))) {
        const choice = { name: context.displayName, branch: context.branch ?? null }
        if ((await setting('whenBoth', 'local')) === 'server' || !local) {
          return { ...byNameOnServer(context), choice: { ...choice, current: 'server' } }
        }
        return { ...local, choice: { ...choice, current: 'local' } }
      }
      if (local) return local
      if (!(await folderIsHere(exact.path)) && exact.hostId && exact.hostId !== 'local') {
        return { kind: 'remote', root: null, hostId: exact.hostId, start: exact.path, workspace: null, environment: null, source: `workspace ${exact.name}`, error: null }
      }
    } else if (context?.displayName && (await servers()).length) {
      // Focus on a workspace this Orca does not list to plugins: on the desktop app paired to a
      // server, the server's workspaces are left out of workspace.list. Ask the server by name and branch.
      return byNameOnServer(context)
    }

    // Nothing in focus with a project: the same name, then the first workspace of this disk with one.
    const byName = list.find(sameName)
    for (const ws of [byName, ...list].filter(Boolean)) {
      const local = await localTarget(ws)
      if (local) return local
    }
    return {
      kind: 'none',
      root: null,
      source: 'none',
      error: 'Nenhum workspace aberto no Orca tem .specs-fire. Informe a pasta em Settings → Plugins → specs.md (FIRE) → Pasta do projeto.'
    }
  }

  const byNameOnServer = (context) => ({
    kind: 'remote',
    root: null,
    hostId: null,
    start: null,
    workspace: { name: context.displayName, branch: context.branch ?? null },
    environment: null,
    source: `workspace ${context.displayName}`,
    error: null
  })

  /** Does a paired server have a FIRE project in a workspace with this name and branch? Cached 60 s. */
  const serverHasCache = new Map()
  async function serverHas(context) {
    if (!context?.displayName || !(await servers()).length) return false
    const key = `${context.displayName}|${context.branch ?? ''}`
    const cached = serverHasCache.get(key)
    if (cached && Date.now() - cached.at < 60000) return cached.value
    const value = await remote('specs.status', {}, 20000, byNameOnServer(context)).then(
      () => true,
      () => false
    )
    serverHasCache.set(key, { at: Date.now(), value })
    return value
  }

  const targetKey = (t) =>
    `${t.kind}|${t.root ?? ''}|${t.hostId ?? ''}|${t.start ?? ''}|${t.workspace?.name ?? ''}|${t.workspace?.branch ?? ''}|${t.choice?.current ?? ''}`

  async function remote(name, data, timeoutMs, t = target) {
    const key = t.hostId ?? '*'
    const candidates = environmentOf.has(key)
      ? [environmentOf.get(key)]
      : [...new Set([t.hostId, ...(await servers())].filter((v) => v && v !== 'local'))].slice(0, 6)
    let lastError = null
    for (const environment of candidates) {
      try {
        const out = await callRemote({
          environment,
          name,
          data: { ...data, start: t.start, workspace: t.workspace },
          timeoutMs,
          cliPath: await cliPath()
        })
        environmentOf.set(key, environment)
        t.environment = environment
        return out
      } catch (error) {
        lastError = error
        if (!isUnknownServer(error)) throw error
      }
    }
    throw lastError ?? notFound('Nenhum servidor Orca pareado neste computador (veja `orca environment list`).')
  }

  const setStatusBar = (line) => orca.host.call('statusBar.update', { id: 'fire', ...line }).catch(() => undefined)
  const emptyLine = (tooltip, tone = 'neutral') => ({ text: 'FIRE —', tone, tooltip })

  async function refreshLocal({ force = false } = {}) {
    const print = await fingerprint(target.root)
    if (!force && print !== null && print === lastPrint && snapshot) return
    try {
      snapshot = await readSnapshot(target.root)
      lastPrint = print
      target.error = null
    } catch (error) {
      snapshot = null
      target.error = error.message
      orca.log(`Leitura de ${target.root} falhou: ${error.message}`)
    }
    orca.panels.post('specs.changed', { readAt: Date.now() })
    await setStatusBar(snapshot ? statusLine(snapshot) : emptyLine(target.error ?? 'specs.md: projeto não encontrado'))
  }

  async function refreshRemote({ force = false } = {}) {
    try {
      const status = await remote('specs.status', { force }, 30000)
      if (!force && remoteAnswer && !remoteAnswer.error && status.readAt === remoteReadAt) return
      const answer = await remote('specs.snapshot', {}, 60000)
      remoteAnswer = { ...answer, source: `${target.source} · servidor ${target.environment}` }
      remoteReadAt = status.readAt
      const line = status.line ?? emptyLine(answer.error ?? 'specs.md: projeto não encontrado')
      await setStatusBar({ ...line, tooltip: `${line.tooltip} (servidor ${target.environment})` })
    } catch (error) {
      const message = `Servidor do ${target.source}: ${error.message}`
      const changed = remoteAnswer?.error !== message
      remoteAnswer = { snapshot: null, root: null, source: target.source, error: message }
      remoteReadAt = null
      if (changed) orca.log(message)
      await setStatusBar(emptyLine(message, 'warning'))
      if (!changed) return
    }
    orca.panels.post('specs.changed', { readAt: Date.now() })
  }

  async function refresh({ force = false, resolve = false } = {}) {
    if (busy) return
    busy = true
    try {
      if (resolve || target.kind === 'none') {
        const next = await resolveTarget()
        if (next.kind === 'none') target = next // keep the newest explanation
        else if (targetKey(next) !== targetKey(target)) {
          target = next
          snapshot = null
          lastPrint = null
          remoteAnswer = null
          remoteReadAt = null
          force = true
        }
      }
      if (target.kind === 'local') await refreshLocal({ force })
      else if (target.kind === 'remote') await refreshRemote({ force })
      else if (force) {
        orca.panels.post('specs.changed', { readAt: Date.now() })
        await setStatusBar(emptyLine(target.error ?? 'specs.md: projeto não encontrado'))
      }
    } finally {
      busy = false
    }
  }

  const answer = () => ({
    ...(target.kind === 'remote'
      ? remoteAnswer ?? { snapshot: null, root: null, source: target.source, error: 'Lendo o servidor…' }
      : { snapshot, root: target.root, source: target.source, error: target.error }),
    choice: target.choice ?? null
  })

  // ---------- serving a peer: `start` is a folder on this host ----------

  /** The folder a peer asks about: `start` as given, or the folder of this Orca's workspace with that name and branch. */
  async function startOf(input) {
    if (input?.start) return String(input.start)
    const wanted = input?.workspace
    if (!wanted?.name) return null
    const list = await workspaces()
    const ws =
      list.find((w) => w.name === wanted.name && (w.branch ?? '') === (wanted.branch ?? '')) ?? list.find((w) => w.name === wanted.name)
    if (!ws) throw notFound(`Este servidor não tem o workspace ${wanted.name}${wanted.branch ? ` (${wanted.branch})` : ''}`)
    return ws.path
  }

  async function servedSnapshot(start, force) {
    const root = await findSpecsRoot(start)
    if (!root) throw notFound(`Nenhum .specs-fire/state.yaml em ${start} nem acima dele, neste servidor`)
    const entry = served.get(root) ?? { snapshot: null, print: null }
    const print = await fingerprint(root)
    if (force || !entry.snapshot || print === null || print !== entry.print) {
      entry.snapshot = await readSnapshot(root)
      entry.print = print
      served.set(root, entry)
    }
    return entry.snapshot
  }

  // ---------- handlers ----------

  orca.panels.handle('specs.snapshot', async (input) => {
    const force = input?.force
    if (input?.start || input?.workspace) {
      let start = input.start ?? input.workspace?.name
      try {
        start = await startOf(input)
        const snap = await servedSnapshot(start, Boolean(force))
        return { snapshot: snap, root: snap.root, source: `pasta ${start}`, error: null }
      } catch (error) {
        return { snapshot: null, root: null, source: `pasta ${start}`, error: error.message }
      }
    }
    const empty = target.kind === 'remote' ? !remoteAnswer : !snapshot
    if (force || empty) await refresh({ force: Boolean(force), resolve: Boolean(force) })
    return answer()
  })

  // Cheap check for a peer: re-reads only when the files changed.
  orca.panels.handle('specs.status', async (input) => {
    const force = input?.force
    const start = await startOf(input)
    if (start) {
      const snap = await servedSnapshot(start, Boolean(force))
      return { readAt: snap.readAt, root: snap.root, source: `pasta ${start}`, error: null, line: statusLine(snap) }
    }
    if (target.kind === 'local') await refreshLocal({ force: Boolean(force) || !snapshot })
    return {
      readAt: snapshot?.readAt ?? null,
      root: target.root,
      source: target.source,
      error: target.error,
      line: snapshot ? statusLine(snapshot) : null
    }
  })

  orca.panels.handle('specs.open', async (input) => {
    const file = String(input?.path ?? '')
    const list = await workspaces()
    const owner = list.filter((ws) => isInside(file, ws.path)).sort((a, b) => b.path.length - a.path.length)[0]
    if (!owner) throw notFound('Nenhum workspace do Orca contém esse arquivo. Abra a pasta do projeto como workspace.')
    await orca.host.call('editor.open', { workspaceId: owner.id, path: file })
    return { opened: true }
  })

  // Browser clients (`orca serve`) have no editor.open, so the panel shows the file itself.
  // Only files under the project's .specs-fire are served.
  orca.panels.handle('specs.read', async (input) => {
    const file = String(input?.path ?? '')
    const start = await startOf(input)
    let specsDir = null
    if (start) specsDir = (await servedSnapshot(start, false)).specsDir
    else if (target.kind === 'remote') return remote('specs.read', { path: file }, 30000)
    else {
      if (!snapshot) await refresh({ force: true })
      specsDir = snapshot?.specsDir ?? null
    }
    if (!specsDir || !isInside(file, specsDir)) {
      throw Object.assign(new Error('Só arquivos dentro do .specs-fire do projeto podem ser lidos.'), { code: 'not_permitted' })
    }
    const buffer = await readFile(path.resolve(file))
    return {
      path: file,
      name: path.basename(file),
      text: buffer.subarray(0, MAX_READ_BYTES).toString('utf8'),
      truncated: buffer.length > MAX_READ_BYTES
    }
  })

  // The panel's "Ler de" toggle, shown when the focused name and branch exist here and on the server.
  orca.panels.handle('specs.prefer', async (input) => {
    const where = input?.where === 'server' ? 'server' : 'local'
    await orca.settings.set('whenBoth', where)
    await refresh({ force: true, resolve: true })
    return answer()
  })

  // Diagnosis: what this Orca lists and where the worker decided to read.
  orca.panels.handle('specs.where', async () => {
    const list = await workspaces()
    const rows = await Promise.all(
      list.map(async (ws) => ({ name: ws.name, kind: ws.kind, path: ws.path, hostId: ws.hostId, here: await folderIsHere(ws.path) }))
    )
    const environments = await savedEnvironments({ cliPath: await cliPath() }).catch((error) => ({ error: error.message }))
    const cliEnv = cliEnvironment()
    return {
      revision: REVISION,
      platform: process.platform,
      appdata: { worker: process.env.APPDATA ?? null, cli: cliEnv.APPDATA ?? null },
      target,
      context: await orca.host.call('workspace.readContext', {}).catch((error) => ({ error: error.message })),
      workspaces: rows,
      environments,
      environmentOf: Object.fromEntries(environmentOf)
    }
  })

  orca.commands.register('fire.refresh', async () => {
    await refresh({ force: true, resolve: true })
    const current = answer()
    return current.snapshot ? `${statusLine(current.snapshot).text} (${current.source})` : current.error
  })

  orca.events.on('workspace.changed', async () => {
    // The focused workspace decides the project, unless a folder is configured.
    if (!String(await setting('specsRoot', '')).trim()) await refresh({ resolve: true })
  })

  orca.settings.onDidChange?.(async () => {
    environmentOf.clear()
    await refresh({ force: true, resolve: true })
    await schedule()
  })

  async function schedule() {
    if (timer) clearInterval(timer)
    const seconds = Number(await setting('pollSeconds', DEFAULT_POLL_SECONDS)) || DEFAULT_POLL_SECONDS
    let tick = 0
    timer = setInterval(() => {
      // Each remote check starts the CLI and crosses the network: not more often than every 10 s.
      tick += 1
      if (target.kind === 'remote' && tick * seconds < MIN_REMOTE_POLL_SECONDS) return
      tick = 0
      void refresh().catch((error) => orca.log(error.message))
    }, seconds * 1000)
  }

  await refresh({ force: true, resolve: true })
  await schedule()
}

export function deactivate() {
  if (timer) clearInterval(timer)
  timer = null
}
