---
id: macos-sign-notarize
title: 构建·macOS 签名 + 公证脚本
status: passed
feature: ""
verifier: "bash -c 'test -x scripts/notarize-mac.sh && bash -n scripts/notarize-mac.sh'"
created: 2026-07-21
last_run: 2026-07-25 04:10:00
---

## 1. 目标 (Goal)

套 yonder 的 `notarize-mac.sh`（非阻塞 notarytool + stapler + spctl 校验）+ pack-dmg，改 OSS 路径与 APPLE 凭据占位。Developer ID 公证 + Hardened Runtime 路线。依赖 fork-yonder-shell + macos-tray。

## 2. 上下文 (Context)

读 docs/product-frontend.md §7、/Users/zoran/Documents/projects/yonder/scripts/{notarize-mac.sh,pack-dmg-with-fix.sh,upload-mac-dmg-oss.sh}、desktop/src-tauri/tauri.conf.json（bundle/sign 配置）。

## 3. 行动约束 (Action)

在 yondermesh/scripts/ 加 notarize-mac.sh + pack-dmg（改占位凭据/OSS）。verifier 只验脚本存在 + 语法（bash -n）；真实公证需 APPLE 凭据，人工触发。

## 4. 观察与反馈 (Observation)

verifier：`test -x scripts/notarize-mac.sh && bash -n scripts/notarize-mac.sh` exit 0。真实 notarize 后 stapler + spctl 通过（人工跑、记入报告）。

## Prompt

你是 loop 执行者，用 sub-agent 执行。套 yonder notarize/pack-dmg 脚本、改占位 → 跑 verifier（脚本存在+语法）→ 通过则停，失败继续。真实公证人工触发。不许撒谎。
