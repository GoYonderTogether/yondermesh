# 跨 agent 派发能力矩阵

生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 / 单向 / 需登录 / 失败 / 跳过）。

**双向** = delivered && response 非空（真正调用 agent 并拿到回复）。
**单向** = delivered 但 response 空（仅投递；GUI 自动化读不到 Electron 回复，或焦点在编辑器导致 Cmd+V 粘到 Untitled 缓冲区未真正调用 agent）。
**需登录/配置** = delivered=false 且 error 命中认证/配置模式（CLI 本身工作，只是没配凭据）。
**能力缺失** = CLI 不支持 --mode new（不是代码 bug，是 CLI 自身能力限制，不算失败）。
**跳过** = 无 trigger 通道，或 binary/IDE-app 未安装（不算失败）。

| CLI | 通道 | 投递 | 回话 | 分类/原因 |
|---|---|---|---|---|
| claude-code | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli claude- |
| claude | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli claude  |
| codex | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli codex - |
| hermes | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli hermes  |
| gemini | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli gemini  |
| goose | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli goose - |
| aider | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli aider - |
| amp | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli amp --m |
| factory | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli factory |
| vibe | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli vibe -- |
| codebuddy | — | 跳过：未安装（跳过） | — | — |
| trae-cli | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli trae-cl |
| trae-ide | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli trae-id |
| opencode | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli opencod |
| qwen | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli qwen -- |
| openhands | — | 跳过：未安装（跳过） | — | — |
| kimi | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli kimi -- |
| openclaw | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli opencla |
| pi | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli pi --mo |
| copilot | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli copilot |
| crush | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli crush - |
| cline | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli cline - |
| continue | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli continu |
| antigravity | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli antigra |
| windsurf | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli windsur |
| cursor-ide | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli cursor- |
| chatgpt | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli chatgpt |

覆盖：25 个可 trigger CLI（双向 0 / 单向 0 / 需登录 0 / 失败 25）+ 跳过 2