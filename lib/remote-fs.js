/**
 * Remote filesystem helpers for the settings panel: browse one directory level,
 * read the login directory and create a child directory through the same SSH
 * client the tools use.
 */

import { shellQuote } from './ssh.js'

/** One row of a remote directory listing. */
/** @typedef {{name: string, path: string, isDirectory: boolean, isSymlink: boolean, hidden: boolean}} RemoteDirectoryEntry */

/** Join a remote directory with one child name, POSIX style. */
export function joinRemote(directory, name) {
  if (directory === '' || directory === '/') return `/${name}`
  return `${directory.replace(/\/+$/, '')}/${name}`
}

/** Ancestor chain from the filesystem root to `path`, inclusive. */
export function crumbsFor(path) {
  const parts = path.split('/').filter(part => part !== '')
  const crumbs = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** The remote login directory, used when the panel opens without a path. */
export async function homeDirectory(client, options = {}) {
  const result = await client.run('printf %s "$HOME"', { timeoutMs: 15_000, maxOutputBytes: 4_096, signal: options.signal })
  if (result.exitCode !== 0 || result.stdout.trim() === '') {
    throw new Error(`Cannot read the remote login directory: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
  }
  return result.stdout.trim()
}

/**
 * List one remote directory level.
 *
 * @param {import('./ssh.js').SshClient} client The machine's transport.
 * @param {string} path Absolute remote directory.
 * @param {object} [options] Cancellation and deadline overrides.
 * @returns {Promise<{path: string, home: string, parent: string, crumbs: Array<{name: string, path: string}>, entries: RemoteDirectoryEntry[]}>}
 */
export async function browseDirectory(client, path, options = {}) {
  const home = await homeDirectory(client, options)
  const target = path === '' || path === undefined ? home : path
  const script = `cd -- ${shellQuote(target)} 2>/dev/null || exit 3
pwd
find . -maxdepth 1 -mindepth 1 \\( -type d -o \\( -type l -xtype d \\) \\) -printf '%y\\t%f\\n' 2>/dev/null | LC_ALL=C sort`
  const result = await client.run(script, { timeoutMs: 20_000, maxOutputBytes: 262_144, signal: options.signal })
  if (result.exitCode === 3) throw new Error(`Remote directory not found: ${target}`)
  if (result.exitCode !== 0) throw new Error(`Cannot list ${target}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
  const lines = result.stdout.split('\n')
  const resolved = (lines.shift() ?? target).trim() || target
  const entries = []
  for (const line of lines) {
    if (line === '') continue
    const tab = line.indexOf('\t')
    if (tab === -1) continue
    const type = line.slice(0, tab)
    const name = line.slice(tab + 1)
    if (name === '' || name === '.' || name === '..') continue
    // The find expression already keeps only real directories and symlinks
    // whose target is a directory, so `l` rows are enterable too.
    entries.push({
      name,
      path: joinRemote(resolved, name),
      isDirectory: type === 'd' || type === 'l',
      isSymlink: type === 'l',
      hidden: name.startsWith('.'),
    })
  }
  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
    return left.name.localeCompare(right.name, 'en')
  })
  const parent = resolved === '/' ? '/' : resolved.replace(/\/[^/]+$/, '') || '/'
  return { path: resolved, home, parent, crumbs: crumbsFor(resolved), entries }
}

/** Create one child directory, returning the new absolute path. */
export async function createDirectory(client, parent, name, options = {}) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) {
    throw new Error('directory name must be one path segment and must not be . or ..')
  }
  const path = joinRemote(parent, trimmed)
  const result = await client.run(`mkdir -- ${shellQuote(path)}`, { timeoutMs: 15_000, maxOutputBytes: 4_096, signal: options.signal })
  if (result.exitCode !== 0) throw new Error(`Cannot create ${path}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
  return path
}

/** Whether an absolute remote path names a directory. */
export async function directoryExists(client, path, options = {}) {
  const result = await client.run(`[ -d ${shellQuote(path)} ]`, { timeoutMs: 15_000, maxOutputBytes: 1_024, signal: options.signal })
  return result.exitCode === 0
}
