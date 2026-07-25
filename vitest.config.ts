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
    // desktop/web 的 React 组件测试需要 jsdom + @testing-library/jest-dom，
    // 由 desktop/web 自己的 vite.config.ts 驱动（`cd desktop/web && npm test`）。
    // 根 vitest 仅跑 node 环境的核心测试，避免 document is not defined。
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/examples/**',
      'tests/trigger-e2e.test.ts',
      'desktop/web/**',
    ],
  },
});
