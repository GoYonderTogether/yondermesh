# 跨 agent 派发能力矩阵

生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 vs 单向 vs 需登录）。

| CLI | 通道 | 投递 | 回话 |
|---|---|---|---|
| claude | cli-spawn | ✅已投递 | ✅有回复 |
| codex | cli-spawn | ✅已投递 | ✅有回复 |
| cass | — | 跳过：无 trigger 通道 | — |
| opencode | http-api | ✅已投递 | ⚠️无回复/读不到 |
| hermes | cli-spawn | ✅已投递 | ✅有回复 |
| kimi | ? | ❌ 失败 | Command failed: ymesh send --cli kimi --mode new - |
| cursor | — | 跳过：无 trigger 通道 | — |
| cursor-ide | applescript | ✅已投递 | ⚠️无回复/读不到 |
| copilot | ? | ❌ 失败 | Command failed: ymesh send --cli copilot --mode ne |
| gemini | ? | ❌ 失败 | Command failed: ymesh send --cli gemini --mode new |
| qwen | ? | ❌ 失败 | Command failed: ymesh send --cli qwen --mode new - |
| openclaw | ? | ❌ 失败 | Command failed: ymesh send --cli openclaw --mode n |
| aider | ? | ❌ 失败 | Command failed: ymesh send --cli aider --mode new  |
| trae | — | 跳过：无 trigger 通道 | — |
| trae-ide | applescript | ✅已投递 | ⚠️无回复/读不到 |
| windsurf | ? | ❌ 失败 | Command failed: ymesh send --cli windsurf --mode n |
| openhands | ? | ❌ 失败 | Command failed: ymesh send --cli openhands --mode  |
| goose | cli-spawn | ✅已投递 | ✅有回复 |
| antigravity | cli-spawn | ✅已投递 | ✅有回复 |
| factory | ? | ❌ 失败 | Command failed: ymesh send --cli factory --mode ne |
| vibe | cli-spawn | ✅已投递 | ✅有回复 |
| codebuddy | ? | ❌ 失败 | Command failed: ymesh send --cli codebuddy --mode  |
| amp | cli-spawn | ✅已投递 | ⚠️无回复/读不到 |
| chatgpt | ? | ❌ 失败 | Command failed: ymesh send --cli chatgpt --mode ne |
| pi | ? | ❌ 失败 | Command failed: ymesh send --cli pi --mode new --m |
| omp | — | 跳过：无 trigger 通道 | — |
| gsd-pi | — | 跳过：无 trigger 通道 | — |
| crush | ? | ❌ 失败 | Command failed: ymesh send --cli crush --mode new  |
| cline | ? | ❌ 失败 | Command failed: ymesh send --cli cline --mode new  |
| continue | ? | ❌ 失败 | Command failed: ymesh send --cli continue --mode n |

覆盖：25 个可 trigger CLI