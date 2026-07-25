---
id: build-check-prior-attempts
title: 构建·check_prior_attempts 洞察工具（旗舰第四问）
status: passed
feature: 
verifier: "bash -c 'npx vitest run prior-attempts && npm run typecheck'"
created: 2026-07-21
last_run: 2026-07-25 09:29:25
---
## 1. 目标 (Goal)









L4 旗舰：输入一个任务/报错，返回“别的 agent 之前踩过没、结论是什么”——product-vision US-7 里“不重复踩坑”从 slogan 变成一次调用（roadmap T2.4.5）。**v0 基于 session messages 的确定性匹配**（失败/报错标记正则 + 同项目同类任务权重），**不依赖独立的决策提取模块**（那是后续 loop）。零 LLM。

## 2. 上下文 (Context)









每次循环先读：`docs/product-vision-agent-bus-v0.1.md`（US-7 check_prior_attempts 定位与“记忆的一生”）、`ARCHITECTURE.md` §II MCP（`ORTHOGONAL_TOOL_NAMES` + 辅助工具）+ §III.6、`src/store/index.ts`（查询接口，复用正文搜索若 content-search loop 已落地）、`src/mcp/tools.ts`（现有 handler 注册模式 + 新工具作**辅助工具追加**，不进正交 8）、`src/mcp/server.ts`（`listTools` 路由）、`src/derive/stuck.ts`（若已存在，参考其确定性判定写法）、`tasks/roadmap.md` T2.4.5。

## 3. 行动约束 (Action)









新建 `src/derive/prior-attempts.ts`（纯函数 `findPriorAttempts(query, sessions)` + 匹配口径常量）+ 新建 `tests/derive-prior-attempts.test.ts` + 在 `src/mcp/tools.ts` **追加** `check_prior_attempts` handler（辅助工具，**不改现有 8 正交 + 4 辅助的语义与名称**）。**MCP handler 直接从 `../derive/prior-attempts.js` 导入，不修改也不依赖 `src/derive/index.ts` barrel**（与 stuck loop 解耦、可并行）。**只读** `src/store`。零 LLM、零新依赖。匹配口径（失败标记正则 / 同项目权重 / 截断条数）做成可配常量。

## 4. 观察与反馈 (Observation)









verifier：`npx vitest run prior-attempts` 全绿（fixture：多个 session 含相同报错 / 同类失败任务 → `findPriorAttempts` 返回历史尝试 + 结论；无历史时返回空数组而非崩；命中按相关性排序）+ typecheck。检查者 sub-agent：用本机真实 store 输入一个真实踩过的报错，核对返回的 prior attempts 是否合理（命中相关、不硬凑、不漏明显同类）；**误匹配举一例**分析并标注口径改进方向。

## Prompt









你是 loop 执行者，必须用 sub-agent（Agent 工具）执行，不要自己一口气写完。

【目标】新建 `src/derive/prior-attempts.ts`：`findPriorAttempts(query, sessions)` 纯函数，输入任务/报错，确定性匹配历史 session 里的同类失败/尝试，返回结论。零 LLM。v0 不依赖决策提取模块。
【上下文】每次循环先读：product-vision US-7 + src/mcp/tools.ts（注册模式 + ORTHOGONAL_TOOL_NAMES）+ src/store 查询 + roadmap T2.4.5 + src/derive/stuck.ts（若在，参考写法）。
【约束】新建 src/derive/prior-attempts.ts + tests/derive-prior-attempts.test.ts；src/mcp/tools.ts 追加 check_prior_attempts handler（辅助工具，不动正交 8），handler 直接 import '../derive/prior-attempts.js'，不碰 src/derive/index.ts barrel。只读 store。零 LLM、零新依赖。
【完成判据】`npx vitest run prior-attempts` 全绿 + typecheck；检查者 sub-agent 用真实 store 输入踩过的报错核对召回质量，误匹配举一例。
【验证命令】`npx vitest run prior-attempts && npm run typecheck` 必须 exit 0。

规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。注意 v0 不依赖决策提取模块，直接基于 messages 确定性匹配。不许撒谎声称通过。
