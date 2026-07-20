---
id: verify-inject-mount
title: 验证·MCP 挂载与记忆注入
status: passed
feature: inject
verifier: "node scripts/loop/verify/inject-mount.mjs"
created: 2026-07-21
last_run: 2026-07-20 17:52:58
---
## 1. 目标 (Goal)






证明零侵入挂载与记忆注入可用：`agents`（include_mounts）能返回各 CLI 的挂载策略，`ymesh mount status` 能查挂载状态；记忆注入即 send 的 running/inject 模式（由 verify-dispatch-roundtrip 覆盖运行中注入，本 loop 验挂载面）。

## 2. 上下文 (Context)






读 src/mount/（manager/strategies/registry）、specs/mcp-spec.md 的 agents 工具、src/bin/ymesh.ts 的 mount 命令。挂载三类型：mcp-server / skill / always-on。

## 3. 行动约束 (Action)






只查询挂载状态，不改挂载。若 agents 工具或 mount status 报错，用 sub-agent 排查 src/mount/ 修复，再验。

## 4. 观察与反馈 (Observation)






verifier：① `agents {include_mounts:true}` 返回非空且每条含 mountStrategies；② `ymesh mount status` exit 0。
深入（loop 内）：对至少一个已挂载 CLI，确认其 MCP server 入口被写进它的配置目录（如 ~/.claude/claude_mcp_config.json），且 `ymesh mcp call` 能经该挂载被调用。

## Prompt






你是验证 loop 执行者，用 sub-agent 执行。查挂载状态 + agents 工具；若异常用 sub-agent 排查 src/mount/ 修复后重验。汇报各 CLI 的挂载策略与是否真生效。不许撒谎。
