// Reads a FIRE (specs.md) project from disk and turns it into the snapshot the panel draws.
// Pure Node: no Orca API here, so it runs under plain `node --test`.
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from './vendor/yaml.mjs'

export const SPECS_DIR = '.specs-fire'
const STATE_FILE = 'state.yaml'
const MAX_WALK_UP = 6

/**
 * The status words FIRE intents use (including some common Portuguese ones), folded into five buckets so the panel can
 * count and colour them. Unknown words land in `other` and keep their original text.
 */
const STATUS_BUCKETS = {
  completed: 'done',
  done: 'done',
  delivered: 'done',
  in_progress: 'active',
  active: 'active',
  partial: 'active',
  blocked: 'blocked',
  pending: 'pending',
  draft: 'pending',
  deferred: 'deferred'
}

/** @param {unknown} status */
export function statusBucket(status) {
  return STATUS_BUCKETS[String(status ?? '').toLowerCase()] ?? 'other'
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Walks up from `start` looking for `.specs-fire/state.yaml`. In a multi-repo checkout the
 * workspace is often `<project>/<repo>` with `.specs-fire` one level up, so a few levels up is
 * enough.
 * @param {string} start
 * @returns {Promise<string | null>} the folder that holds `.specs-fire`
 */
export async function findSpecsRoot(start) {
  let dir = path.resolve(start)
  for (let i = 0; i <= MAX_WALK_UP; i++) {
    if (await exists(path.join(dir, SPECS_DIR, STATE_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

const asArray = (value) => (Array.isArray(value) ? value : [])
const asText = (value) => (value === null || value === undefined ? null : String(value))
const toMs = (value) => {
  if (!value) return null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

function countBy(items, key) {
  const counts = { done: 0, active: 0, blocked: 0, pending: 0, deferred: 0, other: 0 }
  for (const item of items) counts[key(item)] += 1
  return counts
}

/**
 * Reads `<root>/.specs-fire` into plain JSON.
 * @param {string} root folder that holds `.specs-fire`
 */
export async function readSnapshot(root) {
  const specsDir = path.join(root, SPECS_DIR)
  const statePath = path.join(specsDir, STATE_FILE)
  const warnings = []
  const [raw, info] = await Promise.all([readFile(statePath, 'utf8'), stat(statePath)])
  let state
  try {
    state = parse(raw) ?? {}
  } catch (error) {
    throw Object.assign(new Error(`state.yaml inválido: ${error.message}`), { code: 'invalid_state' })
  }

  const intentDirs = new Set(
    (await readdir(path.join(specsDir, 'intents'), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  )

  const intents = await Promise.all(
    asArray(state.intents).map(async (intent) => {
      const id = asText(intent.id) ?? '(sem id)'
      const dir = path.join(specsDir, 'intents', id)
      const hasDir = intentDirs.has(id)
      if (!hasDir) warnings.push(`Intent ${id} está no state.yaml sem pasta em intents/`)
      const files = hasDir ? await listFiles(dir) : []
      const itemFiles = hasDir ? await listFiles(path.join(dir, 'work-items')) : []
      const workItems = asArray(intent.work_items).map((item) => {
        const itemId = asText(item.id) ?? '(sem id)'
        const file = itemFiles.find((name) => name === `${itemId}.md`) ?? itemFiles.find((name) => name.startsWith(`${itemId}-`) || name.startsWith(`${itemId}.`))
        return {
          id: itemId,
          title: asText(item.title) ?? itemId,
          status: asText(item.status) ?? 'pending',
          bucket: statusBucket(item.status ?? 'pending'),
          complexity: asText(item.complexity),
          mode: asText(item.mode),
          dependsOn: asArray(item.depends_on).map(String),
          runId: asText(item.run_id),
          completedAt: toMs(item.completed_at),
          file: file ? path.join(dir, 'work-items', file) : null
        }
      })
      const done = workItems.filter((item) => item.bucket === 'done').length
      return {
        id,
        title: asText(intent.title) ?? id,
        status: asText(intent.status) ?? 'pending',
        bucket: statusBucket(intent.status ?? 'pending'),
        dir: hasDir ? dir : null,
        files: files.map((name) => ({ name, path: path.join(dir, name) })),
        workItems,
        progress: workItems.length ? Math.round((done / workItems.length) * 100) : null
      }
    })
  )

  for (const id of intentDirs) {
    if (!intents.some((intent) => intent.id === id)) {
      warnings.push(`Pasta intents/${id} sem entrada no state.yaml`)
    }
  }

  const runsState = state.runs ?? {}
  const readRun = async (run, finished) => {
    const id = asText(run.id) ?? '(sem id)'
    const dir = path.join(specsDir, 'runs', id)
    const files = await listFiles(dir)
    return {
      id,
      scope: asText(run.scope),
      currentItem: asText(run.current_item),
      started: toMs(run.started),
      completed: finished ? toMs(run.completed) : null,
      dir,
      files: files.map((name) => ({ name, path: path.join(dir, name) })),
      workItems: asArray(run.work_items).map((item) => ({
        id: asText(item.id) ?? '(sem id)',
        intent: asText(item.intent),
        mode: asText(item.mode),
        status: asText(item.status) ?? (finished ? 'completed' : 'pending'),
        phase: asText(item.current_phase),
        checkpoint: asText(item.checkpoint_state)
      }))
    }
  }
  const active = await Promise.all(asArray(runsState.active).map((run) => readRun(run, false)))
  const completed = (await Promise.all(asArray(runsState.completed).map((run) => readRun(run, true)))).sort(
    (a, b) => (b.completed ?? 0) - (a.completed ?? 0)
  )

  const allItems = intents.flatMap((intent) => intent.workItems)
  return {
    root,
    specsDir,
    statePath,
    stateMtime: info.mtimeMs,
    readAt: Date.now(),
    project: {
      name: asText(state.project?.name) ?? path.basename(root),
      description: asText(state.project?.description),
      fireVersion: asText(state.project?.fire_version),
      workspaceType: asText(state.workspace?.type),
      parts: asArray(state.workspace?.parts).map(String)
    },
    intents,
    runs: { active, completed },
    stats: {
      intents: { total: intents.length, ...countBy(intents, (intent) => intent.bucket) },
      workItems: { total: allItems.length, ...countBy(allItems, (item) => item.bucket) },
      runs: { active: active.length, completed: completed.length }
    },
    warnings
  }
}

/** mtime of state.yaml plus every file under runs/, so a phase change or a new walkthrough shows up. */
export async function fingerprint(root) {
  const specsDir = path.join(root, SPECS_DIR)
  const parts = []
  try {
    parts.push((await stat(path.join(specsDir, STATE_FILE))).mtimeMs)
  } catch {
    return null
  }
  const runsDir = path.join(specsDir, 'runs')
  const runs = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  for (const run of runs) {
    if (!run.isDirectory()) continue
    const files = await readdir(path.join(runsDir, run.name)).catch(() => [])
    parts.push(`${run.name}:${files.length}`)
    for (const name of files) {
      const info = await stat(path.join(runsDir, run.name, name)).catch(() => null)
      if (info) parts.push(info.mtimeMs)
    }
  }
  return parts.join('|')
}

/** Short status bar text: the item the active run is on, or the overall progress. */
export function statusLine(snapshot) {
  const run = snapshot.runs.active[0]
  if (run) {
    const item = run.workItems.find((wi) => wi.id === run.currentItem) ?? run.workItems[0]
    const phase = item?.phase ? ` · ${item.phase}` : ''
    const waiting = item?.checkpoint === 'awaiting_approval'
    return {
      text: `FIRE ${item?.id ?? run.id}${phase}`,
      tone: waiting ? 'warning' : 'accent',
      tooltip: waiting
        ? `${run.id}: ${item?.id} aguardando aprovação`
        : `${run.id}: ${run.workItems.length} work item(s)`
    }
  }
  const { done, total } = snapshot.stats.workItems
  return {
    text: `FIRE ${done}/${total}`,
    tone: 'neutral',
    tooltip: `${snapshot.project.name}: nenhuma run ativa`
  }
}
