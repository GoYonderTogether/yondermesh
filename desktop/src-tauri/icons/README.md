# 应用图标（占位）

本目录需放置 Tauri 打包所需图标。脚手架阶段未提供真实二进制图标，
请在正式打包前生成，否则 `tauri build` 会因缺图标失败（`tauri dev` 不受影响）。

## 一键生成（推荐）

准备一张 1024x1024 的 PNG 源图（如 `icon-source.png`），在 `apps/desktop` 下执行：

```bash
npm run tauri -- icon path/to/icon-source.png
```

Tauri CLI 会自动在本目录生成全部所需尺寸/格式。

## tauri.conf.json 引用到的文件清单

- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns`（macOS）
- `icon.ico`（Windows）

> 提示：`tauri dev` 期间即使缺图标也能起窗口调试；正式 `tauri build` 前务必补齐。
