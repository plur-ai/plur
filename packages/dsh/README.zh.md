# @plur-ai/dsh

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供持久记忆。周一纠正过的事，周二依然记得。**

[English](README.md) | 中文

把记忆作为工具暴露出来是常见做法——模型仍然需要自己决定要不要调用它。
本插件直接把记忆本身放进提示词。

## 概述

DeepSeek Harness 每次开启新会话时对你一无所知。你得把昨天已经解释过的约定、
纠正和偏好重新解释一遍。

本插件让 dsh 拥有能跨会话存活的记忆：你只纠正一次的内容、项目约定，以及这些
决定背后的原因。适合任何在同一个代码库中不止一次用 dsh 做实际工作的人。

所有内容都以纯 YAML 保存在你自己的机器上，可读、可改、可删。

## 兼容性

| | |
|---|---|
| DeepSeek Harness | `0.1.0-rc.6` 及 `0.1.x` 线上的后续版本（`^0.1.0-rc.6`） |
| Cordis | `^4.0.1` |
| Node | 20、22、24、26（四个版本均在 CI 中测试） |
| 最近验证 | dsh `0.1.0-rc.6`，2026-08-15 |

dsh 仍处于 1.0 之前且演进很快。peer 版本范围使用 caret，以便本插件能随该版本线
继续安装；如果未来某个版本改变了宿主契约，本插件会退化为「无记忆」，而不会让你
的 agent 崩溃——每一处宿主注册都做了包裹，`/plur` 会显示失败情况。

## 安装

```sh
dsh plugin --profile web add @plur-ai/dsh
```

就这样。重启 `dsh`，你的 agent 就有记忆了。

需要 [`@plur-ai/core`](https://www.npmjs.com/package/@plur-ai/core)，会一并安装。

## 快速上手

先教它一次：

> **你：** 这个项目一律用 pnpm——`npm install` 会破坏 CI 里的 lockfile。

之后不需要任何操作；这条纠正会被自动识别并存储。第二天在同一个目录下开启新会话：

> **你：** 这里怎么安装依赖？
>
> **Agent：** 用 `pnpm install`——你提到过 npm 会破坏 CI 里的 lockfile。

不需要提醒，也不需要工具调用。想看它记住了什么，运行 `/plur-memory`。

## 卸载

```sh
dsh plugin --profile web remove @plur-ai/dsh
```

你的记忆不会被动到——它们独立于本插件保存在 `~/.plur`，其他所有 PLUR 集成仍然
可以使用。如果也想删除它们，删掉该目录即可；若只想删除单条 engram，使用
`plur_forget` 或 [`@plur-ai/cli`](https://www.npmjs.com/package/@plur-ai/cli)。

想暂时停用而不卸载，把 `injectionMode` 设为 `off`（见下）。

## 工作原理

PLUR 注册一个系统提示词分区（system-prompt section），DeepSeek Harness 会在每次
请求时重新渲染它。相关记忆就直接*在那里*呈现在模型面前，不需要它决定是否调用工具。

召回运行在轮次主路径之外，因此记忆块从一次会话的第二次组装开始出现——任何一轮都
不会因为等待记忆存储而被拖慢。

| | 线索式记忆 | `@plur-ai/dsh` |
|---|---|---|
| 需要模型调用工具才能召回 | 是 | **否** |
| 每次召回多一次往返 | 是 | **否** |
| 模型忽略提示时仍然有效 | 否 | **是** |
| 每次请求计费的工具 schema 数 | 13 | **5** |

这个区别很重要：线索本质上是一场赌博。如果模型没有接住提示，那条记忆就等于不存在——
而"它为什么没记住？"正是摧毁用户对记忆系统信任的那个问题。已注入的内容无法被忽略。

而且不会累积：因为记忆是渲染出来的提示词分区，而不是追加到对话里的消息，
一百轮会话的开销与一轮会话相同。

## 为什么选择 PLUR

检索完全在本地完成——BM25 + BGE 向量，通过 Reciprocal Rank Fusion 融合。
零 API 调用，零云端，离线可用。存储是 `~/.plur` 下的纯 YAML，你可以随时查看、编辑、删除。

我们公开检索指标，基于 LongMemEval 测量：

在 LongMemEval-S 的 30 题冒烟子集上，PLUR 的检索在本插件所发布的配置下取得
**76.7% Hit@5**——hybrid BM25 + BGE 向量，不启用 reranker（core v0.9.13，
2026-06-27）。

n=30 是冒烟测试，不是排行榜：一道题就值 3.3 个百分点。可复现的测试工具与原始
运行结果见 [plur-bench](https://github.com/plur-ai/plur-bench)。

## 工具

只有五个，这是刻意的——dsh 会在每次请求时为每个已注册工具的 schema 计费。

| 工具 | 作用 |
|---|---|
| `plur_recall` | 在已注入内容之外做定向查找 |
| `plur_learn` | 存储纠正、偏好或长期有效的事实 |
| `plur_forget` | 淘汰错误或过时的记忆 |
| `plur_feedback` | 对记忆评分——训练下次浮现什么 |
| `plur_status` | 健康状况与本次会话的记忆活动 |

需要完整的约 40 个工具？可以同时或改用
[`@plur-ai/mcp`](https://www.npmjs.com/package/@plur-ai/mcp)。

## 命令

两个命令都不会消耗模型轮次。

| 命令 | 作用 |
|---|---|
| `/plur` | 记忆状态与本次会话的活动 |
| `/plur-memory` | 在浏览器中打开记忆查看器 |

## 记忆查看器

`/plur-memory` 会启动一个本地页面，列出全部 engram——学到了什么、实际被召回
了什么、以及召回了多少次。它只绑定回环地址，只读提供，并返回一个 URL：

```
PLUR memory viewer: http://127.0.0.1:53119/
(local to this machine, read-only)
```

与 `plur ui` 提供的是同一个页面，支持中文与英文。插件卸载时它会自动停止。

为什么是命令而不是标签页：dsh 的界面是基于类型化 slot 注册表组装的 React
客户端，做原生标签页就意味着要发布一个绑定其 1.0 前内部接口的浏览器构建产物。
一个 URL 不花什么代价，也不会在任何人升级时损坏。

## 权限与数据

PLUR 把一切存储在本地 `~/.plur` 并在本地检索。但被注入的记忆会成为
你的 agent 发送给**你所配置的模型提供方**的提示词的一部分——
对于默认的 DeepSeek Harness 安装，那就是 DeepSeek 的托管 API `api.deepseek.com`。

**写入**进入你当前所在工作区对应的 scope——如果项目自身的 `.plur.yaml` 声明了
scope 就用它，否则派生为 `project:<目录名>`。本插件学到的任何内容都不会写入
`global`。

**读取**是该 scope **加上你的 global engram**。这是 PLUR 自身的模型，并非本插件
额外引入：`global` 属于个人 scope，而个人 scope 会有意地通过所有按项目过滤的
读取——因此按 scope 召回时会包含它们。如果你的 global 库中有不希望编码 harness
看到的内容，请将其移到项目 scope，或显式设置 `scope`；用 `plur ui` 可以查看
里面到底有什么。

另有两点值得注意：

- scope 匹配是精确的，不会做层级展开。scope 为 `project:acme` 的会话不会读取
  `project:acme:api`。本插件自身的派生规则是扁平的，不会产生这类 scope，但如果
  你的库是通过 CLI 或 MCP 写入了层级子 scope，这里不会读到它们。
- 工作区的 `.plur.yaml` 会被原样信任。你克隆的仓库可以声明一个 scope，本插件
  在读写时都会采用它——`@plur-ai/core` 本身也是这样。请像检查任何你即将运行的
  文件一样检查它。

工作区自身 `.plur.yaml` 中声明的 scope 优先。下面的 `scope` 设置只在工作区未声明
时生效——可以设置它，也可以完全关闭注入：

```yaml
# $DSH_HOME/settings.yaml
plur:
  scope: project:acme     # 可选——省略则按工作区派生
  injectionMode: content  # 或者：off
```

## 配置

所有设置位于 `$DSH_HOME/settings.yaml`（通常是 `~/.dsh/settings.yaml`）的 `plur` 命名空间下。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `path` | `~/.plur` | 存储位置 |
| `scope` | 自动派生 | 本 harness 可读写的记忆 scope；省略时按工作区派生 |
| `injectionMode` | `content` | `content` 注入记忆；`off` 关闭注入 |
| `injectionBudget` | `2000` | 注入块的近似 token 上限 |
| `refreshIntervalMs` | `0` | 两次召回之间的下限；`0` 表示每轮一次 |
| `autoLearn` | `true` | 检测你消息中的纠正并存储 |
| `autoCapture` | `true` | 在轮次结束时记录情节摘要 |
| `timeoutMs` | `5000` | 单次记忆调用的硬超时 |
| `viewerEnabled` | `true` | 是否注册 `/plur-memory` 命令 |
| `includeGlobal` | `true` | global engram 是否随工作区 scope 一起读取 |

**关于 `reranker` 的提醒。** 它运行在 harness 自己的进程中，
`bge-reranker-v2-m3` 峰值内存约 2GB RSS。
交互式使用请保持 `off`；仅在崩溃无代价的本地批处理场景中启用。

## 故障排查

运行 `/plur` 或调用 `plur_status`。计数器会告诉你召回是否执行过、
记忆块是否发生变化、是否有错误被静默吞掉：

```
scope: project:acme
injection: content
refresh_attempted: 12
blocks_written: 4
blocks_unchanged: 8
errors_swallowed: 0
```

`errors_swallowed > 0` 表示 PLUR 出错并静默降级了——这是设计使然：
记忆失败永远不会让你的这一轮对话失败。

## 开发

本插件位于 PLUR monorepo 的
[`packages/dsh`](https://github.com/plur-ai/plur/tree/main/packages/dsh)。

```sh
git clone https://github.com/plur-ai/plur && cd plur
pnpm install
pnpm --filter @plur-ai/dsh build
pnpm --filter @plur-ai/dsh test
```

其中最值得了解的是 `test/host-conformance.test.ts`：它会启动真实的
`dsh-commands`、`dsh-skill`、`dsh-system-prompt` 和 `dsh-tools` 注册表，并针对
磁盘上的真实存储运行，而不是使用替身。本插件出现过的每一个宿主契约 bug——一共
五个——都躲过了那套把这些注册表打桩、并手写事件负载的测试。只要你改动了宿主
拥有的东西，就请针对宿主自己的实现来断言。

Issue 与 PR：[github.com/plur-ai/plur](https://github.com/plur-ai/plur)。

## 同样支持

Claude Code 与 Cursor（通过 MCP）、OpenClaw、Hermes、LangChain，以及 Python SDK。
同一份 engram，同一个存储，覆盖你使用的每个工具。

## 许可证与安全

Apache-2.0，见 [LICENSE](./LICENSE)。

安全问题请私下发送到 **security@plur.ai**，不要通过公开 issue 提交。值得在此
报告的包括：任何在会话解析出的 scope 之外读取或写入 engram 的行为；任何让
engram 文本得以在系统提示词中伪造结构的方式；以及任何能从其他来源访问到记忆
查看器回环端口的途径。

## 链接

- [plur.ai](https://plur.ai) · [docs.plur.ai](https://docs.plur.ai)
- [github.com/plur-ai/plur](https://github.com/plur-ai/plur)
