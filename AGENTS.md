# dsh-tui-session-manager — local rules

A dsh-TUI ecosystem plugin that contributes a `/sessions` full-screen scene for
browsing and deleting stored sessions.

- Keep the ESM contract: `name` / `apply` named exports, no default export,
  `.js` suffixes on relative imports, no build step and no runtime dependencies.
- `index.js` wires the seams; it must stay free of UI concerns. `scene.js` is the
  scene and owns the artifact heuristic. `sweep.js` owns state-file cleanup.
- The scene may only use the host-injected `props.React` and `props.ui` — never
  import React (the TUI reconciler accepts only its own React 19 elements).
- Keep both seams soft: a host without `tuiScenes` / `commands` must leave the
  plugin idle instead of failing boot.
- Any new host-field dependency must degrade conservatively: when in doubt, a
  session is real, listed, and never selected for deletion.
- `npm test` must stay green and dependency-free before any push.
- Do not commit, tag, or publish without an explicit user request.
