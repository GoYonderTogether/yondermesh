#!/usr/bin/env bash
# 把「修复无法运行问题.command」塞进【已签名】的 macOS dmg，并重新签名 Developer ID。
#
# 背景：Apple 公证过渡期（公证服务慢/未就绪）发的 dmg 缺公证票据，用户下载双击报「已损坏」。
# 在 dmg 里放一个双击运行的 .command，自动 xattr 去 quarantine 即可启动（免用户开终端）。
# 注：本脚本只用于「未公证过渡版」。公证版（staple 装订后）无需 .command——加了反而会破坏 staple。
#
# 前置：dmg 已用 Developer ID 签名（见 release.sh / APPLE_SIGNING_IDENTITY）。
# 用法：bash scripts/pack-dmg-with-fix.sh [签名dmg路径]
#   缺省取 desktop/src-tauri/target/release/bundle/dmg 下最新 .dmg
#   env：APPLE_SIGNING_IDENTITY（占位，由 CI/本地 env 注入）
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FIX_CMD="desktop/src-tauri/dmg-resources/修复无法运行问题.command"
[ -f "$FIX_CMD" ] || { echo "!! 缺修复脚本 $FIX_CMD"; exit 1; }

SRC="${1:-$(ls -t desktop/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)}"
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "!! 未找到签名 dmg：$SRC"; exit 1; }

# 占位：未在仓库内硬编码真实 Developer ID，由 env 注入。
SIGN="${APPLE_SIGNING_IDENTITY:?需 env APPLE_SIGNING_IDENTITY（如 'Developer ID Application: Your Name (TEAMID)')}"

WORK="$(mktemp -d)"
RW="$WORK/ymesh-rw.dmg"
OUT="$WORK/with-fix.dmg"
MNT="$WORK/mnt"
FIX_NAME="$(basename "$FIX_CMD")"

echo "[pack-dmg] 源：$SRC"
echo "[pack-dmg] 转可写…"
hdiutil convert "$SRC" -format UDRW -ov -o "$RW" >/dev/null
mkdir -p "$MNT"
hdiutil attach "$RW" -nobrowse -mountpoint "$MNT" >/dev/null
cp "$FIX_CMD" "$MNT/"
chmod +x "$MNT/$FIX_NAME"
hdiutil detach "$MNT" >/dev/null
echo "[pack-dmg] 转回压缩只读…"
hdiutil convert "$RW" -format UDZO -ov -o "$OUT" >/dev/null
echo "[pack-dmg] 重签 Developer ID…"
codesign --sign "$SIGN" --force --timestamp "$OUT"
codesign --verify --strict "$OUT" && echo "[pack-dmg] [Y] 签名验证通过"

# 覆盖回原路径，供 upload-mac-dmg-oss.sh 自动取最新上传
cp "$OUT" "$SRC"
rm -rf "$WORK"
echo "[pack-dmg] OK → $SRC（已含 $FIX_NAME，待上传）"
echo "[pack-dmg] 上传：export YMESH_ECS_PASS=...; bash scripts/upload-mac-dmg-oss.sh \"$SRC\""
