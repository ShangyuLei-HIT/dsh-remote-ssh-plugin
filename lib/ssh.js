/**
 * SSH transport for the ssh-remote plugin.
 *
 * One instance owns the OpenSSH command line for one configured host: batch
 * (non-interactive) connections, connection multiplexing through ControlMaster,
 * bounded output capture, cooperative cancellation and timeout kills. Commands
 * run through `bash -lc` on the remote side so the login PATH is available,
 * and every call is independent (no remote shell state is kept between calls).
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A transport failure: not a remote command's non-zero exit, but a broken call. */
export class SshError extends Error {
  /** Stable machine-readable code, such as `ssh-exit-missing` or `ssh-timeout`. */
  code

  constructor(message, code) {
    super(message)
    this.name = 'SshError'
    this.code = code
  }
}

/** Quote one value for a POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** Collect at most `cap` bytes of one stream while counting everything the peer wrote. */
function collector(cap) {
  const chunks = []
  let kept = 0
  let total = 0
  let truncated = false
  return {
    push(chunk) {
      total += chunk.length
      if (kept >= cap) {
        truncated = true
        return
      }
      const room = cap - kept
      if (chunk.length <= room) {
        chunks.push(chunk)
        kept += chunk.length
        return
      }
      chunks.push(chunk.subarray(0, room))
      kept += room
      truncated = true
    },
    finish() {
      return { buffer: Buffer.concat(chunks), total, truncated }
    },
  }
}

/**
 * One configured SSH destination.
 *
 * Options are resolved and validated by the plugin before construction: `host`
 * is the OpenSSH destination (alias or user@address), `workspace` is the default
 * remote directory (empty means the login directory), and the remaining fields
 * tune deadlines, output caps and the multiplexing socket.
 */
export class SshClient {
  /** @type {string} */
  host
  /** @type {string} */
  sshBinary
  /** @type {string} */
  remoteShell
  /** @type {string} */
  workspace
  /** @type {number} */
  connectTimeoutSeconds
  /** @type {number} */
  defaultTimeoutMs
  /** @type {number} */
  maxOutputChars
  /** @type {number} */
  controlPersistSeconds
  /** @type {boolean} */
  clearForwardings
  /** @type {string[]} */
  extraArgs
  /** @type {string} */
  controlPath
  #disposed = false

  constructor(options) {
    this.host = options.host
    this.sshBinary = options.sshBinary
    this.remoteShell = options.remoteShell
    this.workspace = options.workspace
    this.connectTimeoutSeconds = options.connectTimeoutSeconds
    this.defaultTimeoutMs = options.defaultTimeoutMs
    this.maxOutputChars = options.maxOutputChars
    this.controlPersistSeconds = options.controlPersistSeconds
    this.clearForwardings = options.clearForwardings
    this.extraArgs = options.extraArgs
    const digest = createHash('sha256').update(`${this.host}\u0000${this.controlPersistSeconds}`).digest('hex').slice(0, 12)
    this.controlPath = join(tmpdir(), `dsh-ssh-${digest}`)
  }

  /** Multiplexing and socket options shared by command runs and the closing `-O exit`. */
  #controlArgs() {
    return [
      '-o', `ControlMaster=auto`,
      '-o', `ControlPath=${this.controlPath}`,
      '-o', `ControlPersist=${this.controlPersistSeconds}`,
    ]
  }

  /** The complete option list for one `ssh` invocation, up to (not including) the destination. */
  #baseArgs() {
    const args = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${this.connectTimeoutSeconds}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=4',
      ...this.#controlArgs(),
    ]
    // A user's ~/.ssh/config may forward ports that a pure command channel does not
    // need; clearing them keeps every call free of "address already in use" noise.
    if (this.clearForwardings) args.push('-o', 'ClearAllForwardings=yes')
    if (this.extraArgs.length > 0) args.push(...this.extraArgs)
    return args
  }

  /**
   * Run one remote shell script and capture bounded stdout/stderr.
   *
   * @param {string} script POSIX shell source executed by `bash -lc` on the remote host.
   * @param {object} [options]
   * @param {string} [options.cwd] Remote directory to enter first; defaults to no `cd`.
   * @param {number} [options.timeoutMs] Kill the call after this many milliseconds.
   * @param {AbortSignal} [options.signal] Caller cancellation; kills the call and rejects with its reason.
   * @param {Buffer|string} [options.stdin] Bytes fed to the remote command's stdin.
   * @param {number} [options.maxOutputBytes] Per-stream capture cap; defaults to the configured output cap.
   * @returns {Promise<{exitCode: number, signal: string|null, stdout: Buffer, stderr: Buffer, totalStdoutBytes: number, totalStderrBytes: number, truncated: boolean, timedOut: boolean, durationMs: number}>}
   */
  runRaw(script, options = {}) {
    const { cwd, timeoutMs = this.defaultTimeoutMs, signal, stdin, maxOutputBytes = this.maxOutputChars } = options
    if (this.#disposed) return Promise.reject(new SshError('The SSH client has been disposed.', 'ssh-disposed'))
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const guarded = cwd === undefined || cwd === ''
      ? script
      : `cd -- ${shellQuote(cwd)} 2>/dev/null || { printf 'dsh-ssh-remote: remote working directory is unavailable\\n' >&2; exit 97; }\n${script}`
    const remoteCommand = `${this.remoteShell} -lc ${shellQuote(guarded)}`
    const args = [...this.#baseArgs(), '--', this.host, remoteCommand]

    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.sshBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new SshError(`Could not start ${this.sshBinary}: ${error.message}`, 'ssh-spawn-failed'))
        return
      }

      const startedAt = Date.now()
      const stdout = collector(maxOutputBytes)
      const stderr = collector(maxOutputBytes)
      let timedOut = false
      let settled = false
      let timer

      const finish = (callback, value) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        callback(value)
      }
      const onAbort = () => {
        child.kill('SIGKILL')
        finish(reject, signal.reason)
      }

      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.stdin.on('error', () => {})
      child.on('error', error => {
        finish(reject, new SshError(`ssh ${this.host} failed to start: ${error.message}`, 'ssh-spawn-failed'))
      })
      child.on('close', (code, closeSignal) => {
        const out = stdout.finish()
        const err = stderr.finish()
        const exitCode = timedOut ? 137 : typeof code === 'number' ? code : closeSignal === 'SIGKILL' ? 137 : 1
        finish(resolve, {
          exitCode,
          signal: closeSignal,
          stdout: out.buffer,
          stderr: err.buffer,
          totalStdoutBytes: out.total,
          totalStderrBytes: err.total,
          truncated: out.truncated || err.truncated,
          timedOut,
          durationMs: Date.now() - startedAt,
        })
      })

      try {
        if (stdin === undefined) child.stdin.end()
        else child.stdin.end(stdin)
      } catch {
        // The process may already be gone; its close/error handler reports the outcome.
      }
    })
  }

  /**
   * Run one remote shell script and decode both streams as UTF-8 text.
   *
   * @param {string} script Remote POSIX shell source.
   * @param {Parameters<SshClient['runRaw']>[1]} [options] Same options as {@link SshClient.runRaw}.
   * @returns {Promise<{exitCode: number, signal: string|null, stdout: string, stderr: string, totalStdoutBytes: number, totalStderrBytes: number, truncated: boolean, timedOut: boolean, durationMs: number}>}
   */
  async run(script, options = {}) {
    const result = await this.runRaw(script, options)
    return {
      ...result,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
    }
  }

  /**
   * Report the remote identity and toolchain through one connection probe.
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs] Probe deadline; defaults to the configured request timeout.
   * @param {AbortSignal} [options.signal] Caller cancellation.
   * @returns {Promise<{host: string, user: string, hostname: string, system: string, cwd: string, toolchain: Record<string, string>, latencyMs: number}>}
   */
  async probe(options = {}) {
    const { timeoutMs = Math.min(this.defaultTimeoutMs, 30_000), signal, cwd: startCwd } = options
    const script = [
      'printf "%s\\n" "${USER:-$(id -un)}"',
      'hostname',
      'uname -srm',
      'pwd',
      'command -v node || true',
      'command -v npm || true',
      'command -v git || true',
      'command -v python3 || true',
    ].join('; ')
    const startedAt = Date.now()
    const result = await this.run(script, { cwd: (startCwd ?? this.workspace) || undefined, timeoutMs, signal, maxOutputBytes: 8_192 })
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
      throw new SshError(`Cannot connect to ${this.host} over SSH: ${detail}`, 'ssh-connect-failed')
    }
    const [user = '', hostname = '', system = '', cwd = '', node = '', npm = '', git = '', python = ''] = result.stdout.split('\n')
    const toolchain = {}
    if (node !== '') toolchain.node = node
    if (npm !== '') toolchain.npm = npm
    if (git !== '') toolchain.git = git
    if (python !== '') toolchain.python3 = python
    return {
      host: this.host,
      user: user.trim(),
      hostname: hostname.trim(),
      system: system.trim(),
      cwd: cwd.trim(),
      toolchain,
      latencyMs: Date.now() - startedAt,
    }
  }

  /** Close the multiplexing master socket, if this client opened one. Best effort. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    try {
      const child = spawn(this.sshBinary, [...this.#controlArgs(), '-O', 'exit', '--', this.host], { stdio: 'ignore' })
      child.on('error', () => {})
    } catch {
      // A missing ssh binary or a socket that never existed leaves nothing to close.
    }
  }
}
