---
id: wire-scaffold-cli
title: 构建·接 ymesh scaffold 命令（adapter-sdk 收尾）
status: passed
feature: adapter-sdk
verifier: "bash -c 'ymesh scaffold __probe --yes && test -f src/__probe/index.ts && rm -rf src/__probe'"
created: 2026-07-21
last_run: 2026-07-25 04:32:01
---
## 1. 目标 (Goal)



把已有的 `scaffoldAdapter()`（src/sdk/scaffold.ts）接到 CLI：`ymesh scaffold <name> [--yes]` 生成 4 个 TS 模板文件到 src/<name>/，落地磁盘。SDK + factory 参考实现已齐 + 有测试，唯一缺 CLI 入口。

## 2. 上下文 (Context)



读 src/sdk/scaffold.ts（scaffoldAdapter，已实现）、src/sdk/template.ts、src/bin/ymesh.ts（加 case + help）、specs/adapter-spec.md（生成物契约）。

## 3. 行动约束 (Action)



只在 ymesh.ts 加 cmdScaffold + switch + help。复用 scaffoldAdapter，不准重写 SDK。生成物默认落 src/<name>/，--yes 跳确认。

## 4. 观察与反馈 (Observation)



verifier：`ymesh scaffold __probe --yes && test -f src/__probe/index.ts && rm -rf src/__probe` —— 真能生成 importer/wrapper/inject/index 四件套并清理探针。

## Prompt



你是 loop 执行者，用 sub-agent 执行。读 scaffold.ts + ymesh.ts dispatch → 接 cmdScaffold → 跑 verifier（生成探针→验证→清理）→ 通过则停，失败继续。不许撒谎。
