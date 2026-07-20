// scripts/loop/run.mjs
//
// 打印某个 loop 的 Prompt 段（agent 跑这个命令即可拿到提示词）。
// Prompt 段为空时，自动从四模块拼一段骨架。
//
// Run:  node scripts/loop/run.mjs <id>

import { loadLoop, defaultPrompt } from './loop-lib.mjs';

const id = process.argv[2];
if (!id) {
  console.error('用法: node scripts/loop/run.mjs <id>   （或 npm run loop:run -- <id>）');
  process.exit(1);
}

const loop = loadLoop(id);
const prompt = (loop.prompt && loop.prompt.trim()) ? loop.prompt.trim() : defaultPrompt(loop);
process.stdout.write(prompt + '\n');
