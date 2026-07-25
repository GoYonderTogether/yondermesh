---
id: fe-settings-paged
title: 构建·页式设置（fe-settings-paged · 非弹窗）
status: passed
feature: 
verifier: "bash -c 'cd desktop/web && npm run build'"
created: 2026-07-21
last_run: 2026-07-25 03:28:40
---
## 1. 目标 (Goal)



把 yonder 的弹窗无缝式设置，改成正经的页式设置（一页一页）：设备管理 / 同步 / 模型与 key / 外观 / 权限 / 关于，每页独立路由。依赖 fork-yonder-shell。

## 2. 上下文 (Context)



读 docs/product-frontend.md §3/§5（页式设置）、desktop/web 的路由（router.tsx）、ui（Tabs/Label/Input/Switch）。前端基建两用：服务器端管理 UI + 用户本机设置同代码库切模式。

## 3. 行动约束 (Action)



新建 desktop/web/src/features/settings/（分页 + 各子页 + 测试）。复用 @ymesh/ui。不准改引擎。

## 4. 观察与反馈 (Observation)



verifier：`cd desktop/web && npm run build` 成功。各设置页独立路由可达、表单可填（人工核验记入报告）。

## Prompt



你是 loop 执行者，用 sub-agent 执行。读设置设计 → 实现分页路由 + 各子页 + 测试 → 跑 verifier（build 过）→ 通过则停，失败继续。不许撒谎。
