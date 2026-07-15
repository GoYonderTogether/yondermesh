// scripts/docs/verify-links.mjs
//
// Verify internal markdown links inside site/ resolve to actual files.
// Catches renamed/deleted pages that leave dangling links in the sidebar or
// page bodies. External http(s) links are skipped.
//
// Run:  node scripts/docs/verify-links.mjs
// CI:   .github/workflows/docs-check.yml runs this on every PR.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const siteRoot = join(repoRoot, 'site');

const errors = [];
const checked = [];

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'cache') continue;
      walk(p);
    } else if (e.name.endsWith('.md')) {
      checkFile(p);
    }
  }
}

function resolveLink(fromFile, link) {
  // VitePress internal links start with / and are relative to site root.
  if (link.startsWith('/')) {
    // Strip leading slash, then try as file or with .md
    let rel = link.slice(1);
    rel = rel.replace(/(#.+)$/, '');
    const candidates = [
      join(siteRoot, rel),
      join(siteRoot, rel + '.md'),
      join(siteRoot, rel, 'index.md'),
    ];
    return candidates.find((c) => existsSync(c));
  }
  // Relative links (./foo, ../foo)
  if (link.startsWith('./') || link.startsWith('../')) {
    let rel = link.replace(/(#.+)$/, '');
    const base = dirname(fromFile);
    const candidates = [
      resolve(base, rel),
      resolve(base, rel + '.md'),
      resolve(base, rel, 'index.md'),
    ];
    return candidates.find((c) => existsSync(c));
  }
  // External / mailto / etc — skip.
  return 'skip';
}

function checkFile(file) {
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  const linkRe = /\[[^\]]+\]\(([^)]+)\)/g;
  lines.forEach((line, idx) => {
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const link = m[1];
      const target = resolveLink(file, link);
      if (target === 'skip') return;
      checked.push({ file: relative(siteRoot, file), line: idx + 1, link });
      if (!target) {
        errors.push(`${relative(siteRoot, file)}:${idx + 1}  broken link: ${link}`);
      }
    }
  });
}

walk(siteRoot);

console.log(`[verify-links] checked ${checked.length} internal links across ${siteRoot.replace(repoRoot + '/', '')}/`);
if (errors.length === 0) {
  console.log('[verify-links] all internal links resolve.');
  process.exit(0);
}
console.error(`[verify-links] ${errors.length} broken link(s):`);
for (const e of errors) console.error('  ' + e);
process.exit(1);
