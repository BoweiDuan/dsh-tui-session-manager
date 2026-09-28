# dsh-tui-session-manager

给 dsh-TUI 用的会话管理插件：一条 `/sessions` 命令打开全屏会话管理器，能按工作区分组浏览、过滤、多选，然后**真正删除**会话 —— 并且把宿主删除路径留下的状态残留一并清掉。

## 为什么需要它

dsh-TUI 0.11.x 的适配层其实**已经实现了真正的删除**：

```js
channel.deleteSession(sessionId)
```

它会递归删除会话日志目录 `$DSH_HOME/sessions/<workspace>/<id>/`，并清掉 `/resume` 标记、`last-used.json` 与 agent-view 记录。问题是：**没有任何 UI 调用它** —— 命令表、`/resume` 选择器、工作区菜单里都没有入口（全包搜索 `deleteSession` 只能找到定义与策略声明，找不到渲染层调用方）。

本插件不重写删除逻辑，只补上缺失的入口，并顺手清理宿主删除路径不碰的四处残留：

| 位置 | 内容 |
| --- | --- |
| `$DSH_HOME/storages/session_projcache/sessions/<id>.json` | DSH 投影缓存 |
| `$DSH_HOME/storages/workspace.json` | `tables.workspaces[*].sessionIds`、`global.archivedSessionIds` |
| `$DSH_TUI_HOME/session-index.json` | `entries[id]` 标题缓存 |
| `$DSH_TUI_HOME/session-mounts.json` | `owners[*].sessionIds` |

`last-used.json` 与 `agent-view-sessions.json` 也会被清扫一次：宿主已经清过，重复清理是幂等的，只作为宿主行为变化时的兜底。

## 安装

插件是零构建纯 ESM（无 TypeScript、无打包步骤），装进 `dsh-tui` profile 即可：

```sh
dsh plugin --profile dsh-tui add /Users/duanbowei/dsh-tui-session-manager
```

装完重启 `dsh-tui`（profile 的 `patchReload: live` 也可能让它热加载）。卸载：

```sh
dsh plugin --profile dsh-tui remove dsh-tui-session-manager
```

## 用法

在对话里输入：

```
/sessions
```

全屏管理器打开，对话保持干净（命令返回静默成功）。

| 按键 | 作用 |
| --- | --- |
| `↑` `↓` / `k` `j` | 移动光标 |
| `space` / `x` / `enter` | 勾选或取消当前会话 |
| `a` | 全选 / 全不选 |
| `d` | 删除已勾选（先弹 `y` / `n` 确认） |
| `/` | 输入过滤词（匹配标题、工作目录、id） |
| `e` | 循环过滤：全部 → 只看空壳 → 隐藏空壳 |
| `esc` | 退出过滤 / 取消确认 / 关闭面板 |

删除结果会在底部汇总：`deleted N, refused M`。**当前正在使用的会话会被宿主拒绝**（与宿主语义一致，不是本插件的限制）。`refused` 也覆盖日志已丢失的情况。

## 空会话（引导空壳）

DSH 的「新建会话」是**立即落盘**的：TUI 进程启动、切换工作区
（`workspace-actions.js` 的 `switchWorkspace` → `newSession`）或 `/new` 之后，
会话日志就已经存在。若随后 `/resume` 到别处或直接退出，它就留成一个
**只有 4 条元数据帧、0 条消息**的空壳，标题回退成目录名。

`e` 键可一键筛出它们，`a` 全选 + `d` 批量删除。判定口径保守（三个条件全中才算）：

```
kind !== 'subagent'                 子代理天然无人类消息，排除
&& hasPrompt === false              有内容或日志不可读时为 true
&& bytes < 4096                     4 条元数据帧约 312~466 B
&& title.source === 'fallback'      标题仍是目录名回退
```

任何一项不确定（`bytes` 缺失、来源非 `fallback`）都**不判为空** —— 宁可漏掉一个空壳，
也不隐藏或误删一个有内容的会话。空壳行尾会显示 `empty·312B` 便于判断体积。

## 安全约束

- 会话 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]*$` 才会被当作文件名或 map 键使用，其它一律跳过并报告。
- 每次清扫在首次改动某个 JSON 文件前备份为 `<file>.bak-sweep-<YYYYMMDD-HHMMSS>`。
- 无法解析的 JSON 文件原样保留，不做猜测性修改。
- 清扫过程不抛异常：单个步骤失败计入结果行，不影响其它步骤。

## 结构

```text
index.js            插件契约（name / apply）：注册 /sessions 命令与全屏场景
scene.js            全屏管理器界面（使用宿主注入的 React 与 ui kit）
sweep.js            残留清扫（可 dryRun）
cordis.patch.yml    向 profile 插入插件行
test/               契约测试与清扫落盘测试
docs/superpowers/specs/   设计说明
```

## 测试

```sh
npm test
```

覆盖：命令/场景注册与注销、无声成功返回、缺接缝时保持 idle、场景只依赖注入的 React、
id 白名单与 `dryRun`、以及在临时 `$DSH_HOME` / `$DSH_TUI_HOME` 上真实落盘的清扫
（缓存文件删除、五处索引剪枝、备份文件生成、无法解析的文件原样保留）。

## 已知边界

- 插件通过 `ctx.tuiScenes`（`tui.scene` 扩展）与 `ctx.commands` 接线，两者都做软探测：宿主不提供时插件保持 idle，不会让启动失败。
- 场景只使用 `props.React` 与 `props.ui`，不引入自带 React —— TUI 的 reconciler 只认宿主自己的 React 19 元素。
- 删除**不可撤销**（没有回收站）：勾选时请看清，确认时 `y` 是唯一入口。
