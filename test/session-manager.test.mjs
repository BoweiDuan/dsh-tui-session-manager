/**
 * Unit checks for the plugin contract and the scene's host-React discipline.
 *
 * These run without a TUI: the host seams (`ctx.tuiScenes`, `ctx.commands`)
 * and the scene's React are stubbed, so a regression in registration or in
 * the "never import our own React" rule fails here instead of at boot.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { sweepSessions } from '../sweep.js'
import { createSessionManagerScene, isEmptyArtifact } from '../scene.js'

// The plugin's diagnostics append to `$DSH_TUI_HOME/session-manager.log`.
// Point that at a throwaway directory for the whole run: a test must never
// write into the user's real TUI state.
const probeHome = mkdtempSync(join(tmpdir(), 'session-manager-tests-'))
process.env.DSH_TUI_HOME = probeHome
process.on('exit', () => {
  try {
    rmSync(probeHome, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is not worth failing a test run over.
  }
})

/**
 * Minimal host context stub.
 *
 * `ctx.inject(deps, callback)` mirrors Cordis: the callback runs only once the
 * declared services exist, so `seams: false` reproduces a host that never
 * mounts them (a headless launch) — where the plugin must stay completely
 * idle rather than register anything.
 */
function mockContext({ seams = true } = {}) {
  const calls = {
    scenes: [],
    commands: [],
    effects: [],
    opened: [],
    disposed: [],
    injected: [],
  }
  // Cordis resolves one service instance per name; the stub must do the same,
  // otherwise a test cannot mutate the service the plugin actually holds.
  const scenes = {
    register(descriptor, identity) {
      calls.scenes.push({ descriptor, identity })
      return () => calls.disposed.push('scene')
    },
    open(id) {
      calls.opened.push(id)
      return true
    },
  }
  const commands = {
    register(definition) {
      calls.commands.push(definition)
      return () => calls.disposed.push('command')
    },
  }
  // The injected child context: services are direct properties, exactly as in
  // Cordis (property access without a matching inject throws there).
  const hostContext = {
    tuiScenes: scenes,
    commands,
    effect(factory) {
      calls.effects.push(factory)
    },
  }
  const context = {
    logger: { warn() {} },
    effect(factory) {
      calls.effects.push(factory)
    },
    inject(dependencies, callback) {
      calls.injected.push([...dependencies])
      if (seams) callback(hostContext)
    },
  }
  return { context, calls, scenes, commands, hostContext }
}

test('apply waits for the seams and then registers one scene and one command', () => {
  const { context, calls, hostContext } = mockContext()
  apply(context)

  assert.deepEqual(calls.injected, [['tuiScenes', 'commands']])

  assert.equal(calls.scenes.length, 1)
  assert.equal(calls.scenes[0].descriptor.id, 'session-manager')
  assert.equal(typeof calls.scenes[0].descriptor.component, 'function')
  // Registered through the injected fiber, so a service replacement withdraws it.
  assert.equal(calls.scenes[0].identity, hostContext)

  assert.equal(calls.commands.length, 1)
  assert.equal(calls.commands[0].name, 'sessions')
  assert.equal(typeof calls.commands[0].handler, 'function')

  // Both registrations are effect-owned, so unloading withdraws them.
  assert.equal(calls.effects.length, 2)
  for (const factory of calls.effects) {
    const disposer = factory()
    assert.equal(typeof disposer, 'function')
  }
})

test('/sessions opens the scene and stays silent in the conversation', () => {
  const { context, calls } = mockContext()
  apply(context)
  const result = calls.commands[0].handler({
    rawInput: '',
    attachments: [],
    agent: {},
    commandId: 'test',
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(calls.opened, ['session-manager'])
})

test('a host that never mounts the seams leaves the plugin completely idle', () => {
  const { context, calls } = mockContext({ seams: false })
  apply(context)

  assert.deepEqual(calls.injected, [['tuiScenes', 'commands']])
  assert.equal(calls.scenes.length, 0, 'no scene without the seam')
  assert.equal(calls.commands.length, 0, 'no command without the seam')
  assert.equal(calls.effects.length, 0, 'nothing to dispose')
})

test('a failing open reports an error instead of a silent no-op', () => {
  const { context, calls, scenes } = mockContext()
  apply(context)
  scenes.open = () => false
  const result = calls.commands[0].handler({ rawInput: '', attachments: [], agent: {}, commandId: 'x', signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
})

/** React stub: enough for the scene to build a tree and run its hooks once. */
function stubReact() {
  const states = []
  return {
    states,
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children } }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      states.push(value)
      return [value, () => {}]
    },
    useEffect() {},
  }
}

test('the scene renders through the injected React only', () => {
  const React = stubReact()
  const Box = 'Box'
  const Text = 'Text'
  const ui = {
    Box,
    Text,
    useInput() {},
    useTerminalSize: () => ({ columns: 100, rows: 30 }),
  }
  const channel = {
    listSessions: async () => [
      {
        id: 'ses_aaaaaaaaaaaa',
        kind: 'session',
        title: { text: 'first session', source: 'auto' },
        cwd: '/home/dev',
        createdAt: 1,
        updatedAt: Date.now(),
        hasPrompt: true,
      },
    ],
    deleteSession: async () => true,
  }
  const component = createSessionManagerScene()
  const tree = component({ React, ui, channel, close() {} })

  assert.equal(tree.type, Box)
  // Header is rendered even before the async list resolves.
  const header = tree.props.children[0]
  assert.equal(header.type, Box)
})

test('sweep skips unsafe ids and reports a dry run without touching disk', () => {
  const result = sweepSessions(['../../etc/passwd', 'ok_id-1'], { dryRun: true })
  assert.deepEqual(result.skipped, ['../../etc/passwd'])
  assert.equal(result.errors.length, 0)
  assert.match(result.summary, /dry run/)
})

test('sweep accepts an empty list as a no-op', () => {
  const result = sweepSessions([], { dryRun: true })
  assert.equal(result.summary, 'nothing to sweep')
})

// ── empty artifacts ────────────────────────────────────────────────────────
//
// Samples below mirror real summaries: the 312 B / 466 B rows are boot
// artifacts (four metadata frames, read back from
// `$DSH_HOME/sessions/<projectKey>/<id>/session.v4.jsonl.zstd`), the 173975 B
// row is a session that holds a real conversation.

/** A host summary as `listSummaries()` emits it (`kind` is an OBJECT). */
function summary(overrides = {}) {
  return {
    id: '8dd9e72a-d184-419a-9df9-2fbd450db4a7',
    kind: { kind: 'root' },
    title: { text: 'my-project', source: 'fallback' },
    cwd: '/home/dev',
    createdAt: 1790508544315,
    updatedAt: 1790508544322,
    bytes: 312,
    hasPrompt: false,
    ...overrides,
  }
}

test('a never-used boot artifact is recognised as empty', () => {
  assert.equal(isEmptyArtifact(summary()), true)
  assert.equal(isEmptyArtifact(summary({ bytes: 466 })), true)
  assert.equal(isEmptyArtifact(summary({ bytes: 4095 })), true)
})

test('a session with a conversation is never treated as empty', () => {
  const real = summary({
    id: 'd2bc1db7-bfd9-4939-aeb0-a5e33a915323',
    title: { text: 'Redesign the report parser', source: 'auto' },
    bytes: 173975,
    hasPrompt: true,
  })
  assert.equal(isEmptyArtifact(real), false)
  // Each of the three conditions alone is enough to keep a session listed.
  assert.equal(isEmptyArtifact({ ...real, hasPrompt: false }), false, 'auto title spares it')
  assert.equal(isEmptyArtifact({ ...real, bytes: 312 }), false, 'hasPrompt true spares it')
  assert.equal(isEmptyArtifact(summary({ bytes: 4096 })), false, 'at the ceiling it is listed')
})

test('an unreadable log is listed, not condemned', () => {
  // The host reports `hasPrompt: true` and `bytes: undefined` when it cannot
  // prove anything; hiding a real session is the worse error.
  assert.equal(isEmptyArtifact(summary({ bytes: undefined })), false)
  assert.equal(isEmptyArtifact(summary({ hasPrompt: true })), false)
  assert.equal(isEmptyArtifact(summary({ title: { text: 'my-project' } })), false, 'missing source')
  assert.equal(isEmptyArtifact(null), false)
  assert.equal(isEmptyArtifact(undefined), false)
})

test('subagent logs are excluded however small they are', () => {
  // `classify()` returns an object; the old string compare never matched.
  assert.equal(isEmptyArtifact(summary({ kind: { kind: 'subagent', depth: 1 } })), false)
  assert.equal(isEmptyArtifact(summary({ kind: 'subagent' })), false)
  // A fork of a real session keeps its own prompt evidence.
  assert.equal(isEmptyArtifact(summary({ kind: { kind: 'fork', parent: 'x' } })), true)
})

/**
 * A one-pass hooks harness: persistent `useState` slots plus captured
 * `useEffect` / `useInput` callbacks, so a test drives the scene render by
 * render instead of mounting a reconciler.
 */
function hooksHarness() {
  const states = []
  const effects = []
  const inputs = []
  let index = 0
  return {
    inputs,
    /** Restart the hook cursor; the call order must be identical every pass. */
    begin() {
      index = 0
    },
    /** Run the captured effects and let their microtasks settle. */
    async settle() {
      for (const effect of effects) {
        const cleanup = effect?.()
        if (typeof cleanup === 'function') cleanup
        await Promise.resolve()
      }
      await new Promise((resolve) => setImmediate(resolve))
    },
    React: {
      createElement(type, props, ...children) {
        return { type, props: { ...(props ?? {}), children } }
      },
      useState(initial) {
        const slot = index++
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial
        return [
          states[slot],
          (next) => {
            states[slot] = typeof next === 'function' ? next(states[slot]) : next
          },
        ]
      },
      useEffect(callback) {
        effects[index++] = callback
      },
    },
  }
}

/** Every text node in a tree built by the harness above. */
function textsOf(node, out = []) {
  if (node === undefined || node === null) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) textsOf(node.props.children, out)
  return out
}

test('e cycles all → empty → hide-empty and the header says which view is on', async () => {
  const harness = hooksHarness()
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useInput(callback) {
      harness.inputs.push(callback)
    },
    useTerminalSize: () => ({ columns: 100, rows: 30 }),
  }
  const emptySession = summary()
  const realSession = summary({
    id: 'd2bc1db7-bfd9-4939-aeb0-a5e33a915323',
    title: { text: 'Redesign the report parser', source: 'auto' },
    bytes: 173975,
    hasPrompt: true,
  })
  const channel = {
    listSessions: async () => [emptySession, realSession],
    deleteSession: async () => true,
  }
  const component = createSessionManagerScene()
  const draw = () => {
    harness.begin()
    return component({ React: harness.React, ui, channel, close() {} })
  }
  const press = (input, key = {}) => harness.inputs.at(-1)(input, key)

  draw()
  await harness.settle()

  const browse = textsOf(draw()).join('\n')
  assert.match(browse, /2 total · 1 empty · 0 selected/)
  assert.match(browse, /empty·312B/, 'the empty row carries its size')
  assert.ok(!browse.includes('[empty only]'))

  press('e')
  const onlyEmpty = textsOf(draw()).join('\n')
  assert.match(onlyEmpty, /\[empty only\]/)
  assert.match(onlyEmpty, /my-project/)
  assert.ok(!onlyEmpty.includes('Redesign'), 'the real session is filtered out')

  press('e')
  const withoutEmpty = textsOf(draw()).join('\n')
  assert.match(withoutEmpty, /\[no empty\]/)
  assert.ok(!withoutEmpty.includes('empty·312B'), 'the artifact is hidden')
  assert.match(withoutEmpty, /Redesign/)

  press('e')
  assert.ok(!textsOf(draw()).join('\n').includes('[empty'), 'back to the unfiltered view')
})

test('the filter narrows what a (select all) covers', async () => {
  const harness = hooksHarness()
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useInput(callback) {
      harness.inputs.push(callback)
    },
    useTerminalSize: () => ({ columns: 100, rows: 30 }),
  }
  const emptySession = summary()
  const realSession = summary({
    id: 'd2bc1db7-bfd9-4939-aeb0-a5e33a915323',
    title: { text: 'real work', source: 'auto' },
    bytes: 173975,
    hasPrompt: true,
  })
  const deleted = []
  const channel = {
    listSessions: async () => [emptySession, realSession],
    deleteSession: async (id) => {
      deleted.push(id)
      return true
    },
  }
  const component = createSessionManagerScene({ sweep: false })
  const draw = () => {
    harness.begin()
    return component({ React: harness.React, ui, channel, close() {} })
  }
  const press = (input, key = {}) => harness.inputs.at(-1)(input, key)

  draw()
  await harness.settle()
  press('e') // empty only
  draw()
  press('a') // select all visible
  draw()
  press('d') // ask
  draw()
  press('y') // confirm
  await harness.settle()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(deleted, [emptySession.id], 'only the artifact was selected and deleted')
  assert.match(textsOf(draw()).join('\n'), /deleted 1/)
})
