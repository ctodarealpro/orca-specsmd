import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findSpecsRoot, fingerprint, readSnapshot, statusBucket, statusLine } from '../plugin/worker/model.mjs'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('acha o .specs-fire subindo a partir de uma subpasta', async () => {
  assert.equal(await findSpecsRoot(path.join(fixtures, '.specs-fire', 'intents', 'demo')), fixtures)
  assert.equal(await findSpecsRoot('/'), null)
})

test('agrupa os status do FIRE', () => {
  assert.equal(statusBucket('completed'), 'done')
  assert.equal(statusBucket('delivered'), 'done')
  assert.equal(statusBucket('partial'), 'active')
  assert.equal(statusBucket('draft'), 'pending')
  assert.equal(statusBucket('qualquer'), 'other')
})

test('lê intents, work items, arquivos e progresso', async () => {
  const s = await readSnapshot(fixtures)
  assert.equal(s.project.name, 'demo')
  const demo = s.intents.find((i) => i.id === 'demo')
  assert.deepEqual(demo.files.map((f) => f.name), ['brief.md'])
  assert.equal(demo.progress, 67)
  const w2 = demo.workItems.find((w) => w.id === 'W-DEMO-02')
  assert.equal(path.basename(w2.file), 'W-DEMO-02.md')
  assert.deepEqual(w2.dependsOn, ['W-DEMO-01'])
  assert.equal(demo.workItems.find((w) => w.id === 'W-DEMO-03').file, null)
  assert.deepEqual(s.stats.workItems, { total: 3, done: 2, active: 1, blocked: 0, pending: 0, deferred: 0, other: 0 })
  assert.deepEqual(s.stats.intents.total, 2)
})

test('lê a run ativa com fase, checkpoint e arquivos', async () => {
  const s = await readSnapshot(fixtures)
  const run = s.runs.active[0]
  assert.equal(run.id, 'run-demo-001')
  assert.equal(run.currentItem, 'W-DEMO-02')
  assert.equal(run.workItems[0].phase, 'plan')
  assert.deepEqual(run.files.map((f) => f.name), ['run.md'])
  assert.equal(run.started, Date.parse('2026-10-21T01:43:53.161Z'))
  assert.deepEqual(statusLine(s), {
    text: 'FIRE W-DEMO-02 · plan',
    tone: 'warning',
    tooltip: 'run-demo-001: W-DEMO-02 aguardando aprovação'
  })
})

test('avisa divergência entre state.yaml e as pastas', async () => {
  const s = await readSnapshot(fixtures)
  assert.ok(s.warnings.includes('Intent orfa está no state.yaml sem pasta em intents/'))
  assert.ok(s.warnings.includes('Pasta intents/sem-estado sem entrada no state.yaml'))
})

test('fingerprint muda só quando o projeto muda', async () => {
  assert.equal(await fingerprint(fixtures), await fingerprint(fixtures))
  assert.equal(await fingerprint(path.join(fixtures, 'nada')), null)
})

test('cabe nos limites do Orca com um state.yaml real', { skip: !process.env.FIRE_ROOT }, async () => {
  const s = await readSnapshot(process.env.FIRE_ROOT)
  const bytes = Buffer.byteLength(JSON.stringify(s))
  assert.ok(bytes < 1024 * 1024, `resposta com ${bytes} bytes passa de 1 MiB`)
  const treeItems = s.intents.reduce((n, i) => n + 1 + i.files.length + i.workItems.length, 0)
  assert.ok(treeItems < 2000, `${treeItems} itens passam do limite do Tree`)
  console.log(JSON.stringify({ bytes, treeItems, stats: s.stats, active: s.runs.active.map((r) => r.id), warnings: s.warnings.length, line: statusLine(s) }))
})
