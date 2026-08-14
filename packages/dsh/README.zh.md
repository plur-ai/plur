# @plur-ai/dsh

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供持久记忆。周一纠正过的事，周二依然记得。**

[English](README.md) | 中文

其他 dsh 记忆插件注入的是*提示线索*，然后指望模型去调用工具。
本插件直接把记忆本身放进提示词。

```sh
dsh plugin --profile web add @plur-ai/dsh
```

就这样。重启 `dsh`，你的 agent 就有记忆了。

## 工作原理

PLUR 注册一个系统提示词分区（system-prompt section），DeepSeek Harness 会在每次请求时重新渲染它。
相关记忆就直接*在那里*，在模型开始工作之前就已经呈现在它面前。

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

| 配置 | Hit@5 |
|---|---|
| Hybrid，无 reranker（默认发布配置） | 76.7% |
| Hybrid + ms-marco-minilm-l6 | 83.3% |
| Hybrid + bge-reranker-v2-m3 | 90.0% |

目前没有任何其他 DeepSeek Harness 记忆插件公开过检索基准。

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

另外还有 `/plur` 命令，无需消耗一次模型轮次即可查看记忆状态。

## 哪些数据会离开你的机器

PLUR 把一切存储在本地 `~/.plur` 并在本地检索。但被注入的记忆会成为
你的 agent 发送给**你所配置的模型提供方**的提示词的一部分——
对于默认的 DeepSeek Harness 安装，那就是 DeepSeek 的托管 API `api.deepseek.com`。

默认情况下本插件只读取 `project:dsh` 这一个 scope，**而不是**你的整个记忆库。
全局 PLUR 库会累积你曾经接入过的每一个工具的记忆，
一个编码 harness 不应该仅仅因为你安装了插件就继承全部内容。
请主动决定是否放宽范围，随时可以收窄，也可以完全关闭注入。

```yaml
# $DSH_HOME/settings.yaml
plur:
  scope: project:dsh      # 主动放宽，例如 project:acme
  injectionMode: content  # 或者：off
```

## 配置

所有设置位于 `$DSH_HOME/settings.yaml`（通常是 `~/.dsh/settings.yaml`）的 `plur` 命名空间下。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `path` | `~/.plur` | 存储位置 |
| `scope` | `project:dsh` | 本 harness 可读写的记忆 scope |
| `injectionMode` | `content` | `content` 注入记忆；`off` 关闭注入 |
| `injectionBudget` | `2000` | 注入块的近似 token 上限 |
| `refreshIntervalMs` | `0` | 两次召回之间的下限；`0` 表示每轮一次 |
| `autoLearn` | `true` | 检测你消息中的纠正并存储 |
| `autoCapture` | `true` | 在轮次结束时记录情节摘要 |
| `reranker` | `off` | `off`、`ms-marco-minilm-l6` 或 `bge-reranker-v2-m3` |
| `timeoutMs` | `5000` | 单次记忆调用的硬超时 |
| `tabEnabled` | `true` | Web UI 记忆标签页 |

**关于 `reranker` 的提醒。** 它运行在 harness 自己的进程中，
`bge-reranker-v2-m3` 峰值内存约 2GB RSS。
交互式使用请保持 `off`；仅在崩溃无代价的本地批处理场景中启用。

## 记忆行为异常时

运行 `/plur` 或调用 `plur_status`。计数器会告诉你召回是否执行过、
记忆块是否发生变化、是否有错误被静默吞掉：

```
scope: project:dsh
injection: content
refresh_attempted: 12
blocks_written: 4
blocks_unchanged: 8
errors_swallowed: 0
```

`errors_swallowed > 0` 表示 PLUR 出错并静默降级了——这是设计使然：
记忆失败永远不会让你的这一轮对话失败。

## 同样支持

Claude Code 与 Cursor（通过 MCP）、OpenClaw、Hermes、LangChain，以及 Python SDK。
同一份 engram，同一个存储，覆盖你使用的每个工具。

## 链接

- [plur.ai](https://plur.ai) · [docs.plur.ai](https://docs.plur.ai)
- [github.com/plur-ai/plur](https://github.com/plur-ai/plur)

Apache-2.0
