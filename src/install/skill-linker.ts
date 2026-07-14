/**
 * Skill 分发：将 yondermesh 自带 skill 链接到各 agent 的 skill 目录
 *
 * 设计原则：
 *   - skill 随 release 发布（buildRelease 复制 skills/ 到 release 目录）
 *   - 安装时创建 symlink，指向 releases/current/skills/<name>
 *   - 更新时 current 切换，symlink 自动指向新版本的 skill
 *   - 开发者改了 skill 并 push → 用户 ymesh update → 新 skill 自动生效
 *   - 任意支持文件式 skill 的 CLI 都可以接入
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { resolveCurrentSymlink } from './paths.js';

/** 支持的 CLI skill 目录（相对 home） */
const SKILL_TARGETS: { cli: string; dir: string }[] = [
  { cli: 'codex', dir: '.codex/skills' },
];

/** yondermesh 自带的 skill 列表 */
const BUNDLED_SKILLS = ['yondermesh-diagnose'];

/**
 * 为所有已安装的 CLI 创建 skill symlink
 *
 * symlink 目标指向 releases/current/skills/<name>，
 * 这样 ymesh update 切换 current 后 skill 自动更新。
 */
export function linkSkills(): { linked: string[]; skipped: string[] } {
  const currentRelease = resolveCurrentSymlink();
  const skillsRoot = path.join(currentRelease, 'skills');

  if (!fs.existsSync(skillsRoot)) {
    return { linked: [], skipped: ['no skills directory in current release'] };
  }

  const linked: string[] = [];
  const skipped: string[] = [];

  for (const target of SKILL_TARGETS) {
    const cliSkillsDir = path.join(homedir(), target.dir);

    // 只为已安装的 CLI 创建链接
    const cliMarker = target.cli === 'codex' ? '.codex' : `.${target.cli}`;
    if (!fs.existsSync(path.join(homedir(), cliMarker))) {
      skipped.push(`${target.cli} not installed (no ~/${cliMarker})`);
      continue;
    }

    fs.mkdirSync(cliSkillsDir, { recursive: true });

    for (const skillName of BUNDLED_SKILLS) {
      const skillSource = path.join(skillsRoot, skillName);
      if (!fs.existsSync(skillSource)) {
        skipped.push(`${skillName} not in release`);
        continue;
      }

      const linkPath = path.join(cliSkillsDir, skillName);

      // 移除旧链接（无论指向哪里）
      try {
        fs.unlinkSync(linkPath);
      } catch {
 // 不存在或不是 symlink，忽略
        try { fs.rmSync(linkPath, { force: true }); } catch { /* */ }
      }

      // 创建新链接，指向 current/skills/<name>
      fs.symlinkSync(skillSource, linkPath, 'dir');
      linked.push(`${target.cli}: ${skillName}`);
    }
  }

  return { linked, skipped };
}

/**
 * 移除所有 skill symlink（uninstall 时调用）
 */
export function unlinkSkills(): { removed: string[] } {
  const removed: string[] = [];

  for (const target of SKILL_TARGETS) {
    for (const skillName of BUNDLED_SKILLS) {
      const linkPath = path.join(homedir(), target.dir, skillName);
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(linkPath);
          removed.push(`${target.cli}: ${skillName}`);
        }
      } catch {
 // 不存在
      }
    }
  }

  return { removed };
}
