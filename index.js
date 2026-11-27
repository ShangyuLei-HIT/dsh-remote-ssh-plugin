/**
 * ssh-remote: remote development machines over SSH.
 *
 * Registers `remote_*` tools that run commands, read and edit files, search and
 * transfer files on one or more configured OpenSSH destinations (primary default
 * `server-lsy`), so a Harness session works on remote Linux boxes while its
 * local bash/file tools keep operating on this Mac. One plugin row owns every
 * machine; the optional `host` tool argument selects which configured machine a
 * call targets. No native DSH Remote SSH exists in this installation, so the
 * bundle supplies the missing capability at the tool layer instead of replacing
 * the local workspace picker.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createApiHandler } from './lib/api.js'
import { MachineStore, PRIMARY_ALIAS } from './lib/machines.js'
import { SshClient, SshError } from './lib/ssh.js'
import { WorkspaceBindingStore, ensureMirrorDirectory, mirrorPathFor, workspaceTitle } from './lib/workspaces.js'

/** Cordis plugin name used in Loader diagnostics. */
export const name = 'ssh-remote'

/** The remote tools only need the tool registry. */
export const inject = ['tools']

const DEFAULT_HOST = 'server-lsy'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 60_000
const DEFAULT_MAX_TRANSFER_BYTES = 20_000_000
const DEFAULT_MAX_EDIT_BYTES = 1_500_000
const DEFAULT_READ_LINES = 2_000
const MAX_READ_LINES = 20_000
const DEFAULT_MATCH_RESULTS = 100
const MAX_MATCH_RESULTS = 500
const MAX_EXEC_TIMEOUT_MS = 600_000
/** Pattern a remote glob may contain: word characters, glob punctuation and `/`, never shell metacharacters. */
const GLOB_PATTERN = /^[\w.*?/@{}\[\],+!:-]+$/

/** Normalize one absolute remote directory; `''` means the login directory. */
function normalizeWorkspace(value, field) {
  if (value === '') return ''
  if (!value.startsWith('/')) throw new Error(`ssh-remote: ${field} must be an absolute remote directory`)
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '' : trimmed
}

/**
 * Read the row configuration and fill every default.
 *
 * The primary machine comes from `host`/`workspace`; `hosts` adds more machines
 * as `{ id?, host, workspace? }` entries. Every tool call may select one with its
 * `host` argument, which accepts a machine id, its OpenSSH destination, or
 * `default` for the primary machine.
 *
 * @param {unknown} raw The row `config` value; `undefined` for an unconfigured row.
 * @returns {object} Resolved connection settings, limits and machine list.
 * @throws {Error} When a field is invalid, so the plugin row fails loud at activation.
 */
function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('ssh-remote: config must be an object')
  }
  const config = raw ?? {}
  const string = (key, fallback, allowEmpty = false) => {
    const value = config[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string') throw new Error(`ssh-remote: config.${key} must be a string`)
    const trimmed = value.trim()
    if (!allowEmpty && trimmed === '') throw new Error(`ssh-remote: config.${key} must not be empty`)
    return trimmed
  }
  const positiveInteger = (key, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = config[key]
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`ssh-remote: config.${key} must be an integer from 1 to ${maximum}`)
    }
    return value
  }
  const boolean = (key, fallback) => {
    const value = config[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') throw new Error(`ssh-remote: config.${key} must be a boolean`)
    return value
  }

  const primaryHost = string('host', DEFAULT_HOST)
  const primaryWorkspace = normalizeWorkspace(string('workspace', '', true), 'config.workspace')
  const machines = [{ id: primaryHost, host: primaryHost, workspace: primaryWorkspace, primary: true }]

  const hosts = config.hosts ?? []
  if (!Array.isArray(hosts)) throw new Error('ssh-remote: config.hosts must be an array')
  hosts.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`ssh-remote: config.hosts[${index}] must be an object with host, and optional id and workspace`)
    }
    if (typeof entry.host !== 'string' || entry.host.trim() === '') {
      throw new Error(`ssh-remote: config.hosts[${index}].host must be a non-empty OpenSSH destination`)
    }
    const host = entry.host.trim()
    const id = entry.id === undefined ? host : entry.id
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`ssh-remote: config.hosts[${index}].id must be a non-empty string`)
    }
    const trimmedId = id.trim()
    if (trimmedId === PRIMARY_ALIAS) throw new Error(`ssh-remote: config.hosts[${index}].id must not be "${PRIMARY_ALIAS}"`)
    if (machines.some(machine => machine.id === trimmedId)) {
      throw new Error(`ssh-remote: config.hosts[${index}].id "${trimmedId}" is already used`)
    }
    let workspace = primaryWorkspace
    if (entry.workspace !== undefined) {
      if (typeof entry.workspace !== 'string') {
        throw new Error(`ssh-remote: config.hosts[${index}].workspace must be a string`)
      }
      workspace = normalizeWorkspace(entry.workspace.trim(), `config.hosts[${index}].workspace`)
    }
    machines.push({ id: trimmedId, host, workspace, primary: false })
  })

  const extraArgs = config.extraArgs ?? []
  if (!Array.isArray(extraArgs) || extraArgs.some(entry => typeof entry !== 'string')) {
    throw new Error('ssh-remote: config.extraArgs must be an array of strings')
  }
  return {
    machines,
    primaryId: machines[0].id,
    sshBinary: string('sshBinary', 'ssh'),
    remoteShell: string('remoteShell', 'bash'),
    connectTimeoutSeconds: positiveInteger('connectTimeoutSeconds', 10, 600),
    defaultTimeoutMs: positiveInteger('defaultTimeoutMs', DEFAULT_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS),
    maxOutputChars: positiveInteger('maxOutputChars', DEFAULT_MAX_OUTPUT_CHARS),
    maxTransferBytes: positiveInteger('maxTransferBytes', DEFAULT_MAX_TRANSFER_BYTES),
    maxEditBytes: positiveInteger('maxEditBytes', DEFAULT_MAX_EDIT_BYTES),
    controlPersistSeconds: positiveInteger('controlPersistSeconds', 300, 86_400),
    clearForwardings: boolean('clearForwardings', true),
    extraArgs: [...extraArgs],
  }
}

/**
 * Convert a compact parameter spec into the JSON Schema subset the tool registry accepts.
 *
 * The bundle deliberately imports no DSH package: a linked profile bundle does
 * not resolve `@deepseek-ai/*` from the Desktop installation, so the tools
 * register raw definitions and own their argument validation.
 *
 * @param {Record<string, {type: string, required?: boolean, description?: string, enum?: readonly (string|number|boolean)[]}>} parameters Compact parameter spec.
 * @returns {object} JSON Schema for the tool's parameters.
 */
function parameterSchema(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    const node = { type: spec.type }
    if (spec.description !== undefined) node.description = spec.description
    if (spec.enum !== undefined) node.enum = [...spec.enum]
    properties[key] = node
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false }
}

/** Argument type checks keyed by the supported parameter types. */
const TYPE_CHECK = {
  string: value => typeof value === 'string',
  integer: value => Number.isInteger(value),
  number: value => typeof value === 'number' && Number.isFinite(value),
  boolean: value => typeof value === 'boolean',
  array: Array.isArray,
  object: value => typeof value === 'object' && value !== null && !Array.isArray(value),
}

/** Validate one call's arguments against its compact parameter spec. */
function validateArguments(parameters, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new SshError('Tool arguments must be a JSON object.', 'invalid-arguments')
  }
  const violations = []
  for (const [key, spec] of Object.entries(parameters)) {
    const value = args[key]
    if (value === undefined) {
      if (spec.required === true) violations.push(`missing required argument "${key}"`)
      continue
    }
    const check = TYPE_CHECK[spec.type]
    if (check !== undefined && !check(value)) violations.push(`argument "${key}" must be a ${spec.type}`)
    else if (spec.enum !== undefined && !spec.enum.includes(value)) violations.push(`argument "${key}" must be one of ${spec.enum.join(', ')}`)
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(parameters, key)) violations.push(`unknown argument "${key}"`)
  }
  if (violations.length > 0) throw new SshError(`Invalid arguments: ${violations.join('; ')}.`, 'invalid-arguments')
}

/**
 * Build one raw tool definition: JSON-Schema parameters, canonical output and a
 * pre-validated execute body. Presentation callbacks never throw on stale args.
 *
 * @param {object} options Name, description, compact parameters, output declaration and callbacks.
 * @returns {object} A tool definition accepted by `ctx.tools.register`.
 */
function defineRemoteTool(options) {
  const parameters = options.parameters ?? {}
  const execute = options.execute
  const presentCall = options.presentCall
  const definition = {
    name: options.name,
    description: options.description,
    parameters: parameterSchema(parameters),
    output: options.output,
    execute(args, exec) {
      validateArguments(parameters, args)
      return execute(args, exec)
    },
  }
  if (presentCall !== undefined) {
    definition.presentCall = args => {
      try {
        validateArguments(parameters, args)
        return presentCall(args)
      } catch {
        return undefined
      }
    }
  }
  return definition
}

/** Resolve a tool path argument against a machine's remote workspace. */
function remotePath(input, workspace, field = 'path') {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value === '') throw new SshError(`${field} must be a non-empty remote path.`, 'invalid-path')
  if (value.startsWith('~')) throw new SshError(`${field} must not use ~; pass an absolute path or one relative to the machine workspace.`, 'invalid-path')
  if (isAbsolute(value)) return value
  if (workspace === '') {
    throw new SshError(`${field} "${value}" is relative and the machine has no workspace; pass an absolute remote path.`, 'invalid-path')
  }
  return `${workspace}/${value}`
}

/** Resolve a local path argument against the Harness process directory. */
function localPath(input, field = 'localPath') {
  const value = typeof input === 'string' ? input.trim() : ''
  if (value === '') throw new SshError(`${field} must be a non-empty local path.`, 'invalid-path')
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

/** Model-facing text block for one canonical value. */
function text(value) {
  return [{ type: 'text', text: value }]
}

/** Compose the model-facing text of one remote execution. */
function renderExec(_args, value) {
  const lines = [
    `machine: ${value.machine}`,
    `exit_code: ${value.exitCode}${value.timedOut ? ' (killed after timeout)' : ''}`,
    `duration_ms: ${value.durationMs}`,
    `directory: ${value.cwd === '' ? '(remote login directory)' : value.cwd}`,
  ]
  if (value.stdout !== '') lines.push('stdout:', value.stdout.replace(/\n$/, ''))
  if (value.stderr !== '') lines.push('stderr:', value.stderr.replace(/\n$/, ''))
  if (value.stdout === '' && value.stderr === '') lines.push('(no output)')
  if (value.truncated) lines.push('[output was truncated at the configured character cap]')
  return text(lines.join('\n'))
}

/** Compose the model-facing text of the connection probe. */
function renderStatus(_args, value) {
  const tools = Object.entries(value.toolchain).map(([tool, path]) => `${tool}=${path}`)
  return text([
    `machine: ${value.machine}`,
    `connected: ${value.host}`,
    `remote_identity: ${value.user}@${value.hostname}`,
    `system: ${value.system}`,
    `directory: ${value.cwd}`,
    `latency_ms: ${value.latencyMs}`,
    `toolchain: ${tools.length === 0 ? '(none found)' : tools.join(' ')}`,
    `configured_machines: ${value.machines.join(', ')}`,
  ].join('\n'))
}

/** Output schemas. Object roots declare their complete field set. */
const EXEC_OUTPUT = {
  type: 'object',
  properties: {
    machine: { type: 'string' },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    durationMs: { type: 'integer' },
    cwd: { type: 'string' },
  },
  required: ['machine', 'exitCode', 'stdout', 'stderr', 'truncated', 'timedOut', 'durationMs', 'cwd'],
  additionalProperties: false,
}

const STATUS_OUTPUT = {
  type: 'object',
  properties: {
    machine: { type: 'string' },
    machines: { type: 'array', items: { type: 'string' } },
    host: { type: 'string' },
    user: { type: 'string' },
    hostname: { type: 'string' },
    system: { type: 'string' },
    cwd: { type: 'string' },
    latencyMs: { type: 'integer' },
    toolchain: { type: 'object', additionalProperties: true },
  },
  required: ['machine', 'machines', 'host', 'user', 'hostname', 'system', 'cwd', 'latencyMs', 'toolchain'],
  additionalProperties: false,
}

const READ_OUTPUT = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { type: 'integer' },
    totalLines: { type: 'integer' },
    content: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['path', 'offset', 'totalLines', 'content', 'truncated'],
  additionalProperties: false,
}

const WRITE_OUTPUT = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    bytes: { type: 'integer' },
    created: { type: 'boolean' },
  },
  required: ['path', 'bytes', 'created'],
  additionalProperties: false,
}

const EDIT_OUTPUT = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    replacements: { type: 'integer' },
    bytes: { type: 'integer' },
  },
  required: ['path', 'replacements', 'bytes'],
  additionalProperties: false,
}

const GREP_OUTPUT = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    pattern: { type: 'string' },
    matches: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
  },
  required: ['path', 'pattern', 'matches', 'truncated'],
  additionalProperties: false,
}

const GLOB_OUTPUT = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    pattern: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
  },
  required: ['path', 'pattern', 'files', 'truncated'],
  additionalProperties: false,
}

const TRANSFER_OUTPUT = {
  type: 'object',
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    bytes: { type: 'integer' },
  },
  required: ['from', 'to', 'bytes'],
  additionalProperties: false,
}

/**
 * Register the remote tool suite for every configured SSH machine.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context owning the tool registry.
 * @param {unknown} rawConfig The row configuration from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const primaryId = config.machines[0].id
  // The settings panel owns the registry after the first load; the row
  // configuration only seeds it. `DSH_SSH_REMOTE_STATE` overrides the path for
  // tests; an empty value keeps the registry in memory only.
  const stateOverride = process.env.DSH_SSH_REMOTE_STATE
  const stateFile = stateOverride === undefined
    ? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ssh-remote', 'machines.json')
    : stateOverride === '' ? undefined : stateOverride
  const store = MachineStore.load({ seed: config.machines, file: stateFile })
  const bindingsFile = stateFile === undefined ? undefined : join(dirname(stateFile), 'workspaces.json')
  const bindings = WorkspaceBindingStore.load(bindingsFile)
  // The workspace registry is optional: a headless composition without it still
  // serves tools, only the mirror-workspace creation in Settings degrades.
  let workspaceRegistry
  ctx.inject(['workspaceRegistry'], scope => {
    workspaceRegistry = scope.workspaceRegistry
  })

  /**
   * Create (or reuse) the mirror workspace for one machine directory.
   *
   * DSH workspaces must name an existing local directory, so the mirror is the
   * workspace path and the remote target is recorded in the binding. The title
   * is passed here because the core create API otherwise derives it from the
   * mirror's last path segment.
   */
  const ensureRemoteWorkspace = async (machine, remotePath) => {
    const mirrorPath = mirrorPathFor(machine.id, remotePath)
    let binding = bindings.upsert({
      machineId: machine.id,
      remotePath,
      mirrorPath,
      title: workspaceTitle(machine.id, remotePath),
    })
    ensureMirrorDirectory(binding)
    if (workspaceRegistry !== undefined && typeof workspaceRegistry.create === 'function') {
      try {
        const workspace = await workspaceRegistry.create(mirrorPath, binding.title)
        if (workspace?.id !== undefined) binding = bindings.setWorkspaceId(mirrorPath, String(workspace.id))
      } catch {
        // One record per canonical path: adopt the existing record instead.
        try {
          const existing = (workspaceRegistry.list?.() ?? []).find(entry => entry.path === mirrorPath)
          if (existing?.id !== undefined) binding = bindings.setWorkspaceId(mirrorPath, String(existing.id))
        } catch {
          // Registry unavailable: the binding still routes tools; only the list entry is missing.
        }
      }
    }
    return binding
  }

  /** Remove one binding, and its registry record when the plugin created it. */
  const removeRemoteWorkspace = async value => {
    const binding = bindings.find(value)
    if (binding === undefined) throw new Error(`unknown remote workspace "${String(value)}"`)
    bindings.remove(binding.id)
    if (binding.workspaceId !== undefined && workspaceRegistry !== undefined && typeof workspaceRegistry.remove === 'function') {
      try { await workspaceRegistry.remove(binding.workspaceId) } catch { /* record already gone */ }
    }
    return binding
  }

  /** The remote-workspace binding owning a session's cwd, if any. */
  const sessionBinding = exec => {
    try {
      const cwd = exec?.agent?.session?.header?.cwd
      return bindings.forCwd(cwd)
    } catch {
      return undefined
    }
  }

  const hostParameter = {
    type: 'string',
    description: `Configured machine id, its OpenSSH destination, or "default"; omitted uses the primary machine (${primaryId}). Call remote_status to list the machines currently configured in Settings.`,
  }

  /** One transport per (machine, destination, workspace) triple, closed when the plugin unloads. */
  const clients = new Map()
  const clientFor = machine => {
    const key = `${machine.id}\u0000${machine.host}\u0000${machine.workspace}`
    let client = clients.get(key)
    if (client === undefined) {
      client = new SshClient({
        host: machine.host,
        sshBinary: config.sshBinary,
        remoteShell: config.remoteShell,
        workspace: machine.workspace,
        connectTimeoutSeconds: config.connectTimeoutSeconds,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxOutputChars: config.maxOutputChars,
        controlPersistSeconds: config.controlPersistSeconds,
        clearForwardings: config.clearForwardings,
        extraArgs: config.extraArgs,
      })
      clients.set(key, client)
    }
    return client
  }

  /** Close every cached transport belonging to one machine id. */
  const disposeMachines = id => {
    const prefix = `${id}\u0000`
    for (const [key, client] of clients) {
      if (!key.startsWith(prefix)) continue
      client.dispose()
      clients.delete(key)
    }
  }

  /**
   * Resolve the `host` tool argument to one configured machine.
   *
   * Inside a remote workspace session the machine's directory is replaced by the
   * binding's remote path, so every tool call that omits `host` and every
   * relative path lands in the workspace the session was opened for.
   */
  const machineFor = (input, exec) => {
    const binding = sessionBinding(exec)
    const explicit = input !== undefined && input !== null && input !== ''
    const machine = store.resolve(input)
    if (binding === undefined) return machine
    if (explicit !== true) {
      // A session opened in a remote workspace targets the machine that
      // workspace is bound to, not whichever machine is primary.
      const bound = store.list().find(entry => entry.id === binding.machineId) ?? machine
      return { ...bound, workspace: binding.remotePath, remoteWorkspace: binding }
    }
    if (binding.machineId === machine.id) return { ...machine, workspace: binding.remotePath, remoteWorkspace: binding }
    return machine
  }

  /** The directory a tool call starts in for one machine, or `''` for the login directory. */
  const startDirectory = (machine, cwd) => (cwd === undefined || cwd === null || cwd === '' ? machine.workspace : remotePath(cwd, machine.workspace, 'cwd'))

  /** Base64 written through stdin so no argument list ever carries file content. */
  const writeScript = (path, createDirs) => `f=${quote(path)}
d=$(dirname -- "$f") || exit 96
${createDirs ? 'mkdir -p -- "$d" || exit 97' : '[ -d "$d" ] || { printf \'dsh-ssh-remote: parent directory is missing\\n\' >&2; exit 97; }'}
if [ -e "$f" ]; then created=no; else created=yes; fi
if base64 --help >/dev/null 2>&1; then base64 -d > "$f" || exit 98; else base64 -D > "$f" || exit 98; fi
printf '%s %s\\n' "$created" "$(wc -c < "$f")"`

  ctx.effect(() => () => {
    for (const client of clients.values()) client.dispose()
    clients.clear()
  })

  ctx.tools.register(defineRemoteTool({
    name: 'remote_status',
    description: `Check an SSH connection and report the machine's user, host, OS, default directory, latency and installed toolchain (node, npm, git, python3). Without host it checks the primary machine (${primaryId}) and lists every configured machine.`,
    parameters: {
      host: hostParameter,
    },
    output: { schema: STATUS_OUTPUT, render: renderStatus },
    execute(args, exec) {
      const machine = machineFor(args.host, exec)
      return clientFor(machine).probe({ timeoutMs: Math.min(config.defaultTimeoutMs, 30_000), signal: exec.signal, cwd: machine.workspace })
        .then(status => ({
          machine: machine.id,
          machines: store.list().map(entry => entry.id),
          ...status,
        }))
    },
    presentCall: args => ({ card: 'generic', title: `Check SSH connection to ${safeMachineLabel(args, store, primaryId)}`, kind: 'read' }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_exec',
    description: `Run a shell command on a configured remote machine and return its exit code, stdout and stderr. Without host it targets the primary machine (${primaryId}); pass host to use another configured machine. Every call is a fresh non-interactive login shell, so cd, exported variables and background jobs do not persist between calls. There is no TTY, so interactive programs hang until the timeout; set a short timeoutMs for work that may stall. Use remote_read for file contents and remote_grep/remote_glob for discovery.`,
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command for bash on the remote machine.' },
      cwd: { type: 'string', description: 'Remote directory to run in; a relative path resolves against the machine workspace. Omitted uses the machine workspace.' },
      timeoutMs: { type: 'integer', description: `Kill the call after this many milliseconds; defaults to the plugin timeout (${DEFAULT_TIMEOUT_MS}), maximum ${MAX_EXEC_TIMEOUT_MS}.` },
      host: hostParameter,
    },
    output: { schema: EXEC_OUTPUT, render: renderExec },
    execute(args, exec) {
      if (args.timeoutMs !== undefined && (args.timeoutMs < 1 || args.timeoutMs > MAX_EXEC_TIMEOUT_MS)) {
        throw new SshError(`timeoutMs must be between 1 and ${MAX_EXEC_TIMEOUT_MS}.`, 'invalid-timeout')
      }
      const machine = machineFor(args.host, exec)
      const cwd = startDirectory(machine, args.cwd)
      const timeoutMs = args.timeoutMs ?? config.defaultTimeoutMs
      return clientFor(machine).run(args.command, { cwd: cwd || undefined, timeoutMs, signal: exec.signal, maxOutputBytes: config.maxOutputChars })
        .then(result => ({
          machine: machine.id,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          cwd,
        }))
    },
    presentCall: args => ({ card: 'terminal', title: args.command, cwd: args.cwd ?? (machineFor(args.host, exec).workspace || undefined) }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_read',
    description: 'Read lines from a text file on a remote machine. Returns the requested window and the file\'s total line count; content is truncated at the configured character cap.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path; a relative path resolves against the machine workspace.' },
      offset: { type: 'integer', description: 'First line to return, 1-based; defaults to 1.' },
      limit: { type: 'integer', description: `Maximum lines to return; defaults to ${DEFAULT_READ_LINES}, maximum ${MAX_READ_LINES}.` },
      host: hostParameter,
    },
    output: { schema: READ_OUTPUT, render: (_args, value) => {
      const lines = value.content === '' ? '' : `\n${value.content.replace(/\n$/, '')}`
      const header = `${value.path} (from line ${value.offset}, ${value.totalLines} lines total)${value.truncated ? ', truncated' : ''}`
      return text(`${header}${lines}`)
    } },
    execute(args, exec) {
      const machine = machineFor(args.host, exec)
      const path = remotePath(args.path, machine.workspace)
      const offset = args.offset ?? 1
      const limit = args.limit ?? DEFAULT_READ_LINES
      if (offset < 1 || limit < 1 || limit > MAX_READ_LINES) {
        throw new SshError(`offset must be at least 1 and limit from 1 to ${MAX_READ_LINES}.`, 'invalid-window')
      }
      const end = offset + limit - 1
      const script = `f=${quote(path)}
if [ ! -e "$f" ]; then printf 'dsh-ssh-remote: not found: %s\\n' "$f" >&2; exit 3; fi
if [ -d "$f" ]; then printf 'dsh-ssh-remote: is a directory: %s\\n' "$f" >&2; exit 4; fi
awk 'END { print NR+0 }' "$f"
sed -n '${offset},${end}p' "$f"`
      return clientFor(machine).run(script, { timeoutMs: config.defaultTimeoutMs, signal: exec.signal, maxOutputBytes: config.maxOutputChars })
        .then(result => {
          if (result.exitCode === 3) throw new SshError(`Remote file not found on ${machine.id}: ${path}`, 'remote-not-found')
          if (result.exitCode === 4) throw new SshError(`Remote path is a directory on ${machine.id}: ${path}`, 'remote-is-directory')
          if (result.exitCode !== 0) throw new SshError(`Cannot read ${path} on ${machine.id}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`, 'remote-read-failed')
          const newline = result.stdout.indexOf('\n')
          const totalLines = Number.parseInt(newline === -1 ? result.stdout : result.stdout.slice(0, newline), 10)
          const content = newline === -1 ? '' : result.stdout.slice(newline + 1)
          return {
            path,
            offset,
            totalLines: Number.isFinite(totalLines) ? totalLines : 0,
            content,
            truncated: result.truncated || end < (Number.isFinite(totalLines) ? totalLines : 0),
          }
        })
    },
    presentCall: args => ({ card: 'generic', title: `Read ${args.path} on ${safeMachineLabel(args, store, primaryId)}`, kind: 'read', locations: [{ path: args.path }] }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_write',
    description: 'Create or overwrite a file on a remote machine with the given UTF-8 content, optionally creating parent directories. Prefer remote_edit for a small change to an existing file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path; a relative path resolves against the machine workspace.' },
      content: { type: 'string', required: true, description: 'Complete new file content. Replaces whatever the file held.' },
      createDirs: { type: 'boolean', description: 'Create missing parent directories; defaults to true.' },
      host: hostParameter,
    },
    output: { schema: WRITE_OUTPUT, render: (_args, value) => text(`${value.created ? 'created' : 'overwrote'} ${value.path} (${value.bytes} bytes)`) },
    execute(args, exec) {
      const machine = machineFor(args.host, exec)
      const path = remotePath(args.path, machine.workspace)
      const bytes = Buffer.byteLength(args.content, 'utf8')
      if (bytes > config.maxTransferBytes) throw new SshError(`Content is ${bytes} bytes, above the ${config.maxTransferBytes}-byte limit.`, 'content-too-large')
      const createDirs = args.createDirs ?? true
      return clientFor(machine).run(writeScript(path, createDirs), {
        timeoutMs: config.defaultTimeoutMs,
        signal: exec.signal,
        stdin: Buffer.from(args.content, 'utf8').toString('base64'),
        maxOutputBytes: 4_096,
      }).then(result => {
        if (result.exitCode !== 0) throw new SshError(`Cannot write ${path} on ${machine.id}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`, 'remote-write-failed')
        const [created = 'no', written = '0'] = result.stdout.trim().split(/\s+/)
        return { path, bytes: Number.parseInt(written, 10) || bytes, created: created === 'yes' }
      })
    },
    presentCall: args => ({ card: 'diff', title: `Write ${args.path} on ${safeMachineLabel(args, store, primaryId)}`, diffs: [{ path: args.path, oldText: null, newText: args.content }], locations: [{ path: args.path }] }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_edit',
    description: 'Replace exact text in a file on a remote machine. The old text must appear exactly once unless replaceAll is true; failures leave the file unchanged.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path; a relative path resolves against the machine workspace.' },
      oldText: { type: 'string', required: true, description: 'Exact text to replace.' },
      newText: { type: 'string', required: true, description: 'Replacement text; an empty string deletes the match.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence; defaults to false.' },
      host: hostParameter,
    },
    output: { schema: EDIT_OUTPUT, render: (_args, value) => text(`replaced ${value.replacements} occurrence${value.replacements === 1 ? '' : 's'} in ${value.path} (${value.bytes} bytes)`) },
    execute(args, exec) {
      const machine = machineFor(args.host, exec)
      const path = remotePath(args.path, machine.workspace)
      const replaceAll = args.replaceAll ?? false
      if (args.oldText === '') throw new SshError('oldText must not be empty.', 'invalid-edit')
      if (args.oldText === args.newText) throw new SshError('oldText and newText are identical.', 'invalid-edit')
      return clientFor(machine).runRaw(`cat -- ${quote(path)}`, { timeoutMs: config.defaultTimeoutMs, signal: exec.signal, maxOutputBytes: config.maxEditBytes })
        .then(result => {
          if (result.exitCode !== 0) throw new SshError(`Cannot read ${path} on ${machine.id}: ${result.stderr.toString('utf8').trim() || `exit code ${result.exitCode}`}`, 'remote-read-failed')
          if (result.truncated) throw new SshError(`Remote file ${path} is larger than the ${config.maxEditBytes}-byte edit limit; use remote_exec with a script or remote_download.`, 'file-too-large')
          const original = result.stdout.toString('utf8')
          const occurrences = original.split(args.oldText).length - 1
          if (occurrences === 0) throw new SshError(`oldText was not found in ${path}; read the file first and copy the exact text.`, 'no-match')
          if (occurrences > 1 && !replaceAll) {
            throw new SshError(`oldText appears ${occurrences} times in ${path}; pass replaceAll: true or include more surrounding text.`, 'ambiguous-match')
          }
          const updated = replaceAll ? original.split(args.oldText).join(args.newText) : original.replace(args.oldText, () => args.newText)
          return clientFor(machine).run(writeScript(path, false), {
            timeoutMs: config.defaultTimeoutMs,
            signal: exec.signal,
            stdin: Buffer.from(updated, 'utf8').toString('base64'),
            maxOutputBytes: 4_096,
          }).then(writeResult => {
            if (writeResult.exitCode !== 0) throw new SshError(`Cannot write ${path} on ${machine.id}: ${writeResult.stderr.trim() || `exit code ${writeResult.exitCode}`}`, 'remote-write-failed')
            const written = writeResult.stdout.trim().split(/\s+/)[1]
            return { path, replacements: replaceAll ? occurrences : 1, bytes: Number.parseInt(written, 10) || Buffer.byteLength(updated, 'utf8') }
          })
        })
    },
    presentCall: args => ({ card: 'diff', title: `Edit ${args.path} on ${safeMachineLabel(args, store, primaryId)}`, diffs: [{ path: args.path, oldText: args.oldText, newText: args.newText }], locations: [{ path: args.path }] }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_grep',
    description: 'Search file contents on a remote machine with grep (POSIX extended regular expressions). Skips binary files and the .git and node_modules directories.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Extended regular expression to search for.' },
      path: { type: 'string', description: 'Remote directory or file to search; defaults to the machine workspace.' },
      include: { type: 'string', description: 'Only search files whose name matches this glob, such as *.ts.' },
      maxResults: { type: 'integer', description: `Maximum matching lines to return; defaults to ${DEFAULT_MATCH_RESULTS}, maximum ${MAX_MATCH_RESULTS}.` },
      host: hostParameter,
    },
    output: { schema: GREP_OUTPUT, render: (_args, value) => {
      const header = `${value.matches.length} match${value.matches.length === 1 ? '' : 'es'} for /${value.pattern}/ under ${value.path}${value.truncated ? ' (truncated)' : ''}`
      return text(value.matches.length === 0 ? header : `${header}\n${value.matches.join('\n')}`)
    } },
    execute(args, exec) {
      if (args.pattern === '') throw new SshError('pattern must not be empty.', 'invalid-pattern')
      const machine = machineFor(args.host, exec)
      const searchPath = args.path === undefined ? (machine.workspace || '.') : remotePath(args.path, machine.workspace)
      const maxResults = args.maxResults ?? DEFAULT_MATCH_RESULTS
      if (maxResults < 1 || maxResults > MAX_MATCH_RESULTS) throw new SshError(`maxResults must be from 1 to ${MAX_MATCH_RESULTS}.`, 'invalid-limit')
      const include = args.include === undefined || args.include === '' ? '' : `--include=${quote(args.include)} `
      const script = `[ -e ${quote(searchPath)} ] || { printf 'dsh-ssh-remote: not found\\n' >&2; exit 3; }
grep -rIn -E --exclude-dir=.git --exclude-dir=node_modules ${include}-- ${quote(args.pattern)} ${quote(searchPath)} | head -n ${maxResults + 1}`
      return clientFor(machine).run(script, { timeoutMs: config.defaultTimeoutMs, signal: exec.signal, maxOutputBytes: config.maxOutputChars })
        .then(result => {
          if (result.exitCode === 3) throw new SshError(`Remote path not found on ${machine.id}: ${searchPath}`, 'remote-not-found')
          if (result.exitCode !== 0 && result.stderr.trim() !== '') {
            throw new SshError(`Remote grep failed on ${machine.id}: ${result.stderr.trim()}`, 'remote-command-failed')
          }
          const lines = result.stdout.split('\n').filter(line => line !== '')
          const truncated = lines.length > maxResults || result.truncated
          return { path: searchPath, pattern: args.pattern, matches: lines.slice(0, maxResults), truncated }
        })
    },
    presentCall: args => ({ card: 'generic', title: `Search ${args.pattern} on ${safeMachineLabel(args, store, primaryId)}`, kind: 'search' }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_glob',
    description: 'List files on a remote machine by glob pattern, such as **/*.ts or src/*.js. Bash globstar is enabled; directories are omitted and the .git and node_modules directories are not pruned.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob relative to path. ** recurses when globstar is available.' },
      path: { type: 'string', description: 'Remote root directory; defaults to the machine workspace.' },
      maxResults: { type: 'integer', description: `Maximum paths to return; defaults to ${DEFAULT_MATCH_RESULTS}, maximum ${MAX_MATCH_RESULTS}.` },
      host: hostParameter,
    },
    output: { schema: GLOB_OUTPUT, render: (_args, value) => {
      const header = `${value.files.length} file${value.files.length === 1 ? '' : 's'} for ${value.pattern} under ${value.path}${value.truncated ? ' (truncated)' : ''}`
      return text(value.files.length === 0 ? header : `${header}\n${value.files.join('\n')}`)
    } },
    execute(args, exec) {
      const machine = machineFor(args.host, exec)
      const root = args.path === undefined ? (machine.workspace || '.') : remotePath(args.path, machine.workspace)
      const maxResults = args.maxResults ?? DEFAULT_MATCH_RESULTS
      if (maxResults < 1 || maxResults > MAX_MATCH_RESULTS) throw new SshError(`maxResults must be from 1 to ${MAX_MATCH_RESULTS}.`, 'invalid-limit')
      const pattern = args.pattern.trim()
      if (!GLOB_PATTERN.test(pattern) || pattern.includes('..')) {
        throw new SshError('pattern may contain only letters, digits, _ . * ? / @ { } [ ] , + ! : - and must not contain ..; use remote_exec with find for anything else.', 'invalid-pattern')
      }
      const script = `cd -- ${quote(root)} 2>/dev/null || { printf 'dsh-ssh-remote: directory not found\\n' >&2; exit 3; }
shopt -s globstar nullglob 2>/dev/null || true
n=0
for f in ${pattern}; do
  [ -f "$f" ] || continue
  n=$((n+1))
  if [ "$n" -gt ${maxResults} ]; then printf 'dsh-ssh-remote: truncated\\n' >&2; break; fi
  printf '%s\\n' "$f"
done`
      return clientFor(machine).run(script, { timeoutMs: config.defaultTimeoutMs, signal: exec.signal, maxOutputBytes: config.maxOutputChars })
        .then(result => {
          if (result.exitCode === 3) throw new SshError(`Remote directory not found on ${machine.id}: ${root}`, 'remote-not-found')
          const files = result.stdout.split('\n').filter(line => line !== '').map(file => (root === '/' ? `/${file}` : root === '.' ? file : `${root.replace(/\/+$/, '')}/${file}`))
          return { path: root, pattern, files: files.slice(0, maxResults), truncated: files.length > maxResults }
        })
    },
    presentCall: args => ({ card: 'generic', title: `List ${args.pattern} on ${safeMachineLabel(args, store, primaryId)}`, kind: 'search' }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_upload',
    description: 'Copy a local file to a remote machine over SSH, creating parent directories on the remote side. Use it for artifacts the remote work needs; source files should usually be edited in place with remote_write or remote_edit.',
    parameters: {
      localPath: { type: 'string', required: true, description: 'Local file to send; a relative path resolves against the Harness process directory.' },
      remotePath: { type: 'string', required: true, description: 'Destination file path on the remote machine.' },
      host: hostParameter,
    },
    output: { schema: TRANSFER_OUTPUT, render: (_args, value) => text(`uploaded ${value.from} to ${value.to} on ${safeMachineLabel(_args, store, primaryId)} (${value.bytes} bytes)`) },
    async execute(args, exec) {
      const machine = machineFor(args.host, exec)
      const source = localPath(args.localPath)
      const destination = remotePath(args.remotePath, machine.workspace, 'remotePath')
      const content = await readFile(source).catch(error => {
        throw new SshError(`Cannot read local file ${source}: ${error.message}`, 'local-read-failed')
      })
      if (content.length > config.maxTransferBytes) throw new SshError(`Local file is ${content.length} bytes, above the ${config.maxTransferBytes}-byte transfer limit.`, 'file-too-large')
      const result = await clientFor(machine).run(writeScript(destination, true), {
        timeoutMs: config.defaultTimeoutMs,
        signal: exec.signal,
        stdin: content.toString('base64'),
        maxOutputBytes: 4_096,
      })
      if (result.exitCode !== 0) throw new SshError(`Cannot upload to ${destination} on ${machine.id}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`, 'remote-write-failed')
      const written = Number.parseInt(result.stdout.trim().split(/\s+/)[1], 10)
      return { from: source, to: destination, bytes: Number.isFinite(written) ? written : content.length }
    },
    presentCall: args => ({ card: 'generic', title: `Upload ${args.localPath} to ${safeMachineLabel(args, store, primaryId)}`, kind: 'other', locations: [{ path: args.remotePath }] }),
  }))

  ctx.tools.register(defineRemoteTool({
    name: 'remote_download',
    description: 'Copy a file from a remote machine to this Mac over SSH, creating local parent directories.',
    parameters: {
      remotePath: { type: 'string', required: true, description: 'File to read on the remote machine.' },
      localPath: { type: 'string', required: true, description: 'Destination on this Mac; a relative path resolves against the Harness process directory.' },
      host: hostParameter,
    },
    output: { schema: TRANSFER_OUTPUT, render: (_args, value) => text(`downloaded ${value.from} to ${value.to} (${value.bytes} bytes)`) },
    async execute(args, exec) {
      const machine = machineFor(args.host, exec)
      const source = remotePath(args.remotePath, machine.workspace, 'remotePath')
      const destination = localPath(args.localPath)
      const result = await clientFor(machine).runRaw(`if [ -d ${quote(source)} ]; then printf 'dsh-ssh-remote: is a directory\\n' >&2; exit 4; fi
cat -- ${quote(source)}`, { timeoutMs: config.defaultTimeoutMs, signal: exec.signal, maxOutputBytes: config.maxTransferBytes })
      if (result.exitCode === 4) throw new SshError(`Remote path is a directory on ${machine.id}: ${source}`, 'remote-is-directory')
      if (result.exitCode !== 0) throw new SshError(`Cannot read remote file ${source} on ${machine.id}: ${result.stderr.toString('utf8').trim() || `exit code ${result.exitCode}`}`, 'remote-read-failed')
      if (result.truncated) throw new SshError(`Remote file ${source} is larger than the ${config.maxTransferBytes}-byte transfer limit.`, 'file-too-large')
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, result.stdout)
      return { from: source, to: destination, bytes: result.stdout.length }
    },
    presentCall: args => ({ card: 'generic', title: `Download ${args.remotePath} from ${safeMachineLabel(args, store, primaryId)}`, kind: 'other', locations: [{ path: args.localPath }] }),
  }))

  const apiHandler = createApiHandler({
    store,
    clientFor,
    disposeMachines,
    bindings,
    ensureRemoteWorkspace,
    removeRemoteWorkspace,
  })
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/api/ssh-remote',
      handler: apiHandler,
    }), 'ssh-remote: settings API')
  })

  const baseGuidance = [
    `Remote development machines are reachable over SSH through the remote_* tools`,
    `(remote_status, remote_exec, remote_read, remote_write, remote_edit, remote_grep, remote_glob, remote_upload, remote_download).`,
    `Every tool takes an optional host argument (a machine id or OpenSSH destination); without it the tool targets the primary machine ${primaryId}, or the machine this session's remote workspace is bound to.`,
    'The operator manages machines and their remote workspaces in Settings → SSH remote development; remote_status lists what is configured now.',
    'A machine workspace is the default remote directory for that machine; other paths are absolute POSIX paths.',
    'The session workspace picker stays local; a session opened in an "SSH · …" workspace is bound to that remote directory.',
  ].join(' ')

  ctx.inject(['systemPrompt'], scope => {
    // This provider is evaluated during every request's prompt assembly, so it
    // must never throw: a throw there fails the whole turn (0.2.2-rc.5 surfaced
    // `Cannot read properties of undefined (reading 'get')` from a provider that
    // assumed the wrong callback shape). Everything session-specific is guarded
    // and falls back to the static guidance.
    scope.systemPrompt.section({
      name: 'tool:ssh-remote',
      order: 1650,
      interpolate: false,
      text: context => {
        try {
          const cwd = context?.agent?.session?.header?.cwd
          const binding = bindings.forCwd(cwd)
          if (binding === undefined) return baseGuidance
          const machine = store.list().find(entry => entry.id === binding.machineId)
          const host = machine === undefined ? binding.machineId : machine.host
          return [
            baseGuidance,
            '',
            '## Remote workspace',
            `This session's workspace is REMOTE: machine "${binding.machineId}" (${host}), directory ${binding.remotePath}.`,
            `Its local directory ${binding.mirrorPath} is only an empty mirror placeholder; the built-in bash, read, write, edit, glob and grep tools do not reach the remote files and are hidden in this session.`,
            'Use remote_exec / remote_read / remote_write / remote_edit / remote_grep / remote_glob / remote_upload / remote_download instead; relative paths resolve against the remote directory above.',
            'Never report a file as saved or a command as run remotely unless the matching remote_* tool succeeded.',
          ].join('\n')
        } catch {
          return baseGuidance
        }
      },
    })
  })

  // ── remote sessions hide the local file/shell tools ─────────────────────
  // A session whose cwd is inside a mirror would otherwise inspect an empty
  // local directory while the real project lives on the remote host. The scoped
  // restriction reaches native schemas, PTC bindings and dispatch alike.
  const LOCAL_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'glob', 'grep']
  const restrictions = new Map()
  const disposeRestriction = agent => {
    const dispose = restrictions.get(agent)
    if (dispose === undefined) return
    restrictions.delete(agent)
    try { dispose() } catch { /* agent already disposed */ }
  }
  const installRestriction = agent => {
    try {
      if (restrictions.has(agent)) return
      const cwd = agent?.session?.header?.cwd
      if (bindings.forCwd(cwd) === undefined || cwd === undefined) return
      const agentCtx = agent.ctx
      const agentTools = agentCtx && (typeof agentCtx.get === 'function' ? agentCtx.get('tools') : agentCtx.tools)
      if (agentTools === undefined || agentTools === null || typeof agentTools.restrict !== 'function') return
      const dispose = agentTools.restrict({ deny: LOCAL_TOOL_NAMES })
      if (typeof dispose === 'function') restrictions.set(agent, dispose)
    } catch {
      // Visibility is best-effort: the prompt still tells the model which tools reach the remote files.
    }
  }
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents !== undefined && typeof agents.list === 'function') {
      for (const agent of agents.list()) installRestriction(agent)
    }
  } catch { /* older composition without an agent registry */ }
  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => installRestriction(agent))
    ctx.on('agent/disposed', ({ agent }) => disposeRestriction(agent))
  }
  ctx.effect(() => () => {
    for (const agent of [...restrictions.keys()]) disposeRestriction(agent)
  }, 'ssh-remote: remote-session tool visibility')
}

/** A presentation-only machine label; never throws on stale arguments. */
function safeMachineLabel(args, store, primaryId) {
  try {
    const value = args?.host
    if (typeof value !== 'string' || value === '') return primaryId
    if (value === PRIMARY_ALIAS) return primaryId
    return store.list().some(machine => machine.id === value || machine.host === value) ? value : primaryId
  } catch {
    return primaryId
  }
}

/** Quote one value for a POSIX shell. */
function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
