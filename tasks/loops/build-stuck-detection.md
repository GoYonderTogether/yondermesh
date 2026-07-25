---
id: build-stuck-detection
title: 构建·卡住检测（deterministic，零 LLM）
status: passed
feature: 
verifier: "bash -c 'npx vitest run stuck && npm run typecheck'"
created: 2026-07-21
last_run: 2026-07-25 09:34:31
---
## 1. 目标 (Goal)







L4 派生层第一块：可确定性判定“哪些 session 卡住了”，供 briefing / distill 消费。判定口径确定且可调（默认：最近 N 小时无更新 + 最后一条消息是 assistant 提问/无 tool_result）。**完全 deterministic，零 LLM**（ARCHITECTURE §III.6）——对应 roadmap T2.4.2。

## 2. 上下文 (Context)







每次循环先读：`ARCHITECTURE.md` §III.6（内核零 LLM）+ §II、`docs/product-vision-agent-bus-v0.1.md`（US-4/US-7 卡住主动告知）、`src/store/index.ts`（`querySessions` / `getSessionStats` / `getActiveSessionsSummary` 现成查询）、`src/store/types.ts`（`SessionRecord` / `SessionMessage` 结构，含 `updated_at` / `last_seen_at` / topology）、`tasks/roadmap.md` T2.4（新建 `src/derive/`）、`src/briefing/generator.ts`（briefing 后续将消费本能力，本 loop 不接入）。

## 3. 行动约束 (Action)







只新建 `src/derive/stuck.ts`（纯函数 `detectStuckSessions(sessions, opts)`）+ `src/derive/index.ts` barrel（导出 `detectStuckSessions`）+ `tests/derive-stuck.test.ts`。**只读** `src/store`（不写、不改 schema、不改 query 方法）。**不准动** `src/store`、`src/mcp`、`src/briefing` 产品逻辑（briefing 接入是后续独立 loop）。零 LLM、零新依赖。判定阈值（`staleHours` 等）做成可配参数，默认值常量化。

## 4. 观察与反馈 (Observation)







verifier：`npx vitest run stuck` 全绿（fixture sessions 断言：有“卡住”特征的被标出、活跃的不被标、阈值边界——刚好 staleHours 处——判定正确）+ typecheck。检查者 sub-agent：用本机真实 store 跑 `detectStuckSessions`，抽样核对被标“卡住”的 session 是否真的 last-updated 久远 + 最后消息形态吻合；**误报 / 漏报各举一例**分析。

## Prompt







你是 loop 执行者，必须用 sub-agent（Agent 工具）执行，不要自己一口气写完。

【目标】新建 `src/derive/stuck.ts`：`detectStuckSessions(sessions, opts)` 纯函数，可确定性判定卡住（默认口径：N 小时无更新 + 最后一条是 assistant 提问/无 tool_result），阈值可配，零 LLM。
【上下文】每次循环先读：ARCHITECTURE §III.6 + src/store 查询接口 + types.ts + roadmap T2.4.2 + briefing/generator.ts（消费方，本 loop 不接入）。
【约束】只新建 src/derive/stuck.ts + src/derive/index.ts barrel + tests/derive-stuck.test.ts。只读 src/store，不改 store/mcp/briefing。零 LLM、零新依赖。
【完成判据】`npx vitest run stuck` 全绿 + typecheck；检查者 sub-agent 对真实 store 抽样核对误报/漏报各一例。
【验证命令】`npx vitest run stuck && npm run typecheck` 必须 exit 0。

规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。不许撒谎声称通过。
