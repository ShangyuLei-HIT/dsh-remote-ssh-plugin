/**
 * Remote-workspace bindings for the ssh-remote plugin.
 *
 * DSH workspaces must name an existing LOCAL directory: `ctx.workspaceRegistry.create`
 * canonicalizes the path with `fs.realpath` and rejects anything else, and the
 * built-in fs/shell tools are host-global. So a remote workspace is realized the
 * same way dsh-remote does it: a local mirror directory becomes the workspace,
 * and this module records the mapping (mirror path -> machine + remote path).
 * A session whose cwd lives under a mirror is a "remote session": the plugin's
 * tools resolve their default machine and directory from the binding, and the
 * prompt tells the model that the local tools only see an empty mirror.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Absolute root that holds every mirror directory. */
export function mirrorRoot(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(dshHome, 'ssh-remote', 'workspaces')
}

/** One path segment that keeps a remote directory identifiable and filesystem-safe. */
function segmentFor(remotePath) {
  const trimmed = String(remotePath).replace(/^\/+|\/+$/g, '')
  if (trimmed === '') return '_root_'
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

/** Local mirror directory for one machine and remote directory. */
export function mirrorPathFor(machineId, remotePath, dshHome) {
  return join(mirrorRoot(dshHome), String(machineId).replace(/[^A-Za-z0-9._-]+/g, '_'), segmentFor(remotePath))
}

/** Human title of the workspace record. */
export function workspaceTitle(machineId, remotePath) {
  return `SSH · ${machineId} · ${remotePath}`
}

/** Create the mirror directory and mark its binding. */
export function ensureMirrorDirectory(binding) {
  mkdirSync(binding.mirrorPath, { recursive: true })
  const marker = join(binding.mirrorPath, '.dsh-ssh-remote.json')
  try {
    writeFileSync(marker, `${JSON.stringify({ machineId: binding.machineId, remotePath: binding.remotePath }, null, 2)}\n`, 'utf8')
  } catch {
    // A read-only mirror still works as a workspace; the marker is a convenience.
  }
  return binding.mirrorPath
}

/** Validate one binding read back from disk. */
function normalizeBinding(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const machineId = typeof input.machineId === 'string' ? input.machineId.trim() : ''
  const remotePath = typeof input.remotePath === 'string' ? input.remotePath.trim() : ''
  const mirrorPath = typeof input.mirrorPath === 'string' ? input.mirrorPath.trim() : ''
  if (machineId === '' || remotePath === '' || mirrorPath === '' || !remotePath.startsWith('/')) return undefined
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : randomUUID(),
    machineId,
    remotePath: remotePath.length > 1 ? remotePath.replace(/\/+$/, '') : remotePath,
    mirrorPath,
    title: typeof input.title === 'string' && input.title !== '' ? input.title : workspaceTitle(machineId, remotePath),
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
  }
}

/**
 * Persisted mirror-workspace bindings.
 *
 * Stored next to the machine registry (`workspaces.json`) so GUI edits and
 * workspace creation share one small, synchronous, atomically written file.
 */
export class WorkspaceBindingStore {
  #bindings
  #file

  constructor(bindings, file) {
    this.#bindings = bindings
    this.#file = file
  }

  /**
   * Load bindings from disk.
   *
   * @param {string|undefined} file Absolute JSON path; undefined keeps the store in memory.
   * @returns {WorkspaceBindingStore} The loaded store.
   */
  static load(file) {
    const bindings = []
    if (file !== undefined) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(parsed?.bindings)) {
          for (const entry of parsed.bindings) {
            const binding = normalizeBinding(entry)
            if (binding !== undefined && !bindings.some(existing => existing.mirrorPath === binding.mirrorPath)) {
              bindings.push(binding)
            }
          }
        }
      } catch {
        // Missing or malformed state starts empty.
      }
    }
    return new WorkspaceBindingStore(bindings, file)
  }

  /** Every binding, newest last. */
  list() {
    return this.#bindings.map(binding => ({ ...binding }))
  }

  /** One binding by mirror path or id. */
  find(value) {
    const needle = typeof value === 'string' ? value.trim() : ''
    if (needle === '') return undefined
    const binding = this.#bindings.find(entry => entry.mirrorPath === needle || entry.id === needle)
    return binding === undefined ? undefined : { ...binding }
  }

  /**
   * Find the binding whose mirror contains a local session cwd.
   *
   * @param {unknown} cwd Session working directory.
   * @returns {object|undefined} The owning binding.
   */
  forCwd(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    let best
    for (const binding of this.#bindings) {
      const rel = relative(binding.mirrorPath, cwd)
      if (rel === '') return { ...binding }
      if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith(sep)) continue
      if (best === undefined || binding.mirrorPath.length > best.mirrorPath.length) best = binding
    }
    return best === undefined ? undefined : { ...best }
  }

  /** Insert or replace the binding for one machine + remote directory. */
  upsert(binding) {
    const candidate = normalizeBinding(binding)
    if (candidate === undefined) throw new Error('invalid workspace binding')
    const index = this.#bindings.findIndex(entry => entry.machineId === candidate.machineId && entry.remotePath === candidate.remotePath)
    if (index >= 0) {
      this.#bindings[index] = { ...this.#bindings[index], ...candidate, id: this.#bindings[index].id, createdAt: this.#bindings[index].createdAt }
    } else {
      this.#bindings.push(candidate)
    }
    this.save()
    return this.find(candidate.mirrorPath)
  }

  /** Record the DSH workspace id assigned by the registry. */
  setWorkspaceId(mirrorPath, workspaceId) {
    const binding = this.#bindings.find(entry => entry.mirrorPath === mirrorPath)
    if (binding === undefined) return undefined
    binding.workspaceId = workspaceId
    this.save()
    return { ...binding }
  }

  /** Remove one binding by id or mirror path. */
  remove(value) {
    const needle = typeof value === 'string' ? value.trim() : ''
    const index = this.#bindings.findIndex(entry => entry.id === needle || entry.mirrorPath === needle)
    if (index === -1) throw new Error(`unknown workspace binding "${needle}"`)
    const [removed] = this.#bindings.splice(index, 1)
    this.save()
    return removed
  }

  /** Drop bindings whose mirror directory vanished. */
  prune() {
    const before = this.#bindings.length
    this.#bindings = this.#bindings.filter(binding => existsSync(binding.mirrorPath))
    if (this.#bindings.length !== before) this.save()
  }

  /** Persist bindings atomically. */
  save() {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, bindings: this.#bindings }, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.#file)
  }
}
