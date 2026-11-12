// Panel ↔ worker contract, documenting panel/index.html and worker/main.mjs.
export {}

export type Bucket = 'done' | 'active' | 'blocked' | 'pending' | 'deferred' | 'other'
export type Counts = Record<Bucket, number> & { total: number }
export type FileRef = { name: string; path: string }

export type WorkItem = {
  id: string
  title: string
  status: string
  bucket: Bucket
  complexity: string | null
  mode: string | null
  dependsOn: string[]
  runId: string | null
  completedAt: number | null
  file: string | null
}

export type Intent = {
  id: string
  title: string
  status: string
  bucket: Bucket
  dir: string | null
  files: FileRef[]
  workItems: WorkItem[]
  progress: number | null
}

export type RunItem = {
  id: string
  intent: string | null
  mode: string | null
  status: string
  phase: string | null
  checkpoint: string | null
}

export type Run = {
  id: string
  scope: string | null
  currentItem: string | null
  started: number | null
  completed: number | null
  dir: string
  files: FileRef[]
  workItems: RunItem[]
}

export type Snapshot = {
  root: string
  specsDir: string
  statePath: string
  stateMtime: number
  readAt: number
  project: {
    name: string
    description: string | null
    fireVersion: string | null
    workspaceType: string | null
    parts: string[]
  }
  intents: Intent[]
  runs: { active: Run[]; completed: Run[] }
  stats: { intents: Counts; workItems: Counts; runs: { active: number; completed: number } }
  warnings: string[]
}

export type SnapshotAnswer = {
  snapshot: Snapshot | null
  root: string | null
  source: string
  error: string | null
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging
  interface PluginRequests {
    /** Current snapshot; `force` re-resolves the project folder and re-reads it. */
    'specs.snapshot': { input: { force?: boolean }; output: SnapshotAnswer }
    /** Opens a file of the project in an Orca editor tab. */
    'specs.open': { input: { path: string }; output: { opened: boolean } }
    /** Text of a file under .specs-fire (at most 512 KiB), for clients without editor.open. */
    'specs.read': { input: { path: string }; output: { path: string; name: string; text: string; truncated: boolean } }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging
  interface PluginPanelEvents {
    /** The worker saw state.yaml or a run file change. */
    'specs.changed': { readAt: number }
  }
}
