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
  },
});
