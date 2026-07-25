---
id: verify-local-first
title: 验证·本地优先与开源核心不变式
status: passed
feature: local-first
verifier: "bash -c 'head -1 LICENSE | grep -qi mit && grep -qi \"no model proxy\" site/guide/sync.md && grep -qi \"enabled: false\\|sync.*默认.*关\\|opt-in\" site/guide/sync.md && ! grep -rE \"fetch\\(|http\\.request|https\\.request|axios|undici\" src/store src/adapters src/extract 2>/dev/null | grep -v \"^.*//\\|^.*\\*\"'"
created: 2026-07-21
last_run: 2026-07-25 05:29:44
---
## 1. 目标 (Goal)




















证明两条架构不变式成立：① 开源核心（MIT LICENSE 存在）；② 本地优先（无 model proxy、不碰 key、sync 默认关闭/opt-in、relay 只走密文）。这是被信任的前提，须可核验。

## 2. 上下文 (Context)




















读 ARCHITECTURE.md（invariant：no model proxy / no plaintext on relay / keys stay local）、site/guide/sync.md（sync.enabled 默认 false、relay 是 dumb ciphertext pipe）、LICENSE。

## 3. 行动约束 (Action)




















只读校验。若不变式被破坏（如采集路径出现出站网络、sync 默认开），用 sub-agent 排查并恢复不变式，再验。

## 4. 观察与反馈 (Observation)




















verifier 断言：① LICENSE 首行含 MIT；② sync 文档含 "no model proxy"；③ sync 默认 opt-in（enabled: false）。
深入（loop 内）：grep src/store、src/adapters、src/extract 的采集路径，确认无 fetch/http 出站调用（采集只读本地文件）；确认 src/sync 默认 enabled=false。

## Prompt




















你是验证 loop 执行者，用 sub-agent 执行。核 LICENSE + sync 文档 + 采集路径无出站；若发现破坏不变式的代码（如采集路径调外网、sync 默认开），用 sub-agent 恢复不变式后重验。汇报每条不变式的核验结果。不许撒谎。
