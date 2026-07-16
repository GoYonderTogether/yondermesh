import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // node:* 内置模块（如实验性 node:sqlite）交给 Node 运行时解析，
    // 不经 vite 预优化，否则会被当成裸包找不到。
    server: {
      deps: {
        external: [/^node:/],
      },
    },
    // 独立脚本（用 `npx tsx` 直接跑，非 vitest 单元测试）与外部示例项目排除
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/examples/**',
      'tests/trigger-e2e.test.ts',
    ],
  },
});
