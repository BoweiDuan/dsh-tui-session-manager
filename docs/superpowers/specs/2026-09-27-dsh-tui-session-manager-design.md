# dsh-tui 会话管理插件 — 设计说明

日期：2026-09-27
状态：已实施
目标 profile：`dsh-tui`

## 问题

dsh-TUI 0.11.x 没有删除会话的界面入口。用户此前只能用 `~/.dsh/delete-session.py`、
`~/.dsh/purge-sessions.py` 这类离线脚本手工清理，而且必须由用户自己搞清到底
有哪些状态文件持有会话 id。

代码事实（已核实）：

- `channel.deleteSession(sessionId)` 已在适配层完整实现（`dsh-adapter/channel/
  session-metadata.js`）：删除会话日志目录、写 resume 标记清除、`forgetSession`、
  `forgetAgentView`。
- 该方法在 `ui-policy` 中登记为 `mutate`，在 `action-readiness` 与 `session-metadata`
  中都可达；但**全包搜索找不到任何 UI 调用方** —— 没有按键、没有命令、没有菜单项。
- 因此缺的是入口，不是能力。重写删除逻辑既危险又没意义。

## 目标

1. 提供一条 `/sessions` 命令，打开全屏会话管理器。
2. 支持浏览（按工作区分组）、过滤（标题/工作目录/id）、多选、批量删除。
3. 删除复用宿主语义（`channel.deleteSession`），当前会话被宿主拒绝时不越权。
4. 删除成功后，清理宿主删除路径不触碰的残留，杜绝幽灵条目。
5. 不做回收站：删除即真删，但确认流程必须明确（勾选 → 确认 → 执行）。

非目标：重命名、会话预览、切换会话、归档管理。这些是宿主已有功能或后续版本的事。

## 架构

```text
/sessions 命令 (ctx.commands)
    │  handler → ctx.tuiScenes.open('session-manager')
    ▼
全屏场景 (ctx.tuiScenes, extension tui.scene)
    │  props: { React, ui, channel, close }
    │  channel.listSessions()          ← 宿主：读会话摘要
    │  channel.deleteSession(id)       ← 宿主：真删日志与宿主侧索引
    ▼
残留清扫 (sweep.js, node:fs)
    $DSH_HOME/storages/session_projcache/sessions/<id>.json
    $DSH_HOME/storages/workspace.json
    $DSH_TUI_HOME/session-index.json
    $DSH_TUI_HOME/session-mounts.json
    $DSH_TUI_HOME/last-used.json          (幂等兜底)
    $DSH_TUI_HOME/agent-view-sessions.json (幂等兜底)
```

### 部件职责

| 部件 | 职责 | 依赖 |
| --- | --- | --- |
| `index.js` | 插件契约：软探测 `ctx.tuiScenes` / `ctx.commands`，注册场景与命令，用 `ctx.effect` 管理注销 | Cordis ctx |
| `scene.js` | 全屏 UI 与交互状态机；只通过 props 拿宿主 React 与 ui kit | `props.React`、`props.ui`、`props.channel` |
| `sweep.js` | 纯函数式残留清扫，可 `dryRun`，不抛异常 | `node:fs`、`node:os`、`node:path` |
| `cordis.patch.yml` | 向 profile 插入插件行 | — |

### 数据流

1. 场景挂载 → `channel.listSessions()` 取 `SessionSummary[]`（id、title、cwd、
   updatedAt、kind、hasPrompt）。
2. 按 `cwd` 分组，组内按 `updatedAt` 降序，组间按最新活动降序。
3. 用户勾选 → 确认 → 逐个 `await channel.deleteSession(id)`。
4. 宿主返回 `true` 的 id：从列表移除，并调用 `sweepSessions([id])`。
5. 汇总行展示 `deleted N, refused M`；`busy` 阶段吞掉所有按键，避免重入。

### 关键约束

- **React 身份**：场景组件必须用 `props.React` 创建元素与调用 hooks。自带一份
  React 会因元素符号不匹配（`react.element` vs `react.transitional.element`）
  在首帧崩溃。本插件因此在 `scene.js` 中不 import React。
- **零构建**：纯 ESM JS，无 TS、无打包。宿主不要求插件有构建产物，零构建也避开
  了「装完没 build」的坑。
- **软探测**：`ctx.get('tuiScenes', false)` 与 `ctx.get('commands', false)`，缺失时
  记录一条 warn 并保持 idle，绝不让 profile 启动失败。

## 错误处理

- `listSessions()` 失败 → 列表区显示错误行，面板仍可 `esc` 退出。
- `deleteSession()` 抛错 → 记入报告行（`✗ id: 原因`），继续处理下一个。
- `deleteSession()` 返回 `false` → 报告为宿主拒绝（当前会话或日志缺失）。
- 清扫失败 → 报告行前缀 `!`，不影响宿主删除结果。
- 无权限写入状态文件 → 该文件记 `errors`，其余文件继续。

## 测试与验证

- `node --check` 三个模块。
- `sweepSessions([...], { dryRun: true })` 对真实 `$DSH_HOME` 干跑，断言：识别出的
  文件与索引点符合预期；含 `/` 或 `..` 的 id 落入 `skipped`。
- 装机后实测：`/sessions` 打开 → 勾选一个非当前会话 → `d` → `y` → 断言日志目录、
  projcache 文件消失，`workspace.json` / `session-index.json` /
  `session-mounts.json` 中该 id 消失，备份文件生成。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 插件在场景里直调 `channel.deleteSession` 被 kernel 授权层拦下 | 装机后立即实测；若被拦，改走 `ctx.tuiPluginHost` 的 mediated 注册通道 |
| 误删当前会话 | 宿主自身拒绝，插件不绕过 |
| 状态文件结构与版本相关 | 解析失败即原样保留；`dryRun` 可在改动前核验 |
| 并发写状态文件（另一个 TUI 进程） | 原子写（tmp + rename）；备份文件名带时间戳 |
