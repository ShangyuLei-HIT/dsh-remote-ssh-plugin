#!/usr/bin/env node
/**
 * Preflight self-test for the ssh-remote bundle.
 *
 * Run this before installing or updating the bundle in a live profile:
 *
 *   node scripts/selftest.mjs          # contracts only (no network)
 *   node scripts/selftest.mjs --ssh    # plus one real connection probe and command
 *   node scripts/selftest.mjs --dsh    # plus validation against the running DSH installation
 *
 * Why it exists: a prompt-section `text(context)` provider that threw failed
 * every model turn of the desktop profile (`Cannot read properties of undefined
 * (reading 'get')`) while activation itself still reported success. Registration
 * callbacks must therefore be exercised with hostile inputs here, before the
 * plugin is enabled in a profile the user is working in.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
const pass = label => console.log(`PASS ${label}`)
const fail = (label, error) => {
  failures += 1
  console.log(`FAIL ${label}${error === undefined ? '' : `: ${error.message ?? error}`}`)
}
const attempt = (label, fn) => {
  try {
    fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

/** Collect what the plugin registers, without a DSH runtime. */
function loadPlugin(config) {
  const tools = new Map()
  const sections = []
  const routes = []
  const registryRecords = []
  let registryCounter = 0
  const ctx = {
    effect(factory) {
      return factory()
    },
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    inject(dependencies, callback) {
      const scope = {
        effect(factory) { return factory() },
        tools: { get: name => tools.get(name) },
      }
      for (const dependency of dependencies) {
        if (dependency === 'systemPrompt') scope.systemPrompt = { section: section => sections.push(section) }
        else if (dependency === 'webServer') scope.webServer = { register: route => { routes.push(route); return () => {} } }
        else if (dependency === 'workspaceRegistry') {
          scope.workspaceRegistry = {
            async create(path, title) {
              const record = { id: `ws-${++registryCounter}`, path, title }
              registryRecords.push(record)
              return record
            },
            list() { return registryRecords.map(record => ({ ...record })) },
            async remove(id) {
              const index = registryRecords.findIndex(record => record.id === id)
              if (index >= 0) registryRecords.splice(index, 1)
            },
          }
        }
        else throw new Error(`unexpected injected service ${dependency}`)
      }
      callback(scope)
    },
  }
  return import(pathToFileURL(join(root, 'index.js')).href).then(module => {
    module.apply(ctx, config)
    return { module, tools, sections, routes, registryRecords, ctx, config }
  })
}

/** One fake HTTP request for the settings API handler. */
function apiRequest(method, path, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = path
  stream.headers = { host: '127.0.0.1:51148', ...headers }
  return stream
}

/** One fake HTTP response capturing status, headers and body. */
function apiResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers ?? {} },
    end(body) { captured.body = body ?? '' },
  }
}

/** Call the captured settings API handler and parse its JSON response. */
async function callSettingsApi(routes, method, path, body, headers) {
  const route = routes.find(entry => entry.path === '/api/ssh-remote')
  if (route === undefined) throw new Error('settings API route is not registered')
  const response = apiResponse()
  await route.handler(apiRequest(method, `${route.path}${path}`, body, headers), response)
  let payload
  try { payload = response.captured.body === '' ? {} : JSON.parse(response.captured.body) } catch { payload = {} }
  return { status: response.captured.status, payload }
}

/** The JSON-Schema subset the DSH registry accepts for tool parameters and outputs. */
const KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function checkSchema(node, path, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} is not a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (KEYWORDS.has(key) || ANNOTATIONS.has(key)) continue
    violations.push(`${path}.${key} is not a supported keyword`)
  }
  if (Object.hasOwn(node, 'oneOf')) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf needs at least two branches`)
    else node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, violations))
    return
  }
  if (typeof node.type !== 'string' || !TYPES.has(node.type)) {
    violations.push(`${path}.type must be one of ${[...TYPES].join('/')}`)
    return
  }
  if (node.type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') violations.push(`${path}.additionalProperties must be a boolean`)
    if (Object.hasOwn(node, 'properties')) {
      const properties = node.properties
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) violations.push(`${path}.properties must be an object`)
      else for (const [key, child] of Object.entries(properties)) checkSchema(child, `${path}.properties.${key}`, violations)
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some(entry => typeof entry !== 'string')) violations.push(`${path}.required must be an array of strings`)
      else for (const entry of required) {
        if (typeof node.properties !== 'object' || node.properties === null || !Object.hasOwn(node.properties, entry)) {
          violations.push(`${path}.required names undeclared property ${entry}`)
        }
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) checkSchema(node.items, `${path}.items`, violations)
}

async function main() {
  const withSsh = process.argv.includes('--ssh')
  // `--offline` skips every SSH-dependent case so a CI runner without a reachable
  // host can still check the manifests, tool contracts, argument validation and
  // the request-independent parts of the settings API.
  const offline = process.argv.includes('--offline')
  const withDsh = process.argv.includes('--dsh')

  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  attempt('manifest has a bundle patch', () => {
    if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error(JSON.stringify(manifest.dsh))
    readFileSync(join(root, 'cordis.patch.yml'))
  })
  attempt('manifest exports its icon and locales', () => {
    for (const key of ['.', './icon', './locale/*.json']) {
      if (manifest.exports?.[key] === undefined) throw new Error(`missing export ${key}`)
    }
  })

  const testHost = process.env.DSH_SSH_REMOTE_TEST_HOST ?? 'server-lsy'
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-remote-selftest-'))
  process.env.DSH_HOME = stateDir
  process.env.DSH_SSH_REMOTE_STATE = join(stateDir, 'machines.json')
  const loaded = await loadPlugin({
    host: testHost,
    workspace: '/root',
    hosts: [{ id: 'alt', host: testHost, workspace: '/root' }],
  })
  const { tools, sections } = loaded

  attempt('every tool registers a supported schema', () => {
    if (tools.size === 0) throw new Error('no tools registered')
    const violations = []
    for (const definition of tools.values()) {
      checkSchema(definition.parameters, `${definition.name}.parameters`, violations)
      checkSchema(definition.output.schema, `${definition.name}.output`, violations)
      if (definition.parameters.type !== 'object' || definition.parameters.additionalProperties !== false) {
        violations.push(`${definition.name}.parameters must be a closed object root`)
      }
      if (typeof definition.output.render !== 'function' || typeof definition.execute !== 'function') {
        violations.push(`${definition.name} needs output.render and execute`)
      }
    }
    if (violations.length > 0) throw new Error(violations.join('; '))
  })

  attempt('prompt sections cannot throw during assembly', () => {
    if (sections.length !== 1) throw new Error(`expected one section, got ${sections.length}`)
    const contexts = [
      {},
      { scope: undefined },
      { scope: 'scope-key' },
      { scope: {} },
      { signal: new AbortController().signal },
    ]
    for (const section of sections) {
      if (typeof section.text === 'string') continue
      if (typeof section.text !== 'function') throw new Error('section.text must be a string or a function')
      for (const context of contexts) {
        const value = section.text(context)
        if (typeof value !== 'string') throw new Error('section text provider returned a non-string')
      }
    }
  })

  attempt('call presenters never throw on hostile arguments', () => {
    const hostile = [undefined, null, {}, { command: 5 }, { path: 'x' }, 'garbage', { remotePath: 'a', localPath: 'b' }, { host: 'no-such-machine' }, { host: 5 }]
    for (const definition of tools.values()) {
      if (definition.presentCall === undefined) continue
      for (const args of hostile) definition.presentCall(args)
    }
  })

  await (async () => {
    const exec = { signal: new AbortController().signal }
    const cases = [
      ['remote_exec', {}, 'missing command'],
      ['remote_exec', { command: 'true', nope: 1 }, 'unknown key'],
      ['remote_read', { path: 7 }, 'wrong type'],
      ['remote_status', { host: 'no-such-machine' }, 'unknown machine'],
    ]
    for (const [name, args, label] of cases) {
      const definition = tools.get(name)
      if (definition === undefined) throw new Error(`missing tool ${name}`)
      let rejected = false
      try {
        await definition.execute(args, exec)
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error(`${name} accepted ${label}`)
    }
    pass('argument validation rejects bad calls')
  })().catch(error => fail('argument validation rejects bad calls', error))

  const { routes } = loaded
  attempt('host registers the settings API route', () => {
    if (routes.length !== 1 || routes[0].path !== '/api/ssh-remote' || routes[0].kind !== 'prefix') {
      throw new Error(JSON.stringify(routes.map(route => ({ path: route.path, kind: route.kind }))))
    }
    if (typeof routes[0].handler !== 'function') throw new Error('route has no handler')
  })

  try {
    const initial = await callSettingsApi(routes, 'GET', '/state')
    if (initial.status !== 200 || !Array.isArray(initial.payload.machines) || initial.payload.machines.length !== 2) {
      fail('settings API state', new Error(JSON.stringify(initial.payload)))
    } else pass('settings API state')

    const added = await callSettingsApi(routes, 'POST', '/machines', {
      action: 'save',
      machine: { id: 'extra', host: testHost, workspace: offline ? '' : '/root' },
    })
    if (added.status !== 200 || !added.payload.machines.some(machine => machine.id === 'extra')) {
      fail('settings API save machine', new Error(JSON.stringify(added.payload)))
    } else pass('settings API save machine')

    if (!existsSync(join(stateDir, 'machines.json'))) fail('settings state persistence', new Error('state file was not written'))
    else pass('settings state persistence')

    const refused = await callSettingsApi(routes, 'POST', '/machines', { action: 'remove', id: 'extra' }, { origin: 'https://evil.example' })
    if (refused.status !== 403) fail('cross-origin POST refused', new Error(JSON.stringify(refused)))
    else pass('cross-origin POST refused')

    const removed = await callSettingsApi(routes, 'POST', '/machines', { action: 'remove', id: 'extra' })
    if (removed.status !== 200 || removed.payload.machines.some(machine => machine.id === 'extra')) {
      fail('settings API remove machine', new Error(JSON.stringify(removed.payload)))
    } else pass('settings API remove machine')
  } catch (error) {
    fail('settings API contract', error)
  }

  if (!offline) try {
    // Creating a machine with a directory registers its workspace in the same request.
    const savedMachine = await callSettingsApi(routes, 'POST', '/machines', {
      action: 'create',
      machine: { id: 'ws-machine', host: testHost, workspace: '/root' },
    })
    const extraWorkspace = (savedMachine.payload.workspaces ?? []).find(workspace => workspace.machineId === 'ws-machine')
    if (extraWorkspace === undefined || extraWorkspace.workspaceId === null) {
      fail('machine create registers workspace', new Error(JSON.stringify(savedMachine.payload)))
    } else pass('machine create registers workspace')

    // The primary machine's directory is registered through /workspace.
    const created = await callSettingsApi(routes, 'POST', '/workspace', { id: testHost, workspace: '/root' })
    const primaryWorkspace = created.payload.workspace
    if (created.status !== 200 || primaryWorkspace === null || !String(primaryWorkspace?.title).startsWith('SSH · ')) {
      fail('settings API creates a remote workspace', new Error(JSON.stringify(created.payload)))
    } else pass('settings API creates a remote workspace')

    if (primaryWorkspace?.workspaceId === null || primaryWorkspace?.workspaceId === undefined) {
      fail('remote workspace registration', new Error(JSON.stringify(primaryWorkspace)))
    } else pass('remote workspace registration')

    const mirror = primaryWorkspace.mirrorPath
    if (!existsSync(mirror) || !existsSync(join(mirror, '.dsh-ssh-remote.json'))) {
      fail('mirror directory and marker', new Error(mirror))
    } else pass('mirror directory and marker')

    const listedWorkspaces = await callSettingsApi(routes, 'GET', '/workspaces')
    const listedIds = (listedWorkspaces.payload.workspaces ?? []).map(workspace => workspace.id)
    if (listedWorkspaces.status !== 200 || !listedIds.includes(primaryWorkspace.id) || !listedIds.includes(extraWorkspace.id)) {
      fail('settings API lists remote workspaces', new Error(JSON.stringify(listedWorkspaces.payload)))
    } else pass('settings API lists remote workspaces')

    const registered = await callSettingsApi(routes, 'POST', '/workspaces/register', { id: primaryWorkspace.id })
    if (registered.status !== 200 || registered.payload.workspace?.workspaceId === null) {
      fail('settings API re-registers a workspace', new Error(JSON.stringify(registered.payload)))
    } else pass('settings API re-registers a workspace')

    const removedWorkspace = await callSettingsApi(routes, 'POST', '/workspaces/remove', { id: primaryWorkspace.id })
    const remaining = (removedWorkspace.payload.workspaces ?? []).map(workspace => workspace.id)
    if (removedWorkspace.status !== 200 || remaining.includes(primaryWorkspace.id) || !remaining.includes(extraWorkspace.id)) {
      fail('settings API removes remote workspace', new Error(JSON.stringify(removedWorkspace.payload)))
    } else pass('settings API removes remote workspace')

    // Removing a machine cascades to the remote workspaces it owns.
    const removedMachine = await callSettingsApi(routes, 'POST', '/machines', { action: 'remove', id: 'ws-machine' })
    if (removedMachine.status !== 200 || (removedMachine.payload.workspaces ?? []).some(workspace => workspace.machineId === 'ws-machine')) {
      fail('machine removal cascades to workspaces', new Error(JSON.stringify(removedMachine.payload)))
    } else pass('machine removal cascades to workspaces')

    // Create vs update actions are distinct: a duplicate create is refused.
    const duplicate = await callSettingsApi(routes, 'POST', '/machines', {
      action: 'create',
      machine: { id: testHost, host: testHost, workspace: '' },
      validateWorkspace: false,
    })
    if (duplicate.status === 400) pass('duplicate machine create refused')
    else fail('duplicate machine create refused', new Error(JSON.stringify(duplicate.payload)))
  } catch (error) {
    fail('remote workspace API contract', error)
  }

  if (withDsh) {
    const dsh = process.env.DSH_INSTALL_DIR
    if (dsh === undefined) fail('DSH contract check', new Error('DSH_INSTALL_DIR is not set; run inside a Harness shell'))
    else {
      const toolsPackage = join(dsh, '..', 'dsh-tools', 'lib', 'index.js')
      const registry = await import(pathToFileURL(toolsPackage).href).catch(error => {
        fail('DSH contract check', new Error(`${error.code ?? 'import failed'}: ${error.message} (run with ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" when DSH is packaged in app.asar)`))
        return undefined
      })
      if (registry !== undefined) {
        attempt('tool schemas pass the running DSH validator', () => {
          const violations = []
          for (const definition of tools.values()) {
            try {
              registry.assertSupportedJsonSchema(definition.parameters)
              registry.assertSupportedJsonSchema(definition.output.schema)
              registry.projectToolSchema(definition, true)
            } catch (error) {
              violations.push(`${definition.name}: ${error.message}`)
            }
          }
          if (violations.length > 0) throw new Error(violations.join('; '))
        })
      }
    }
  }

  if (withSsh) {
    const exec = { signal: new AbortController().signal }
    const status = await tools.get('remote_status').execute({}, exec).catch(error => {
      fail('SSH probe', error)
      return undefined
    })
    if (status !== undefined) {
      pass(`SSH probe (${status.user}@${status.hostname}, ${status.cwd}, ${status.latencyMs}ms)`)
      if (!Array.isArray(status.machines) || !status.machines.includes('alt')) fail('machine list', new Error(JSON.stringify(status.machines)))
      else pass('machine list')
      const result = await tools.get('remote_exec').execute({ command: 'printf dsh-selftest-ok' }, exec).catch(error => {
        fail('SSH exec', error)
        return undefined
      })
      if (result !== undefined) {
        if (result.exitCode !== 0 || result.stdout !== 'dsh-selftest-ok') fail('SSH exec output', new Error(JSON.stringify(result)))
        else if (result.machine !== status.machine) fail('SSH exec machine', new Error(`${result.machine} != ${status.machine}`))
        else pass('SSH exec')
      }
      const alt = await tools.get('remote_status').execute({ host: 'alt' }, exec).catch(error => {
        fail('SSH probe alt machine', error)
        return undefined
      })
      if (alt !== undefined) {
        if (alt.machine !== 'alt') fail('SSH alt routing', new Error(JSON.stringify(alt)))
        else pass('SSH alt routing')
      }
      const listing = await callSettingsApi(routes, 'POST', '/browse', { id: alt.machine, path: '/root' }).catch(error => {
        fail('settings API browse', error)
        return undefined
      })
      if (listing !== undefined) {
        if (listing.status !== 200 || !Array.isArray(listing.payload.entries) || !Array.isArray(listing.payload.crumbs)) {
          fail('settings API browse', new Error(JSON.stringify(listing.payload)))
        } else pass(`settings API browse (${listing.payload.entries.length} entries)`)
      }
      const tested = await callSettingsApi(routes, 'POST', '/test', { id: alt.machine }).catch(error => {
        fail('settings API test connection', error)
        return undefined
      })
      if (tested !== undefined) {
        if (tested.status !== 200 || tested.payload.status?.hostname === undefined) fail('settings API test connection', new Error(JSON.stringify(tested.payload)))
        else pass('settings API test connection')
      }
      const sessionWorkspace = await callSettingsApi(routes, 'POST', '/workspace', { id: alt.machine, workspace: '/tmp' }).catch(error => {
        fail('session workspace binding', error)
        return undefined
      })
      if (sessionWorkspace !== undefined && sessionWorkspace.status === 200 && sessionWorkspace.payload.workspace?.mirrorPath !== undefined) {
        const boundExec = { signal: new AbortController().signal, agent: { session: { header: { cwd: sessionWorkspace.payload.workspace.mirrorPath } } } }
        const sessionPwd = await tools.get('remote_exec').execute({ command: 'pwd' }, boundExec).catch(error => {
          fail('session-bound remote_exec', error)
          return undefined
        })
        if (sessionPwd !== undefined) {
          if (sessionPwd.stdout.trim() !== '/tmp' || sessionPwd.cwd !== '/tmp') fail('session-bound remote_exec', new Error(JSON.stringify(sessionPwd)))
          else pass('session-bound remote_exec')
        }
        const sessionStatus = await tools.get('remote_status').execute({}, boundExec).catch(error => {
          fail('session-bound remote_status', error)
          return undefined
        })
        if (sessionStatus !== undefined) {
          if (sessionStatus.cwd !== '/tmp') fail('session-bound remote_status', new Error(JSON.stringify(sessionStatus)))
          else pass('session-bound remote_status')
        }
        const localPwd = await tools.get('remote_exec').execute({ command: 'pwd' }, exec).catch(error => {
          fail('local session default directory', error)
          return undefined
        })
        if (localPwd !== undefined) {
          if (localPwd.stdout.trim() !== '/root') fail('local session default directory', new Error(JSON.stringify(localPwd)))
          else pass('local session default directory')
        }
        await callSettingsApi(routes, 'POST', '/workspaces/remove', { id: sessionWorkspace.payload.workspace.id })
        await callSettingsApi(routes, 'POST', '/workspace', { id: alt.machine, workspace: '/root' })
      } else {
        fail('session workspace binding', new Error(JSON.stringify(sessionWorkspace)))
      }
      const badWorkspace = await callSettingsApi(routes, 'POST', '/workspace', { id: alt.machine, workspace: '/definitely-not-a-directory-9f3a' }).catch(error => {
        fail('settings API workspace validation', error)
        return undefined
      })
      if (badWorkspace !== undefined) {
        if (badWorkspace.status !== 400) fail('settings API workspace validation', new Error(JSON.stringify(badWorkspace.payload)))
        else pass('settings API workspace validation')
      }
    }
  }

  try {
    const state = await callSettingsApi(routes, 'GET', '/state')
    for (const machine of state.payload.machines.slice(1)) {
      await callSettingsApi(routes, 'POST', '/machines', { action: 'remove', id: machine.id })
    }
    const last = (await callSettingsApi(routes, 'GET', '/state')).payload.machines[0]
    const primaryRemoval = await callSettingsApi(routes, 'POST', '/machines', { action: 'remove', id: last.id })
    if (primaryRemoval.status === 400) pass('last machine is retained')
    else fail('last machine is retained', new Error(JSON.stringify(primaryRemoval.payload)))
  } catch (error) {
    fail('last machine is retained', error)
  }

  rmSync(stateDir, { recursive: true, force: true })
  if (offline) console.log('(offline mode: SSH-dependent cases skipped)')
  console.log(failures === 0 ? 'SELFTEST_OK' : `SELFTEST_FAILURES=${failures}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
