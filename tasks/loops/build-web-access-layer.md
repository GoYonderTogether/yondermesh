---
id: build-web-access-layer
title: 构建·本地服务器接入层（src/web/）
status: draft
feature: ""
verifier: "bash -c 'npx vitest run src/web && npm run typecheck'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

新建 `src/web/`，零依赖 node:http server 包一层 SessionStore，给前端提供真实数据。端点 `/api/state /api/sessions /api/active /api/stats /api/extracts/:hash`。加命令 `ymesh web serve [--port]`。daemon 可长驻它（共享 store 实例，避免每次重开 SQLite）。只绑 127.0.0.1（local-first）。

## 2. 上下文 (Context)

读 docs/product-frontend.md §2/§8、scripts/loop/server.mjs（同模式先例）、src/bin/ymesh.ts 的 cmdStateSync（1801-1833，数据组装）、src/store/session-store.ts（现成查询方法）、src/daemon/config.ts（DaemonConfig 加 webServer 字段）、ARCHITECTURE.md（src/<name>/ 分层约定）。

## 3. 行动约束 (Action)

只新建 `src/web/` + 改 src/bin/ymesh.ts（加 case）+ src/daemon/config.ts。不准改 store schema。零新依赖（node:http + node:fs）。写 vitest 测试。

## 4. 观察与反馈 (Observation)

verifier：`npx vitest run src/web` 全绿 + typecheck 过。测试断言各端点返回结构正确、计数与 SessionStore 一致、只绑 127.0.0.1。

## Prompt

你是 loop 执行者，用 sub-agent 执行。读 docs/product-frontend.md + scripts/loop/server.mjs + cmdStateSync → 实现 src/web/server.ts + 路由 + 测试 + ymesh web serve 命令 → 跑 verifier → 通过则停，失败把错误当新上下文继续。不许撒谎。
