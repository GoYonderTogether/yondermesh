# 跨 agent 派发能力矩阵

生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 vs 单向 vs 需登录）。

**双向** = delivered && response 非空（真正调用 agent 并拿到回复）。
**单向** = delivered 但 response 空（仅投递；可能是 GUI 自动化读不到 Electron 回复，也可能是焦点在编辑器导致 Cmd+V 粘到 Untitled 缓冲区未真正调用 agent）。

| CLI | 通道 | 投递 | 回话 | 双向 |
|---|---|---|---|---|
| claude | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| codex | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| cass | — | 跳过：无 trigger 通道 | — | — |
| opencode | ? | ❌ 失败 | — | Command failed: ymesh send --cli opencode --mode n |
| hermes | ? | ❌ 失败 | — | Command failed: ymesh send --cli hermes --mode new |
| kimi | ? | ❌ 失败 | — | Command failed: ymesh send --cli kimi --mode new - |
| cursor | — | 跳过：无 trigger 通道 | — | — |
| cursor-ide | applescript | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |
| copilot | ? | ❌ 失败 | — | Command failed: ymesh send --cli copilot --mode ne |
| gemini | ? | ❌ 失败 | — | Command failed: ymesh send --cli gemini --mode new |
| qwen | ? | ❌ 失败 | — | Command failed: ymesh send --cli qwen --mode new - |
| openclaw | ? | ❌ 失败 | — | Command failed: ymesh send --cli openclaw --mode n |
| aider | ? | ❌ 失败 | — | Command failed: ymesh send --cli aider --mode new  |
| trae | — | 跳过：无 trigger 通道 | — | — |
| trae-ide | applescript | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |
| windsurf | ? | ❌ 失败 | — | Command failed: ymesh send --cli windsurf --mode n |
| openhands | ? | ❌ 失败 | — | Command failed: ymesh send --cli openhands --mode  |
| goose | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| antigravity | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| factory | ? | ❌ 失败 | — | Command failed: ymesh send --cli factory --mode ne |
| vibe | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| codebuddy | ? | ❌ 失败 | — | Command failed: ymesh send --cli codebuddy --mode  |
| amp | ? | ❌ 失败 | — | Command failed: ymesh send --cli amp --mode new -- |
| chatgpt | ? | ❌ 失败 | — | Command failed: ymesh send --cli chatgpt --mode ne |
| pi | ? | ❌ 失败 | — | Command failed: ymesh send --cli pi --mode new --m |
| omp | — | 跳过：无 trigger 通道 | — | — |
| gsd-pi | — | 跳过：无 trigger 通道 | — | — |
| crush | ? | ❌ 失败 | — | Command failed: ymesh send --cli crush --mode new  |
| cline | ? | ❌ 失败 | — | Command failed: ymesh send --cli cline --mode new  |
| continue | ? | ❌ 失败 | — | Command failed: ymesh send --cli continue --mode n |

覆盖：25 个可 trigger CLI（双向 5 / 单向 2 / 失败 18）