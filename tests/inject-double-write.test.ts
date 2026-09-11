/**
 * I3（P0）回归测试：inject 的双写保护 + 回读验证。
 * 不真的 spawn pi —— 只验证「活跃 session 拒绝」这条安全闸门。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PiController } from '../src/pi/wrapper.js';

describe('PiController.inject 双写保护', () => {
  let home: string;
  let sessionsDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pi-inject-'));
    sessionsDir = join(home, '.pi', 'agent', 'sessions', '--proj--');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeController(): PiController {
    return new PiController({
      flavors: [
        {
          source: 'pi',
          cli: 'pi',
          configDir: join(home, '.pi', 'agent'),
          sessionsDirs: [join(home, '.pi', 'agent', 'sessions')],
          sessionsDir: join(home, '.pi', 'agent', 'sessions'),
          glmModelArg: '--model glm/glm-5.2',
        },
      ],
    } as never);
  }

  function writeSession(id: string): string {
    const file = join(sessionsDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({
        type: 'session',
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: '/proj',
      }) + '\n',
    );
    return file;
  }

  it('对刚写入过的（活跃）session 默认拒绝注入，并说明原因与出路', async () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    writeSession(id); // mtime = 现在 → 视为活跃
    const err = await makeController()
      .inject(id, 'hello', 'pi')
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('拒绝注入');
    expect(err!.message).toContain('--force');
    expect(err!.message).toContain('ymesh send');
  });
});
