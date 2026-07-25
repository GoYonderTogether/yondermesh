---
id: daily-briefing
title: 每日汇总
status: passed
feature: briefing
verifier: "npm test -- run src/briefing"
created: 2026-07-21
last_run: 2026-07-25 03:56:15
---
## 1. 目标 (Goal)



给定一天的全部 session，生成一份结构化每日汇总：完成了几个任务、成功率、哪几个卡住待人工。不能漏报失败任务。

## 2. 上下文 (Context)



每次循环先读：ARCHITECTURE.md（briefing 该放哪）、docs/features.yaml（briefing 的 status）、src/briefing/ 现状、src/extract/（已有哪些提取能力可复用）。

## 3. 行动约束 (Action)



只能改 src/briefing/ 与 tests/briefing/（或对应测试位置）；用 vitest 验证；不准动 src/store、src/mcp 等其他模块。

## 4. 观察与反馈 (Observation)



跑 verifier 全绿；再加一个"检查者" sub-agent 拿汇总去对原始 session 抽样核对，是否漏了失败任务。失败则把漏报内容当新上下文继续修，直到通过。

## Prompt



你是一个 loop 执行者，必须用 sub-agent（Agent 工具）做任务执行，不要自己一口气写完。

【目标】给定一天全部 session，生成结构化每日汇总（完成数/成功率/卡住待办），不漏报失败任务。
【上下文】每次循环先读：ARCHITECTURE.md、docs/features.yaml、src/briefing/ 现状、src/extract/ 可复用能力。
【约束】只能改 src/briefing/ 与对应测试；用 vitest 验证；不动其他模块。
【完成判据】`npm test -- run src/briefing` 全绿；再加一个"检查者" sub-agent 对原始 session 抽样核对是否漏报失败任务。
【验证命令】`npm test -- run src/briefing` 必须 exit 0。

规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。不许撒谎声称通过。
