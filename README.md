# dsh-tui-session-manager

给 dsh-TUI 的会话管理器：一条 `/sessions` 命令打开全屏面板，按工作区分组浏览、
过滤、多选，然后**真正删除**保存的会话 —— 并把宿主删除路径留下的状态残留一并清掉。

A session manager for dsh-TUI: `/sessions` opens a full-screen browser grouped by
workspace, with filtering, multi-select and **real deletion** — including the state
leftovers the host's own delete path does not touch.

## 为什么需要它 / Why

dsh-TUI 0.11.x 的适配层其实**已经实现了真正的删除**（`channel.deleteSession(id)`：
递归删除会话日志目录、清 resume 标记、`last-used.json` 与 agent-view 记录），
但**没有任何 UI 调用它** —— 命令表、`/resume` 选择器、工作区菜单里都没有入口。
缺的是入口，不是能力。本插件不重写删除逻辑，只补上入口。

两件常被问到的事，这里一次说清：

- **列表里的空会话从哪来？** DSH 的「新建会话」是**立即落盘**的：TUI 进程启动、
  切换工作区（`switchWorkspace` → `newSession`）或 `/new` 之后，会话日志就已经存在。
  若随后 `/resume` 到别处或直接退出，它就留成一个只有 4 条元数据帧、0 条消息的
  **空壳**，标题回退成目录名。按 `e` 可一键筛出它们。
- **这些空壳占空间吗？** 不占。每个约 312~466 B，宿主列表还有 `revision` 缓存。
  真正占空间的是历史调试留下的 `*.bak-*` 备份，那是另一回事。

## 功能 / Features

- `/sessions` 全屏管理器：按工作区分组、`/` 实时过滤（标题 / 工作目录 / id）。
- `e` 三态过滤：全部 → 只看空壳 → 隐藏空壳。
- 空壳行标注体积（`empty·312B`），头部显示总数、空壳数与当前视图。
- 多选批量删除（`a` 全选当前可见集），删除前 `y`/`n` 确认。
- 删除后清扫宿主不碰的四处残留，杜绝 `/resume` 里的幽灵条目。
- 无构建、无运行时依赖、纯 ESM：装进 profile 即用。

## 安装 / Install

```sh
git clone https://github.com/BoweiDuan/dsh-tui-session-manager.git
dsh plugin --profile dsh-tui add ./dsh-tui-session-manager
```

装完重启 dsh-tui（profile 的 `patchReload: live` 也可能让它热加载）。卸载：

```sh
dsh plugin --profile dsh-tui remove dsh-tui-session-manager
```

## 用法 / Usage

在对话里输入：

```
/sessions
```

全屏管理器打开，对话保持干净（命令返回静默成功）。

| 按键 | 作用 |
| --- | --- |
| `↑` `↓` / `k` `j` | 移动光标 |
| `space` / `x` / `enter` | 勾选或取消当前会话 |
| `a` | 全选 / 全不选（仅当前可见集） |
| `d` | 删除已勾选（先弹 `y` / `n` 确认） |
| `/` | 输入过滤词（匹配标题、工作目录、id） |
| `e` | 循环过滤：全部 → 只看空壳 → 隐藏空壳 |
| `esc` | 退出过滤 / 取消确认 / 关闭面板 |

清理空壳的标准动作：`/sessions` → `e` → `a` → `d` → `y`。

删除结果在底部汇总：`deleted N, refused M`。**当前正在使用的会话会被宿主拒绝**
（与宿主语义一致，不是本插件的限制）。`refused` 也覆盖日志已丢失的情况。

## 空会话判定 / Empty artifacts

只有**三个条件全部满足**才算空壳（保守：宁可漏掉一个，也不隐藏或误删有内容的会话）：

```js
kind !== 'subagent'                  // 子代理天然无人类消息，排除
&& hasPrompt === false               // 宿主证明没有人类消息；日志不可读时为 true
&& bytes < 4096                      // 4 条元数据帧约 312~466 B
&& title.source === 'fallback'       // 标题仍是目录名回退
```

`bytes` 缺失、标题来源非 `fallback`、kind 无法识别 —— 一律**不判为空**。
判定只读宿主 `channel.listSessions()` 已给出的摘要字段，**不读会话日志**。

## 安全 / Safety

- 会话 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_-]*$` 才会被当作文件名或 map 键使用，
  其它一律跳过并报告。
- 每次清扫在首次改动某个 JSON 文件前备份为 `<file>.bak-sweep-<YYYYMMDD-HHMMSS>`。
- 无法解析的 JSON 原样保留，不做猜测性修改。
- 清扫过程不抛异常：单步失败计入结果行，不影响其它步骤。
- 删除**不可撤销**（没有回收站）：勾选时请看清，确认时 `y` 是唯一入口。

## 兼容 / Compatibility

- dsh-TUI 0.11.x；接缝 `ctx.tuiScenes`（全屏场景）与 `ctx.commands`（斜杠命令）。
- 两者都做软探测：宿主不提供时插件保持 idle，不会让启动失败。
- 场景只使用宿主注入的 `props.React` 与 `props.ui`，不引入自带 React
  （TUI 的 reconciler 只认宿主自己的 React 19 元素）。
- Node `^22.19 || >=24`。

## 开发 / Development

```sh
npm test        # node --test，无依赖、无构建
```

测试覆盖：命令/场景注册与注销、无声成功返回、缺接缝时保持 idle、
空壳判定的四个条件与边界、`e` 三态过滤、`a` 只作用于可见集、
id 白名单与 `dryRun`、以及在临时 `$DSH_HOME` / `$DSH_TUI_HOME` 上真实落盘的清扫。

## 结构 / Layout

```text
index.js            插件契约（name / apply）：注册 /sessions 命令与全屏场景
scene.js            全屏管理器界面 + 空壳判定（使用宿主注入的 React 与 ui kit）
sweep.js            删除后的残留清扫（支持 dryRun）
debug.js            诊断日志（$DSH_TUI_HOME/session-manager.log，64 KiB 上限）
cordis.patch.yml    向 profile 插入插件行
test/               契约测试、判定测试与清扫落盘测试
docs/design/        设计说明
```

## 许可 / License

[MIT](LICENSE) © 2026 BoweiDuan
