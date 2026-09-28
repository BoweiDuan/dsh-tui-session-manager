# dsh-tui 会话管理插件 — 空会话过滤 设计说明

日期：2026-09-28
状态：已实施
目标 profile：`dsh-tui`

## 问题

DSH 的「新建会话」是**立即落盘**的：会话一旦创建，日志目录与 4 条元数据帧
（`session` / `permission/preset` / `sandbox/mode` / `approval/policy`）就已经存在，
并被登记进 `session-index.json`、`agent-view-sessions.json`、`last-used.json`。
若用户随后 `/resume` 到别的会话、切换工作区或直接退出，这个会话就永久留成
**空壳**（0 条消息），在 `/sessions` 与 `/resume` 列表里以回退标题（目录名）示人。

产生入口（已核实）：

- TUI 进程启动时的引导会话（`session-mounts.json` 中 `pid.startedAt` 与该会话
  `createdAt` 相差 1ms 可证）。
- 切换工作区：`dsh-adapter/channel/workspace-actions.js:68`
  → `deps.newSession({ cwd: target })`。
- `/new` 命令：`screens/Chat.js:1571-1576`。

实测占用（2026-09-28，本机）：

| 项目 | 实测 |
| --- | --- |
| 空壳日志本身 | 6 个，合计 2080 B |
| `sessions/` 总占用 | 9.26 MB（大头是活跃日志，单个 0.2~1.4 MB） |
| 备份/杂项（`*.bak-*`） | 24 个，合计 4.31 MB |
| `storages/session_projcache` | 330 KB |
| `session-index.json` | 5.2 KB / 14 条，幽灵条目 0 |

结论：空壳**不影响磁盘与性能**（宿主 `listSessions` 有 `revision` 缓存，
空壳 312 B 的 digest 开销可忽略），影响的是列表噪音与误删风险。

宿主 summary 已自带判定所需字段（`dsh-adapter/sessions/list.js:287-303`）：
`hasPrompt`（无人类消息为 false，日志不可读时保守给 true）、
`bytes`、`title{ text, source }`、`kind`。因此**无需解压日志**。

## 目标

1. `/sessions` 面板提供三态过滤：全部 → 只看空壳 → 隐藏空壳（`e` 键循环）。
2. 判定口径保守：宁漏不误杀，绝不把有内容的会话标成空壳。
3. 顺手修正 `kind` 判定缺陷：`classify()` 返回对象，原代码按字符串比较，
   导致 `sub` 标签从未生效，且子代理会话（天然无人类消息）有被误判成空壳的风险。
4. 不引入任何新依赖、不读取会话日志、不改删除语义。

非目标：自动/后台清理空壳（删除不可撤销，误杀代价高于收益）；
按体积阈值做"归档"；清理 `*.bak-*` 备份（属另一件事，插件不碰日志目录之外的文件）。

## 判定口径

三个条件**全部**满足才算空壳：

```js
kindOf(session) !== 'subagent'        // 子代理天然无人类消息，排除
&& session.hasPrompt === false         // 有内容/不可读时为 true，排除
&& typeof session.bytes === 'number'
&& session.bytes < 4096                // 4 个元数据帧约 312~466 B，留足余量
&& session.title?.source === 'fallback' // 标题仍是目录名回退
```

`bytes` 缺失（读不到日志）或 `title.source` 非 `fallback` 一律**不算**空壳。

`kindOf()` 同时兼容宿主两种形态：对象 `{ kind, parent, depth }`（`classify()` 的真实
返回）与字符串（若宿主某版本展平）。

## 交互

| 按键 | 作用 |
| --- | --- |
| `e` | 循环过滤：`all` → `empty` → `hide-empty` → `all` |
| 其余 | 与既有键位一致（`↑↓`/`jk` 移动、`space` 勾选、`a` 全选、`d` 删除、`/` 搜索、`esc` 关闭） |

- 头部状态行：`14 total · 6 empty · 2 selected · [empty only]`。
- 空壳行尾标签：`empty·312B`（带体积，便于判断值不值得删）。
- 过滤先于搜索：模式过滤后，`/` 搜索词再叠加；`a` 全选只作用于当前可见集。
- 空态文案区分三种：无存储会话 / 无空壳 / 无匹配搜索结果。

## 测试

`test/session-manager.test.mjs` 追加 `isEmptyArtifact` 用例，样本取自本机真实会话：

- 312 B / 466 B 的引导空壳 → 判空。
- 173975 B 的正常会话 → 判非空。
- `bytes` 缺失、`hasPrompt` 为 `true`、`title.source === 'auto'`、
  `kind` 为对象 `{ kind: 'subagent' }` → 均判非空。

## 风险

- 判定依赖宿主字段名。宿主把 `bytes` / `title.source` 改名会使过滤退化为
  "全部显示"（保守失败，不会误删）。
- `empty` 视图下 `a` + `d` 会批量真删且不可撤销，确认页仍需 `y`。
