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
import { test } from 'node:test'

import { apply } from '../index.js'
import { sweepSessions } from '../sweep.js'
import { createSessionManagerScene } from '../scene.js'

/** Minimal host context stub recording every seam interaction. */
function mockContext() {
  const calls = {
    scenes: [],
    commands: [],
    effects: [],
    opened: [],
    disposed: [],
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
  const context = {
    logger: { warn() {} },
    get(name) {
      if (name === 'tuiScenes') return scenes
      if (name === 'commands') return commands
      return undefined
    },
    effect(factory) {
      calls.effects.push(factory)
    },
  }
  return { context, calls, scenes, commands }
}

test('apply registers exactly one scene and one command', () => {
  const { context, calls } = mockContext()
  apply(context)

  assert.equal(calls.scenes.length, 1)
  assert.equal(calls.scenes[0].descriptor.id, 'session-manager')
  assert.equal(typeof calls.scenes[0].descriptor.component, 'function')
  // The scene must be registered as the plugin's own effect (ledger identity).
  assert.equal(calls.scenes[0].identity, context)

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

test('a host without the scene/command seams leaves the plugin idle', () => {
  let warnings = 0
  apply({
    get: () => undefined,
    logger: {
      warn() {
        warnings += 1
      },
    },
    effect() {
      throw new Error('idle plugin must not register effects')
    },
  })
  assert.equal(warnings, 1)
})

test('a failing open reports an error instead of a silent no-op', () => {
  const { context, calls } = mockContext()
  apply(context)
  const scenes = context.get('tuiScenes')
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
        cwd: '/Users/duanbowei',
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
