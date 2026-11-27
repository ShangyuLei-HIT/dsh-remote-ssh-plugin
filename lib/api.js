/**
 * HTTP API for the SSH remote settings panel.
 *
 * Mounted by the Host half under `/api/ssh-remote`. The desktop Web shell and the
 * browser Web shell both reach it same-origin, so the handler refuses a request
 * whose `Origin` header does not match the listening `Host` (a cross-site form
 * post would otherwise reach a loopback server). Every machine mutation persists
 * through the shared {@link MachineStore} and drops that machine's cached
 * transport so the next tool call reconnects with the new settings.
 */

import { MachineError, normalizeMachine, normalizeWorkspace } from './machines.js'
import { browseDirectory, createDirectory, directoryExists } from './remote-fs.js'

const MAX_BODY_BYTES = 1_000_000

/** Write one JSON response. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read a bounded JSON request body. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('request body must be JSON'))
      }
    })
    request.on('error', reject)
  })
}

/** True when the request comes from the shell served by this same listener. */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Build the `/api/ssh-remote` request handler.
 *
 * @param {object} deps
 * @param {import('./machines.js').MachineStore} deps.store Machine registry backing the tools.
 * @param {(machine: {id: string, host: string, workspace: string}) => import('./ssh.js').SshClient} deps.clientFor Transport lookup.
 * @param {(id: string) => void} deps.disposeMachines Drop cached transports for one machine id.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(deps) {
  const { store, clientFor, disposeMachines, bindings, ensureRemoteWorkspace, removeRemoteWorkspace } = deps

  /**
   * Resolve the machine a request names: a configured id, or an ad-hoc
   * OpenSSH destination for the Add-machine dialog before the machine is saved.
   */
  const machineForBody = body => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const host = typeof body.host === 'string' ? body.host.trim() : ''
    const configured = id === '' ? undefined : store.list().find(entry => entry.id === id)
    if (configured !== undefined) return configured
    if (host !== '') return { id: id === '' ? host : id, host, workspace: '' }
    if (id !== '') throw new MachineError(`Unknown machine "${id}"`, 'unknown-machine')
    throw new MachineError('machine id must not be empty', 'invalid-machine')
  }

  const machineOf = id => {
    const value = typeof id === 'string' ? id.trim() : ''
    if (value === '') throw new MachineError('machine id must not be empty', 'invalid-machine')
    const machine = store.list().find(entry => entry.id === value)
    if (machine === undefined) throw new MachineError(`Unknown machine "${value}"`, 'unknown-machine')
    return machine
  }

  const statePayload = () => ({
    machines: store.list().map((machine, index) => ({ ...machine, primary: index === 0 })),
    primary: store.primary().id,
    stateFile: store.file ?? null,
    workspaces: bindings.list().map(binding => ({
      id: binding.id,
      title: binding.title,
      machineId: binding.machineId,
      remotePath: binding.remotePath,
      mirrorPath: binding.mirrorPath,
      workspaceId: binding.workspaceId ?? null,
    })),
  })

  return async function handle(request, response) {
    try {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin request refused' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname.replace(/^\/api\/ssh-remote/, '') || '/'
      const method = request.method ?? 'GET'
      if (method === 'GET' && path === '/state') {
        sendJson(response, 200, statePayload())
        return
      }
      if (method === 'GET' && path === '/workspaces') {
        sendJson(response, 200, statePayload())
        return
      }
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }
      const body = await readBody(request)
      switch (path) {
        case '/test': {
          const machine = machineForBody(body)
          const status = await clientFor(machine).probe({ timeoutMs: 20_000 })
          sendJson(response, 200, { ok: true, machine: machine.id, status })
          return
        }
        case '/browse': {
          const machine = machineForBody(body)
          const listing = await browseDirectory(clientFor(machine), typeof body.path === 'string' ? body.path : '')
          sendJson(response, 200, { ok: true, machine: machine.id, ...listing })
          return
        }
        case '/mkdir': {
          const machine = machineForBody(body)
          const parent = typeof body.path === 'string' && body.path !== '' ? body.path : machine.workspace
          const created = await createDirectory(clientFor(machine), parent, typeof body.name === 'string' ? body.name : '')
          sendJson(response, 200, { ok: true, path: created })
          return
        }
        case '/workspace': {
          const machine = machineOf(body.id)
          const workspace = normalizeWorkspace(body.workspace)
          if (workspace !== '') {
            const exists = await directoryExists(clientFor(machine), workspace)
            if (!exists) throw new Error(`Remote directory not found: ${workspace}`)
          }
          store.upsert({ id: machine.id, host: machine.host, workspace })
          disposeMachines(machine.id)
          // A selected directory becomes a workspace entry: the mirror directory
          // is the DSH workspace path and the remote target is the binding.
          const binding = workspace === ''
            ? undefined
            : await ensureRemoteWorkspace({ id: machine.id, host: machine.host }, workspace)
          sendJson(response, 200, { ok: true, workspace: binding ?? null, ...statePayload() })
          return
        }
        case '/workspaces/remove': {
          const removed = await removeRemoteWorkspace(body.id ?? body.workspaceId ?? body.mirrorPath)
          sendJson(response, 200, { ok: true, removed: removed.title, ...statePayload() })
          return
        }
        case '/machines': {
          if (body.action === 'remove') {
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            // Deleting a machine also deletes the remote workspaces it owns, so
            // the Workspaces list never keeps an entry for a vanished host.
            for (const binding of bindings.list().filter(entry => entry.machineId === id)) {
              try { await removeRemoteWorkspace(binding.id) } catch { /* registry record already gone */ }
            }
            store.remove(id)
            disposeMachines(id)
            sendJson(response, 200, { ok: true, ...statePayload() })
            return
          }
          const action = body.action === 'create' || body.action === 'update' ? body.action : 'save'
          const machine = normalizeMachine(body.machine ?? body)
          const exists = store.list().some(entry => entry.id === machine.id)
          if (action === 'create' && exists) throw new MachineError(`Machine "${machine.id}" already exists.`, 'machine-exists')
          if (action === 'update' && !exists) throw new MachineError(`Unknown machine "${machine.id}".`, 'unknown-machine')
          // A workspace entered with the machine is validated and registered in
          // the same request, so the Add-machine dialog can finish in one step.
          if (machine.workspace !== '' && body.validateWorkspace !== false) {
            const transport = clientFor({ ...machine, workspace: machine.workspace })
            const existsRemote = await directoryExists(transport, machine.workspace)
            if (!existsRemote) throw new Error(`Remote directory not found: ${machine.workspace}`)
          }
          store.upsert(machine)
          disposeMachines(machine.id)
          const workspace = machine.workspace === ''
            ? undefined
            : await ensureRemoteWorkspace({ id: machine.id, host: machine.host }, machine.workspace)
          sendJson(response, 200, { ok: true, machine, workspace: workspace ?? null, ...statePayload() })
          return
        }
        case '/workspaces/register': {
          const value = typeof body.id === 'string' ? body.id : ''
          const binding = bindings.find(value)
          if (binding === undefined) throw new Error(`Unknown remote workspace "${value}".`)
          const machine = store.list().find(entry => entry.id === binding.machineId)
          if (machine === undefined) throw new Error(`Machine "${binding.machineId}" is no longer configured.`)
          const workspace = await ensureRemoteWorkspace(machine, binding.remotePath)
          sendJson(response, 200, { ok: true, workspace, ...statePayload() })
          return
        }
        default:
          sendJson(response, 404, { error: `Unknown endpoint ${path}` })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed'
      sendJson(response, 400, { error: message })
    }
  }
}
