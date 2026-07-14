# 已知问题与诊断决策树

按症状快速定位问题根因和修复方法。

## 症状索引

1. [ymesh 命令找不到](#1-ymesh-命令找不到)
2. [scan 后数据库为空](#2-scan-后数据库为空)
3. [daemon 启动后立即退出](#3-daemon-启动后立即退出)
4. [新 session 不被自动发现](#4-新-session-不被自动发现)
5. [session 关系全部为空](#5-session-关系全部为空)
6. [数据库过大或重复 revision](#6-数据库过大或重复-revision)
7. [update 后无法启动](#7-update-后无法启动)
8. [LaunchAgent 加载失败](#8-launchagent-加载失败)
9. [sqlite3 not found](#9-sqlite3-not-found)
10. [EPERM 或权限错误](#10-eperm-或权限错误)

## 1. ymesh 命令找不到

症状: `ymesh: command not found`

根因: `~/.yondermesh/bin/ymesh` 不在 PATH 中

修复:
```bash
ln -s ~/.yondermesh/bin/ymesh ~/.local/bin/ymesh
# 或加入 PATH
export PATH="$HOME/.yondermesh/bin:$PATH"
```

验证: `ymesh version`

## 2. scan 后数据库为空

症状: `ymesh status` 显示 0 sessions

排查步骤:
1. 检查 `~/.claude/projects/` 和 `~/.codex/sessions/` 是否存在且有 JSONL 文件
2. 检查 cass DB: `~/Library/Application Support/com.coding-agent-search.coding-agent-search/agent_search.db`
3. 运行 `ymesh scan --verbose 2>&1 | tail -20` 查看 adapter 输出
4. 检查 scan_runs: `sqlite3 ~/.yondermesh/yondermesh.db "SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 5;"`
5. 如果 scan_runs 有 error 字段，按错误信息排查

常见原因: CLI 数据目录路径变更、权限问题、JSONL 格式不兼容

## 3. daemon 启动后立即退出

症状: `ymesh daemon start` 后 pid 文件很快消失

排查步骤:
1. 查看日志: `cat ~/.local/state/yondermesh/*.log | tail -50`
2. 检查 stale pid: `cat ~/.yondermesh/daemon.pid`，如果进程不存在则 `rm ~/.yondermesh/daemon.pid`
3. 手动前台运行: `ymesh daemon run` 直接看错误输出
4. 常见原因: 数据库被锁（另一个 daemon 在跑）、cass DB 路径不可读、内存不足

## 4. 新 session 不被自动发现

症状: 新开 Claude/Codex session 后数据库没有更新

排查步骤:
1. 确认 daemon 在运行: `ymesh daemon status` 或 `diagnose.sh --section daemon`
2. 手动 scan: `ymesh scan` 看是否能发现
3. 检查 fs.watch 是否有报错: 查看日志中的 watchErrors
4. 如果 watch 不支持，daemon 会退回定时扫描（默认每 5 分钟一次）
5. 确认文件确实存在于预期路径: `ls ~/.claude/projects/` 或 `ls ~/.codex/sessions/`

## 5. session 关系全部为空

症状: session_relationships 表行数为 0

排查步骤:
1. 只有 Claude 和 Codex adapter 会产生关系，cass 不产生
2. 检查 Claude 的 subagent 目录结构: `find ~/.claude/projects -path '*/subagents/*' | head -5`
3. 检查 Codex 的 thread_source 字段: 在 rollout JSONL 中搜索 `"thread_source"`
4. 如果 CLI 版本更新导致路径格式变化，adapter 可能需要更新

## 6. 数据库过大或重复 revision

症状: db 文件超过预期大小（如 > 500MB），或 revision 数远超 session 数

排查:
```bash
sqlite3 ~/.yondermesh/yondermesh.db "
SELECT s.native_session_id, count(r.id) as revs
FROM sessions s JOIN session_revisions r ON r.session_id = s.id
GROUP BY s.id HAVING revs > 10 ORDER BY revs DESC LIMIT 10;"
```
如果单个 session 有几十个 revision，可能是内容 hash 计算逻辑有问题，或该 session 确实在高频更新。

## 7. update 后无法启动

症状: `ymesh update` 后 ymesh 无法运行

修复: 自动回退机制应已生效
```bash
# 检查是否有 previous
ls -la ~/.yondermesh/releases/previous
# 手动回退
cd ~/.yondermesh/releases
rm current && ln -s $(readlink previous) current
# 或重新安装
ymesh install
```

## 8. LaunchAgent 加载失败

症状: `launchctl load` 报错

常见原因:
1. plist 文件格式错误: `plutil -lint ~/Library/LaunchAgents/com.yondermesh.daemon.plist`
2. 可执行路径不存在: 检查 plist 中 ProgramArguments 指向的 node 和 ymesh.js 是否存在
3. 权限问题: `chmod 644 ~/Library/LaunchAgents/com.yondermesh.daemon.plist`

## 9. sqlite3 not found

症状: diagnose.sh 报 "sqlite3 CLI not available"

说明: macOS 自带 sqlite3，如果缺失可能是 PATH 问题。yondermesh 本身使用 node:sqlite 不依赖外部 sqlite3，但诊断脚本需要它。

修复: `brew install sqlite3` 或使用 Node.js 内联查询。

## 10. EPERM 或权限错误

症状: 测试或运行时遇到 EPERM on pipes

常见于 tsx 在沙盒环境运行 IPC pipe 时。修复: 使用编译产物 `node dist/bin/ymesh.js` 而非 `npx tsx`。
