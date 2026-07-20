// scripts/docs/features-lib.test.mjs
// 解析器与校验逻辑的单测。Run: npx vitest run scripts/docs/features-lib.test.mjs

import { describe, it, expect } from 'vitest';
import { parseFeaturesYaml, validateFeature, checkCodePaths } from './features-lib.mjs';

const SAMPLE = `# header comment
features:
  - id: collect
    name: 采集
    category: A-接入
    stage: 1
    status: shipped
    code: [src/adapters/, src/store/]
  - id: distill
    name: 蒸馏
    category: C-懂你
    stage: 2
    status: building
    code: []
`;

describe('parseFeaturesYaml', () => {
  it('解析多条 feature', () => {
    const f = parseFeaturesYaml(SAMPLE);
    expect(f).toHaveLength(2);
    expect(f[0].id).toBe('collect');
    expect(f[0].name).toBe('采集');
    expect(f[0].stage).toBe(1);
    expect(f[0].code).toEqual(['src/adapters/', 'src/store/']);
  });

  it('解析空 code 数组', () => {
    const f = parseFeaturesYaml(SAMPLE);
    expect(f[1].code).toEqual([]);
  });

  it('忽略注释与空行', () => {
    const f = parseFeaturesYaml('# only a comment\n\n');
    expect(f).toHaveLength(0);
  });

  it('status 与字符串字段正确解析', () => {
    const f = parseFeaturesYaml(SAMPLE);
    expect(f[1].status).toBe('building');
    expect(f[1].category).toBe('C-懂你');
  });
});

describe('validateFeature', () => {
  const base = { id: 'x', name: 'x', category: 'A', stage: 1, status: 'shipped', code: [] };

  it('完整合法 feature 无错误', () => {
    expect(validateFeature(base)).toHaveLength(0);
  });

  it('缺字段报错', () => {
    const { status, ...noStatus } = base;
    expect(validateFeature(noStatus).some((e) => e.includes('status'))).toBe(true);
  });

  it('非法 status 报错', () => {
    expect(validateFeature({ ...base, status: 'lol' }).some((e) => e.includes('非法'))).toBe(true);
  });

  it('stage 非整数报错', () => {
    expect(validateFeature({ ...base, stage: 'abc' }).some((e) => e.includes('整数'))).toBe(true);
  });
});

describe('checkCodePaths', () => {
  it('存在的路径不报缺失', () => {
    const missing = checkCodePaths({ code: ['scripts/docs/'] });
    expect(missing).toEqual([]);
  });

  it('不存在的路径报缺失', () => {
    const missing = checkCodePaths({ code: ['no/such/dir/'] });
    expect(missing).toEqual(['no/such/dir/']);
  });

  it('空 code 不报缺失', () => {
    expect(checkCodePaths({ code: [] })).toEqual([]);
  });
});
