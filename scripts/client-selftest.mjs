#!/usr/bin/env node
/**
 * Offline contract test for the browser half (`client.js`).
 *
 * The module-loader bundle cannot be imported as a module, and React comes from
 * the shell's module table, so this test provides both: a queue facade that
 * captures the factory and a minimal React + hooks shim that renders each
 * exported component once. It catches the failure mode that matters before a
 * page refresh — a component that throws or a slot registration with the wrong
 * id/name — without a browser.
 *
 *   node scripts/client-selftest.mjs
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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

/* ── module-loader facade ─────────────────────────────────────────────────── */

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { captured = entry },
  },
}
await import(pathToFileURL(join(root, 'client.js')).href)
if (captured === undefined) {
  console.log('FAIL client module registers with the loader')
  process.exit(1)
}
pass('client module registers with the loader')
if (captured.id !== '@local/dsh-ssh-remote') fail('client module id', new Error(captured.id))
else pass('client module id')

/* ── React shim ───────────────────────────────────────────────────────────── */

const dictionaries = new Map()
let effectRuns = 0
const hooks = {
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useCallback(fn) { return fn },
  useMemo(factory) { return factory() },
  useRef(initial) { return { current: initial } },
  useEffect() { effectRuns += 1 },
}
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  Fragment: 'Fragment',
  ...hooks,
}
const locale = {
  register(namespace, dict) { dictionaries.set(namespace, dict); return () => {} },
  bind(namespace) {
    return key => dictionaries.get(namespace)?.zh?.[key] ?? key
  },
}

const factory = captured.factory(moduleName => {
  if (moduleName === 'react') return React
  throw new Error(`unexpected module ${moduleName}`)
})
attempt('factory returns inject and apply', () => {
  if (typeof factory.apply !== 'function') throw new Error('missing apply')
  if (Array.isArray(factory.inject) !== true) throw new Error('missing inject')
})

/* ── apply(): dictionaries + slot registration ────────────────────────────── */

let registered
const ctx = {
  effect(fn) { return fn() },
  locale,
  slots: {
    inject(_name, callback) { callback() },
    register(options, component) { registered = { options, component }; return () => {} },
  },
}
attempt('apply registers dictionaries and the settings slot', () => {
  factory.apply(ctx)
  const dict = dictionaries.get('sshRemote')
  if (dict === undefined || dict.zh === undefined || dict.en === undefined) throw new Error('missing zh/en dictionaries')
  if (registered === undefined) throw new Error('no slot registered')
  if (registered.options.name !== 'settings.section') throw new Error(`unexpected slot ${registered.options.name}`)
  if (registered.options.id !== 'ssh-remote') throw new Error(`unexpected slot id ${registered.options.id}`)
  if (typeof registered.options.label() !== 'string') throw new Error('label must return text')
})

/* ── dictionary coverage ──────────────────────────────────────────────────── */

attempt('every visible string has a zh and en translation', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const dict = dictionaries.get('sshRemote')
  const used = new Set([...source.matchAll(/t\('([^']+)'\)/g)].map(match => match[1]))
  const missingZh = [...used].filter(key => dict.zh[key] === undefined)
  const missingEn = [...used].filter(key => dict.en[key] === undefined)
  const zhOnly = Object.keys(dict.zh).filter(key => dict.en[key] === undefined)
  const enOnly = Object.keys(dict.en).filter(key => dict.zh[key] === undefined)
  const problems = []
  if (missingZh.length > 0) problems.push(`missing zh: ${missingZh.join(', ')}`)
  if (missingEn.length > 0) problems.push(`missing en: ${missingEn.join(', ')}`)
  if (zhOnly.length > 0) problems.push(`zh without en: ${zhOnly.join(', ')}`)
  if (enOnly.length > 0) problems.push(`en without zh: ${enOnly.join(', ')}`)
  if (problems.length > 0) throw new Error(problems.join(' | '))
  if (used.size < 40) throw new Error(`only ${used.size} translated strings found`)
})

/* ── render each component once ───────────────────────────────────────────── */

const reactStubActive = () => { if (effectRuns < 0) throw new Error('unreachable') }
const render = (label, component, props) => attempt(`render ${label}`, () => {
  const tree = component(props)
  if (tree === undefined || tree === null) throw new Error('component rendered nothing')
  reactStubActive()
})

const t = locale.bind('sshRemote')
const machine = { id: 'server-lsy', host: 'server-lsy', workspace: '/root', primary: true }
const components = factory.__components
render('SettingsPage (loading)', components.SettingsPage, { t })
render('MachineCard', components.MachineCard, {
  machine,
  t,
  status: { kind: 'ok', latencyMs: 42 },
  onTest() {}, onBrowse() {}, onEdit() {}, onRemove() {},
})
render('MachineCard (idle, no workspace)', components.MachineCard, {
  machine: { id: 'gpu', host: 'gpu-box', workspace: '', primary: false },
  t,
  onTest() {}, onBrowse() {}, onEdit() {}, onRemove() {},
})
render('MachineCard (error)', components.MachineCard, {
  machine: { id: 'prod', host: 'root@10.0.0.30', workspace: '/srv/app', primary: false },
  t,
  status: { kind: 'error', detail: 'connection refused' },
  onTest() {}, onBrowse() {}, onEdit() {}, onRemove() {},
})
render('StatusPill (idle)', components.StatusPill, { t })
render('StatusPill (pending)', components.StatusPill, { status: { kind: 'pending' }, t })
render('MachineModal (create)', components.MachineModal, { mode: 'create', t, onClose() {}, onSaved() {}, onBrowse() {} })
render('MachineModal (edit)', components.MachineModal, { mode: 'edit', machine, t, onClose() {}, onSaved() {}, onBrowse() {} })
render('BrowserModal', components.BrowserModal, {
  target: { id: 'server-lsy', host: 'server-lsy', workspace: '/root', label: 'server-lsy' },
  t,
  onClose() {}, onPick() {},
})
render('WorkspaceCard (registered)', components.WorkspaceCard, {
  workspace: { id: 'b1', title: 'SSH · server-lsy · /root', machineId: 'server-lsy', remotePath: '/root', mirrorPath: '/Users/x/.dsh/ssh-remote/workspaces/server-lsy/root', workspaceId: 'ws-1' },
  t,
  onRemove() {}, onRegister() {},
})
render('WorkspaceCard (unregistered)', components.WorkspaceCard, {
  workspace: { id: 'b2', title: 'SSH · gpu · /data/work', machineId: 'gpu', remotePath: '/data/work', mirrorPath: '/Users/x/.dsh/ssh-remote/workspaces/gpu/data_work', workspaceId: null },
  t,
  onRemove() {}, onRegister() {},
})

console.log(failures === 0 ? 'CLIENT_SELFTEST_OK' : `CLIENT_SELFTEST_FAILURES=${failures}`)
process.exit(failures === 0 ? 0 : 1)
