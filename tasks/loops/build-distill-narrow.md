---
id: build-distill-narrow
title: 构建·蒸馏窄版（distill · 标签/主题/偏好抽取）
status: draft
feature: distill
verifier: "bash -c 'npx vitest run src/distill && npm run typecheck'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

新建 `src/distill/` 窄版本：从 src/extract/ 的 requirements/responses NDJSONL 产物中，抽取结构化标签/主题/长期偏好（技术栈、常用做法、踩过的坑），存 `~/.yondermesh/distilled/`，加 `ymesh distill run`。先做可测的"覆盖率/抽取率"，"懂你"质量留后续。

## 2. 上下文 (Context)

读 docs/product-frontend.md §8（distill 窄版定义）、src/extract/extractor.ts（NDJSONL 产物 + queryExtracts）、src/store/schema.ts（可能的 distilled 表）、docs/features.yaml（distill=零代码）。

## 3. 行动约束 (Action)

新建 src/distill/（抽取器 + 存储 + CLI）+ 测试。窄版：规则/启发式抽取（非 LLM 质量评判），保证可测。不准改现有 schema，新存储独立。

## 4. 观察与反馈 (Observation)

verifier：`npx vitest run src/distill` 全绿 + typecheck。断言：给定 extract 产物，能抽出 ≥N 个标签/主题、覆盖率达标、幂等（重复跑不重复入库）。

## Prompt

你是 loop 执行者，用 sub-agent 执行。读 extract 产物格式 → 实现窄版 distill 抽取 + 存储 + CLI + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
