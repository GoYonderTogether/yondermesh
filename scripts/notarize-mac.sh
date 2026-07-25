#!/usr/bin/env bash
# macOS dmg 非阻塞公证 + 装订。
#
# 为何独立：Tauri 内置 notarize 用 `notarytool submit --wait` 阻塞等 Apple 结果，
# 实测 >10 分钟，在自动化/后台脚本里必被超时杀掉（dmg 永远卡在 Notarizing）。
# 本脚本拆成：签名版 dmg → 非阻塞 submit（立即拿 ID）→ 短查询轮询至 Accepted → stapler 装订 → spctl 校验。
# 每步都是短命令，不再长阻塞。
#
# 前置：dmg 已用 Developer ID 签名（见 release.sh 的 APPLE_SIGNING_IDENTITY）。
# 用法：bash scripts/notarize-mac.sh [dmg路径]
#   缺省取 desktop/src-tauri/target/release/bundle/dmg 下最新 .dmg
#   凭据 env（缺省读 ~/.appstoreconnect/）：APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Apple 公证凭据：env 优先，否则读 ~/.appstoreconnect/ 默认路径。
# 占位：未在仓库内硬编码真实 KEY_ID/ISSUER，由 CI/本地 env 注入。
KEY_ID="${APPLE_API_KEY:-}"
ISSUER="${APPLE_API_ISSUER:-$(tr -d ' \n' < "$HOME/.appstoreconnect/issuer_id" 2>/dev/null || true)}"
KEY_PATH="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8}"

if [ -z "$KEY_ID" ] || [ -z "$ISSUER" ] || [ ! -f "$KEY_PATH" ]; then
  echo "!! 缺公证凭据（APPLE_API_KEY/ISSUER/KEY_PATH，见 docs/deploy/secrets/apple.md）"; exit 1
fi

DMG="${1:-$(ls -t desktop/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)}"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "!! 未找到 .dmg（先出签名版：APPLE_SIGNING_IDENTITY=... npm run build --prefix desktop）：$DMG"; exit 1
fi

echo "[notarize] $(basename "$DMG")"
echo "[notarize] 提交（非阻塞）..."
SUBMIT_OUT="$(xcrun notarytool submit "$DMG" --key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>&1)"
SUB_ID="$(printf '%s\n' "$SUBMIT_OUT" | grep -oiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
printf '%s\n' "$SUB_ID" > /tmp/ymesh-notary-id.txt
echo "[notarize] Submission ID: $SUB_ID"
echo "[notarize] 轮询结果（每 30s，直到终态）..."

while true; do
  sleep 30
  INFO="$(xcrun notarytool info "$SUB_ID" --key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>/dev/null || true)"
  STATUS="$(printf '%s\n' "$INFO" | grep -iE "status:" | head -1 | awk '{print tolower($2)}')"
  echo "  status: ${STATUS:-unknown}"
  case "${STATUS:-}" in
    accepted)
      echo "[notarize] [Y] 公证通过，装订 staple..."
      break ;;
    rejected|invalid)
      echo "[notarize] [N] 公证被拒，日志："
      xcrun notarytool log "$SUB_ID" --key "$KEY_PATH" --key-id "$KEY_ID" --issuer "$ISSUER" 2>&1 | tail -50
      exit 1 ;;
  esac
done

# stapler 装订公证票据到 dmg（离线也能验证）
xcrun stapler staple "$DMG"
echo "[notarize] spctl 校验（期望 accepted / source=Notarized Developer ID）"
spctl -a -vvv "$DMG" 2>&1 | head -6 || true
echo "[notarize] OK → $DMG （可上传 OSS）"
