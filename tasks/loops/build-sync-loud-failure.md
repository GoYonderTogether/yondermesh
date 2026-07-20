---
id: build-sync-loud-failure
title: 构建·sync 显式失败而非静默
status: draft
feature: ""
verifier: "bash -c 'npx vitest run sync-fail && npm run typecheck'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

把 `src/sync/agent.ts` 的 `sync()` 从“静默 `void this.store`”（假装跑了、调用方无从得知没同步）改成**显式抛 `Error('sync 尚未实现（planned）')`**。配套写 `docs/sdd/sync.md` 留档目标架构与“为何本轮不做”。本 loop **不实现真实同步**，sync 整体仍是 planned，只消除“静默成功”这一谎报——对应 ARCHITECTURE §III.5「Failure is never silent」与 roadmap T2.3。

## 2. 上下文 (Context)

每次循环先读：`ARCHITECTURE.md` §III.5（Failure is never silent）+ §II Sync 段、`src/sync/agent.ts`（看 `sync()` 现状：约 line 61 `// TODO: 实现 E2E 加密推送 + 拉取` + line 68 `void this.store;`）、`tasks/roadmap.md` T2.3、`docs/product-vision-agent-bus-v0.1.md`（sync 定位：E2E 密文、relay 只见密文、单机闭环优先才做跨设备）。

## 3. 行动约束 (Action)

只改 `src/sync/agent.ts`（`sync()` 改抛错 + 注释指向 SDD）+ 新建 `docs/sdd/sync.md` + 新建 `tests/sync-fail.test.ts`。**不准动** `src/store`、`src/daemon`、`src/mcp`、`src/trigger`。**不准引入新依赖**。sync 整体保持 planned，不改 README/site 的 planned 标签（本 loop 只是把“静默”变“显式未实现”，不是交付 sync）。

## 4. 观察与反馈 (Observation)

verifier：`npx vitest run sync-fail` 全绿（断言调用 `sync()` 抛出含「尚未实现 / planned」字样的 Error、且不产生任何写入副作用）+ typecheck 过。再加“检查者” sub-agent：全仓 grep 确认无“sync 已交付 / 已同步 / synced”表述（`grep -rniE "已同步|synced|sync.*已交付" README.md README.zh-CN.md site/`），且 `docs/sdd/sync.md` 存在并明确写“本轮不实现 + 未来验收门”。

## Prompt

你是 loop 执行者，必须用 sub-agent（Agent 工具）执行，不要自己一口气写完。

【目标】把 `src/sync/agent.ts` 的 `sync()` 从静默 `void this.store` 改成显式抛 `Error('sync 尚未实现（planned）')`，配套写 `docs/sdd/sync.md`。不实现真实同步。
【上下文】每次循环先读：ARCHITECTURE §III.5 + src/sync/agent.ts（line 61 TODO + line 68 void）+ roadmap T2.3 + product-vision（sync 定位）。
【约束】只改 src/sync/agent.ts + 新建 docs/sdd/sync.md + tests/sync-fail.test.ts。不动 store/daemon/mcp/trigger。零新依赖。sync 仍是 planned。
【完成判据】`npx vitest run sync-fail` 全绿 + typecheck 过；检查者 sub-agent 确认全仓无“sync 已交付”表述、SDD 存在且写明本轮不做。
【验证命令】`npx vitest run sync-fail && npm run typecheck` 必须 exit 0。

规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。不许撒谎声称通过。注意：只消除静默谎报，不实现真实 sync。
