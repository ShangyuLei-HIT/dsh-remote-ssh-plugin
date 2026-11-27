/**
 * Machine registry for the ssh-remote plugin.
 *
 * The GUI stores machines in a plugin-owned JSON file under `$DSH_HOME/ssh-remote`
 * (default `~/.dsh/ssh-remote/machines.json`), seeded from the row configuration
 * on first use. The file is authoritative afterwards, so the settings page can
 * add, edit and remove machines without touching the profile patch or restarting
 * the app. Reads and writes are synchronous: the file is tiny and mutations are
 * serialized by the HTTP handler.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Machine id that always resolves to the primary machine. */
export const PRIMARY_ALIAS = 'default'

/** A persisted or submitted machine definition is not usable. */
export class MachineError extends Error {
  /** Stable machine-readable code, such as `invalid-machine` or `machine-in-use`. */
  code

  constructor(message, code) {
    super(message)
    this.name = 'MachineError'
    this.code = code
  }
}

/** Normalize an absolute remote directory; `''` means the login directory. */
export function normalizeWorkspace(value, field = 'workspace') {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') throw new MachineError(`${field} must be a string`, 'invalid-machine')
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (!trimmed.startsWith('/')) throw new MachineError(`${field} must be an absolute remote directory`, 'invalid-machine')
  const withoutTrailing = trimmed.replace(/\/+$/, '')
  return withoutTrailing === '' ? '' : withoutTrailing
}

/**
 * Validate one submitted machine.
 *
 * @param {unknown} input The GUI payload: `{ id?, host, workspace? }`.
 * @returns {{id: string, host: string, workspace: string}} The normalized machine.
 * @throws {MachineError} When the payload cannot name a usable destination.
 */
export function normalizeMachine(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MachineError('machine must be an object with host, and optional id and workspace', 'invalid-machine')
  }
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (host === '') throw new MachineError('host must be a non-empty OpenSSH destination', 'invalid-machine')
  const rawId = typeof input.id === 'string' ? input.id.trim() : ''
  const id = rawId === '' ? host : rawId
  if (id === PRIMARY_ALIAS) throw new MachineError(`machine id must not be "${PRIMARY_ALIAS}"`, 'invalid-machine')
  if (/[\u0000-\u001f\u007f]/.test(id)) throw new MachineError('machine id must not contain control characters', 'invalid-machine')
  return { id, host, workspace: normalizeWorkspace(input.workspace) }
}

/** Validate a machine list read back from disk. */
function validateStoredMachines(value) {
  if (!Array.isArray(value)) return []
  const machines = []
  const ids = new Set()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const host = typeof entry.host === 'string' ? entry.host.trim() : ''
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (host === '' || id === '' || ids.has(id)) continue
    ids.add(id)
    let workspace = ''
    try {
      workspace = normalizeWorkspace(entry.workspace)
    } catch {
      workspace = ''
    }
    machines.push({ id, host, workspace })
  }
  return machines
}

/**
 * One machine registry with an optional persistence file.
 *
 * `load()` seeds from the row configuration only when the file is missing or
 * unreadable, so GUI edits survive restarts and later configuration changes do
 * not silently overwrite what the operator chose in the panel.
 */
export class MachineStore {
  /** @type {Array<{id: string, host: string, workspace: string}>} */
  #machines
  /** @type {string|undefined} */
  #file

  constructor(machines, file) {
    this.#machines = machines.map(machine => ({ ...machine }))
    this.#file = file
  }

  /**
   * Read the registry from disk, or build it from the configured machines.
   *
   * @param {object} options
   * @param {Array<{id: string, host: string, workspace: string}>} options.seed Machines derived from the row configuration.
   * @param {string|undefined} options.file Absolute state file path; undefined keeps the registry read-only.
   * @returns {MachineStore} The loaded registry.
   */
  static load({ seed, file }) {
    if (file !== undefined) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        const stored = validateStoredMachines(parsed?.machines)
        if (stored.length > 0) return new MachineStore(stored, file)
      } catch {
        // A missing, unreadable or malformed file falls back to the configured seed.
      }
    }
    const normalized = seed.map(machine => ({
      id: machine.id,
      host: machine.host,
      workspace: normalizeWorkspace(machine.workspace),
    }))
    return new MachineStore(normalized, file)
  }

  /** Every machine, primary first. */
  list() {
    return this.#machines.map(machine => ({ ...machine }))
  }

  /** The machine every call targets unless it names another one. */
  primary() {
    return { ...this.#machines[0] }
  }

  /** The state file path, when the registry persists. */
  get file() {
    return this.#file
  }

  /**
   * Resolve a tool's `host` argument to one machine.
   *
   * @param {unknown} input Machine id, OpenSSH destination, `default`, or absent.
   * @returns {{id: string, host: string, workspace: string}} The selected machine.
   * @throws {MachineError} `unknown-machine` naming the configured machines.
   */
  resolve(input) {
    if (input === undefined || input === null || input === '') return this.primary()
    const value = String(input).trim()
    if (value === PRIMARY_ALIAS) return this.primary()
    const byId = this.#machines.find(machine => machine.id === value)
    if (byId !== undefined) return { ...byId }
    const byHost = this.#machines.find(machine => machine.host === value)
    if (byHost !== undefined) return { ...byHost }
    throw new MachineError(`Unknown machine "${value}". Configured machines: ${this.#machines.map(machine => machine.id).join(', ')}.`, 'unknown-machine')
  }

  /**
   * Insert or update one machine and persist the registry.
   *
   * @param {unknown} input The submitted machine.
   * @returns {Array<{id: string, host: string, workspace: string}>} The updated machine list.
   */
  upsert(input) {
    const machine = normalizeMachine(input)
    const index = this.#machines.findIndex(entry => entry.id === machine.id)
    if (index >= 0) this.#machines[index] = machine
    else this.#machines.push(machine)
    this.save()
    return this.list()
  }

  /**
   * Remove one machine and persist the registry. The last machine is retained.
   *
   * @param {unknown} id Machine id to remove.
   * @returns {Array<{id: string, host: string, workspace: string}>} The updated machine list.
   */
  remove(id) {
    const value = typeof id === 'string' ? id.trim() : ''
    if (value === '') throw new MachineError('machine id must not be empty', 'invalid-machine')
    const index = this.#machines.findIndex(machine => machine.id === value)
    if (index === -1) throw new MachineError(`Unknown machine "${value}"`, 'unknown-machine')
    if (this.#machines.length === 1) throw new MachineError('at least one machine must remain', 'machine-in-use')
    this.#machines.splice(index, 1)
    this.save()
    return this.list()
  }

  /** Persist the registry atomically. */
  save() {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, machines: this.#machines }, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.#file)
  }
}
