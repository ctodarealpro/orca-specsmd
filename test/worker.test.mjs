import assert from 'node:assert/strict'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import activate, { deactivate } from '../plugin/worker/main.mjs'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// A failed assertion skips the test's own deactivate(); the poll timer must not keep node alive.
afterEach(() => deactivate())

/** Minimal stand-in for the worker `orca` object (the real one comes from `orca plugin test`). */
function fakeOrca({ settings = {}, workspaces = [], context = null } = {}) {
  const handlers = {}
  let focus = context
  const calls = []
  const posts = []
  return {
    handlers,
    setContext: (next) => (focus = next),
    calls,
    posts,
    log: () => {},
    settings: { get: async (key) => settings[key] ?? null, set: async (key, value) => void (settings[key] = value) },
    host: {
      call: async (method, params) => {
        calls.push({ method, params })
        if (method === 'workspace.list') return { workspaces, truncated: false }
        if (method === 'workspace.readContext') return focus
        return { ok: true }
      }
    },
    panels: { handle: (name, fn) => (handlers[name] = fn), post: (event, payload) => posts.push({ event, payload }) },
    commands: { register: () => ({ dispose() {} }) },
    events: { on: () => ({ dispose() {} }) }
  }
}

test('acha o projeto pelo workspace em foco e atualiza a barra de status', async () => {
  const orca = fakeOrca({
    workspaces: [{ id: 'ws-1', kind: 'folder', name: 'demo', path: path.join(fixtures, '.specs-fire', 'intents'), branch: null, hostId: null }],
    context: { branch: '', displayName: 'demo', terminals: [] }
  })
  await activate(orca)
  const answer = await orca.handlers['specs.snapshot']({})
  assert.equal(answer.root, fixtures)
  assert.equal(answer.source, 'workspace demo')
  assert.equal(answer.snapshot.runs.active[0].id, 'run-demo-001')
  const bar = orca.calls.filter((c) => c.method === 'statusBar.update').at(-1)
  assert.equal(bar.params.text, 'FIRE W-DEMO-02 · plan')
  deactivate()
})

test('a pasta configurada vence o workspace e abre arquivo pelo workspace que o contém', async () => {
  const orca = fakeOrca({
    settings: { specsRoot: fixtures },
    workspaces: [{ id: 'ws-2', kind: 'folder', name: 'fx', path: fixtures, branch: null, hostId: null }]
  })
  await activate(orca)
  const answer = await orca.handlers['specs.snapshot']({ force: true })
  assert.equal(answer.source, 'pasta configurada')
  const brief = path.join(fixtures, '.specs-fire', 'intents', 'demo', 'brief.md')
  await orca.handlers['specs.open']({ path: brief })
  assert.deepEqual(orca.calls.find((c) => c.method === 'editor.open').params, { workspaceId: 'ws-2', path: brief })
  await assert.rejects(orca.handlers['specs.open']({ path: '/fora/de/tudo.md' }), { code: 'not_found' })
  deactivate()
})

test('lê arquivo do .specs-fire para o painel e recusa o que está fora', async () => {
  const orca = fakeOrca({ settings: { specsRoot: fixtures } })
  await activate(orca)
  const brief = path.join(fixtures, '.specs-fire', 'intents', 'demo', 'brief.md')
  const file = await orca.handlers['specs.read']({ path: brief })
  assert.equal(file.name, 'brief.md')
  assert.equal(file.truncated, false)
  assert.ok(file.text.length > 0)
  await assert.rejects(orca.handlers['specs.read']({ path: path.join(fixtures, '..', 'worker.test.mjs') }), { code: 'not_permitted' })
  await assert.rejects(orca.handlers['specs.read']({ path: path.join(fixtures, '.specs-fire', '..', '..', 'worker.test.mjs') }), { code: 'not_permitted' })
  deactivate()
})

test('specs.status responde a linha da barra e o readAt, para a cópia remota', async () => {
  const orca = fakeOrca({ settings: { specsRoot: fixtures } })
  await activate(orca)
  const status = await orca.handlers['specs.status']({})
  assert.equal(status.root, fixtures)
  assert.equal(status.line.text, 'FIRE W-DEMO-02 · plan')
  assert.equal(typeof status.readAt, 'number')
  deactivate()
})

test('cada um lê do seu: workspace local lê o disco, workspace de outro host pede ao servidor dele', async () => {
  // The "server" is a second worker; runRemote calls its handlers directly, as the CLI would.
  const server = fakeOrca()
  await activate(server)
  const calls = []
  const runRemote = async ({ environment, name, data }) => {
    // The hostId is not a saved environment name; the saved environment "env-1" is.
    if (environment !== 'env-1') throw new Error(`Unknown Orca server in --environment ${environment}: no paired Orca server is named or has id ${environment}.`)
    return server.handlers[name](data)
  }
  const listEnvironments = async () => [{ id: 'env-1', name: 'notebook-linux' }]
  const remoteFolder = '/srv/linux/hub' // not on this disk
  const local = { id: 'ws-local', kind: 'folder', name: 'local', path: fixtures, branch: null, hostId: null }
  const distant = { id: 'ws-remoto', kind: 'folder', name: 'hub', path: remoteFolder, branch: 'develop', hostId: 'runtime:abc' }
  const client = fakeOrca({ workspaces: [local, distant], context: { branch: 'develop', displayName: 'hub', terminals: [] } })
  // The server sees remoteFolder as the fixtures folder.
  const serverRunRemote = async (options) => {
    calls.push({ environment: options.environment, name: options.name, start: options.data?.start })
    if (options.data?.start === remoteFolder) options = { ...options, data: { ...options.data, start: fixtures } }
    return runRemote(options)
  }
  await activate(client, { runRemote: serverRunRemote, listEnvironments, isHere: async (p) => p === fixtures })

  const answer = await client.handlers['specs.snapshot']({})
  assert.equal(answer.root, fixtures)
  assert.equal(answer.source, 'workspace hub · servidor env-1')
  assert.equal(answer.snapshot.runs.active[0].id, 'run-demo-001')
  assert.deepEqual([...new Set(calls.map((c) => c.environment))], ['runtime:abc', 'env-1'])
  assert.ok(calls.every((c) => c.start === remoteFolder))
  const bar = client.calls.filter((c) => c.method === 'statusBar.update').at(-1)
  assert.equal(bar.params.text, 'FIRE W-DEMO-02 · plan')

  // Once found, env-1 is used straight away, and an unchanged server costs only specs.status.
  calls.length = 0
  await client.handlers['specs.snapshot']({ force: false })
  assert.equal(calls.length, 0)
  const brief = path.join(fixtures, '.specs-fire', 'intents', 'demo', 'brief.md')
  const file = await client.handlers['specs.read']({ path: brief })
  assert.equal(file.name, 'brief.md')
  assert.deepEqual(calls.map((c) => c.environment), ['env-1'])

  // Focus moves to the local workspace: read from this disk. The only server call is the check
  // "does the server also have this name?" (it does not, so there is no choice to show).
  calls.length = 0
  client.setContext({ branch: '', displayName: 'local', terminals: [] })
  await client.handlers['specs.snapshot']({ force: true })
  const localAnswer = await client.handlers['specs.snapshot']({})
  assert.equal(localAnswer.source, 'workspace local')
  assert.equal(localAnswer.choice, null)
  assert.deepEqual(calls.map((c) => c.name), ['specs.status'])
  deactivate()
})

test('app desktop pareado: foco num workspace que o Orca não lista vai ao servidor salvo, por nome e branch', async () => {
  // As on Windows: workspace.list has only this machine's (WSL) workspaces; the server's are left out.
  const server = fakeOrca({
    workspaces: [{ id: 's1', kind: 'worktree', name: 'feature-x', path: fixtures, branch: 'feature-x', hostId: 'local' }]
  })
  await activate(server)
  const calls = []
  const runRemote = async ({ environment, name, data }) => {
    calls.push({ environment, name, workspace: data.workspace })
    return server.handlers[name](data)
  }
  const wsl = { id: 'w1', kind: 'worktree', name: 'develop', path: '\\\\wsl.localhost\\Ubuntu\\home\\repos\\hub', branch: 'develop', hostId: 'local' }
  const client = fakeOrca({ workspaces: [wsl], context: { branch: 'feature-x', displayName: 'feature-x', terminals: [] } })
  await activate(client, { runRemote, listEnvironments: async () => [{ id: 'env-1', name: 'linux' }], isHere: async () => false })

  const answer = await client.handlers['specs.snapshot']({})
  assert.equal(answer.root, fixtures)
  assert.equal(answer.source, 'workspace feature-x · servidor env-1')
  assert.deepEqual(calls[0], { environment: 'env-1', name: 'specs.status', workspace: { name: 'feature-x', branch: 'feature-x' } })

  // A name the server does not have comes back as a readable error.
  client.setContext({ branch: 'x', displayName: 'nao-existe', terminals: [] })
  const missing = await client.handlers['specs.snapshot']({ force: true })
  assert.match(missing.error, /não tem o workspace nao-existe \(x\)/)
})

test('CLI no Windows: APPDATA volta a partir da pasta do usuário', async () => {
  const { cliEnvironment } = await import('../plugin/worker/remote.mjs')
  const env = cliEnvironment({ PATH: 'x' }, 'win32', 'C:\\Users\\voce')
  assert.equal(env.APPDATA, 'C:\\Users\\voce\\AppData\\Roaming')
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\voce\\AppData\\Local')
  assert.equal(env.USERPROFILE, 'C:\\Users\\voce')
  assert.equal(cliEnvironment({ APPDATA: 'D:\\x' }, 'win32', 'C:\\Users\\voce').APPDATA, 'D:\\x')
})

test('servidor de outro host fora do ar vira erro legível no painel e aviso na barra', async () => {
  const runRemote = async () => {
    throw Object.assign(new Error('connection refused'), { code: 'unavailable' })
  }
  const client = fakeOrca({
    workspaces: [{ id: 'w', kind: 'folder', name: 'hub', path: '/srv/x', branch: null, hostId: 'h1' }],
    context: { branch: '', displayName: 'hub', terminals: [] }
  })
  await activate(client, { runRemote, listEnvironments: async () => [], isHere: async () => false })
  const answer = await client.handlers['specs.snapshot']({ force: true })
  assert.equal(answer.snapshot, null)
  assert.match(answer.error, /^Servidor do workspace hub: connection refused/)
  const bar = client.calls.filter((c) => c.method === 'statusBar.update').at(-1)
  assert.equal(bar.params.tone, 'warning')
  deactivate()
})

test('servindo um par: specs.read com start só entrega arquivo do .specs-fire acima de start', async () => {
  const orca = fakeOrca()
  await activate(orca)
  const brief = path.join(fixtures, '.specs-fire', 'intents', 'demo', 'brief.md')
  const file = await orca.handlers['specs.read']({ path: brief, start: path.join(fixtures, '.specs-fire', 'intents') })
  assert.equal(file.name, 'brief.md')
  await assert.rejects(orca.handlers['specs.read']({ path: '/etc/passwd', start: fixtures }), { code: 'not_permitted' })
  deactivate()
})

test('sem projeto, explica o que fazer', async () => {
  const orca = fakeOrca()
  await activate(orca)
  const answer = await orca.handlers['specs.snapshot']({})
  assert.equal(answer.snapshot, null)
  assert.match(answer.error, /Pasta do projeto/)
  deactivate()
})

test('CLI no Windows: APPDATA vazio ou com outra caixa também é preenchido', async () => {
  const { cliEnvironment } = await import('../plugin/worker/remote.mjs')
  const env = cliEnvironment({ AppData: '' }, 'win32', 'C:\\Users\\voce')
  assert.equal(env.APPDATA, 'C:\\Users\\voce\\AppData\\Roaming')
  assert.ok(!('AppData' in env))
})

test('mesmo nome e branch aqui e no servidor: lê daqui por padrão e o painel troca para o servidor', async () => {
  const serverFolder = path.join(fixtures, '.specs-fire', 'intents')
  const server = fakeOrca({ workspaces: [{ id: 's', kind: 'worktree', name: 'develop', path: serverFolder, branch: 'develop', hostId: 'local' }] })
  await activate(server)
  const runRemote = async ({ name, data }) => server.handlers[name](data)
  const here = { id: 'w', kind: 'worktree', name: 'develop', path: fixtures, branch: 'develop', hostId: 'local' }
  const client = fakeOrca({ workspaces: [here], context: { branch: 'develop', displayName: 'develop', terminals: [] } })
  await activate(client, { runRemote, listEnvironments: async () => [{ id: 'env-1' }], isHere: async (p) => p === fixtures })

  const first = await client.handlers['specs.snapshot']({})
  assert.deepEqual(first.choice, { name: 'develop', branch: 'develop', current: 'local' })
  assert.equal(first.source, 'workspace develop')

  const switched = await client.handlers['specs.prefer']({ where: 'server' })
  assert.equal(switched.choice.current, 'server')
  assert.equal(switched.source, 'workspace develop · servidor env-1')
  assert.equal(switched.root, fixtures)
})
