/**
 * dsh-tui-session-manager — a session manager for the dsh-TUI front end.
 *
 * Why this plugin exists
 * ----------------------
 * dsh-TUI's adapter already implements real session deletion
 * (`channel.deleteSession(id)`: removes the session's log directory, its
 * last-used entry, its agent-view entry and the resume marker), but 0.11.x
 * ships no UI caller for it. This plugin does not reimplement deletion: it
 * contributes the missing entry point — a `/sessions` command that opens a
 * full-screen scene built on top of the host's own channel API.
 *
 * Seams used
 * ----------
 * - `ctx.tuiScenes` (extension `tui.scene`): register + open a full-screen
 *   scene. The scene receives the host's React, its ui kit and the live
 *   channel, so the plugin owns no React copy and no rendering internals.
 * - `ctx.commands`: register the `/sessions` slash command whose handler
 *   opens the scene and returns a silent success, leaving the conversation
 *   untouched.
 *
 * Both seams are soft-probed (`ctx.get(name, false)`): a host without them —
 * an older dsh-TUI, or a profile launched without the scene row — leaves the
 * plugin idle instead of failing boot.
 *
 * @module dsh-tui-session-manager
 */

import { createSessionManagerScene } from './scene.js'

/** Cordis plugin name (the row's local identity). */
export const name = 'dsh-tui-session-manager'

/** Scene id registered with the host; `/sessions` opens exactly this id. */
const SCENE_ID = 'session-manager'

/**
 * Wire the plugin into the composed host context.
 *
 * @param {object} ctx - Cordis context with the dsh-TUI bundle composed.
 * @returns {void}
 */
export function apply(ctx) {
  const scenes = ctx.get('tuiScenes', false)
  const commands = ctx.get('commands', false)
  if (scenes === undefined || commands === undefined) {
    ctx.logger?.warn?.(
      '[session-manager] ctx.tuiScenes or ctx.commands is unavailable — session manager stays idle',
    )
    return
  }

  const component = createSessionManagerScene()

  // Scene registration is effect-owned: unloading the plugin row withdraws
  // the scene, and a later re-composition registers it again.
  const disposeScene = scenes.register(
    {
      id: SCENE_ID,
      title: 'Sessions',
      component,
    },
    ctx,
  )
  ctx.effect(() => disposeScene, 'session-manager scene')

  const disposeCommand = commands.register({
    name: 'sessions',
    description: 'Browse and delete saved sessions',
    handler: () => {
      const opened = scenes.open(SCENE_ID)
      if (!opened) {
        return { kind: 'error', text: `session-manager: scene "${SCENE_ID}" is not registered` }
      }
      // Silent success: the scene replaces the screen, the conversation stays clean.
      return { kind: 'success' }
    },
  })
  ctx.effect(() => disposeCommand, 'session-manager command')
}

export default { name, apply }
