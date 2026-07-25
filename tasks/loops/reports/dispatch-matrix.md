# 跨 agent 派发能力矩阵

生成于 loop:verify-dispatch-matrix。揭示每个 CLI 的投递与回话能力（双向 / 单向 / 需登录 / 失败 / 跳过）。

**双向** = delivered && response 非空（真正调用 agent 并拿到回复）。
**单向** = delivered 但 response 空（仅投递；GUI 自动化读不到 Electron 回复，或焦点在编辑器导致 Cmd+V 粘到 Untitled 缓冲区未真正调用 agent）。
**需登录/配置** = delivered=false 且 error 命中认证/配置模式（CLI 本身工作，只是没配凭据）。
**能力缺失** = CLI 不支持 --mode new（不是代码 bug，是 CLI 自身能力限制，不算失败）。
**跳过** = 无 trigger 通道，或 binary/IDE-app 未安装（不算失败）。

| CLI | 通道 | 投递 | 回话 | 分类/原因 |
|---|---|---|---|---|
| claude-code | cli-spawn | ⏭️能力缺失 | — | 不支持 new 模式 |
| claude | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| codex | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| hermes | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| gemini | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli gemini  |
| goose | cli-spawn | ✅已投递 | ✅有回复 | ✅双向 |
| aider | cli-spawn | ❌失败 | — | Warning: Input is not a terminal (fd=0).
Error in sys.excepthook:
Traceback (most recent call last): |
| amp | cli-spawn | 🔒需登录/配置 | — | Error: Out of credits |
| factory | cli-spawn | 🔒需登录/配置 | — | Error during droid execution: Authentication failed. Please log in using /login or set a valid FACTO |
| vibe | cli-spawn | ❌失败 | — | Warning: /Users/zoran/Documents/projects/yondermesh is not trusted; project 
configuration (AGENTS.m |
| codebuddy | — | 跳过：未安装（跳过） | — | — |
| trae-cli | cli-spawn | ⏭️能力缺失 | — | 不支持 new 模式 |
| trae-ide | applescript | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |
| opencode | http-api | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |
| qwen | cli-spawn | 🔒需登录/配置 | — | Warning: MCP server(s) failed to start: yondermesh. Continuing with built-in tools and any servers t |
| openhands | — | 跳过：未安装（跳过） | — | — |
| kimi | ws-rpc | 🔒需登录/配置 | — | kimi 未返回回复（可能认证失败或模型未配置） |
| openclaw | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli opencla |
| pi | ws-rpc | ✅已投递 | ✅有回复 | ✅双向 |
| copilot | ws-rpc | 🔒需登录/配置 | — | Third-party MCP servers are disabled by your organization's Copilot policy. Only built-in servers ar |
| crush | cli-spawn | 🔒需登录/配置 | — | ERROR  
          
  No providers configured - please run 'crush' to set up a provider interactively |
| cline | cli-spawn | ❌失败 | — | [31merror:[0m hook dispatch failed: session.hook requires a valid hook event payload
[31merror:[ |
| continue | cli-spawn | 🔒需登录/配置 | — | {"status":"error","message":"Failed to parse config: Expected object, received null"} |
| antigravity | ? | ❌ 失败 | — | Command failed: node /Users/zoran/Documents/projects/yondermesh/dist/bin/ymesh.js send --cli antigra |
| windsurf | applescript | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |
| cursor-ide | applescript | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |
| chatgpt | applescript | ✅已投递 | ⚠️无回复/读不到 | ⚠️单向 |

覆盖：25 个可 trigger CLI（双向 5 / 单向 5 / 需登录 7 / 失败 6）+ 跳过 4