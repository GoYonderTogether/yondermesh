#!/usr/bin/env bash
#
# yondermesh 一键安装 / 更新脚本
#
# 用法：
#   # 方式一：远程一键安装（新用户）
#   curl -fsSL https://raw.githubusercontent.com/GoYonderTogether/yondermesh/main/install.sh | bash
#
#   # 方式二：本地克隆后安装
#   git clone https://github.com/GoYonderTogether/yondermesh.git && cd yondermesh && ./install.sh
#
#   # 方式三：已安装用户更新到最新版
#   curl -fsSL https://raw.githubusercontent.com/GoYonderTogether/yondermesh/main/install.sh | bash
#
# 行为：
#   - 检测 node / git 是否可用
#   - 如果已安装 ymesh（~/.yondermesh/bin/ymesh 存在），走更新流程
#   - 如果未安装，clone 源码到临时目录 → npm ci → 构建 → 安装 release
#   - 自动将 ~/.yondermesh/bin 加入 PATH（写入 shell rc）
#
set -euo pipefail

# ── 配置 ──────────────────────────────────────────────────────────────────

REPO_URL="${YONDERMESH_REPO:-https://github.com/GoYonderTogether/yondermesh.git}"
BRANCH="${YONDERMESH_BRANCH:-main}"
DATA_DIR="${YONDERMESH_HOME:-$HOME/.yondermesh}"
BIN_DIR="$DATA_DIR/bin"
ENTRY="$BIN_DIR/ymesh"

# ── 颜色 ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[ymesh]${NC} $*"; }
ok()    { echo -e "${GREEN}[ymesh]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ymesh]${NC} $*"; }
die()   { echo -e "${RED}[ymesh] 错误:${NC} $*" >&2; exit 1; }

# ── 前置检查 ──────────────────────────────────────────────────────────────

check_cmd() {
  command -v "$1" >/dev/null 2>&1
}

info "检查依赖..."

if ! check_cmd git; then
  die "未找到 git，请先安装 git。"
fi

if ! check_cmd node; then
  die "未找到 node，请先安装 Node.js >= 20（推荐 fnm 或 nvm）。"
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node 版本过低 ($NODE_MAJOR)，需要 >= 20。"
fi

if ! check_cmd npm; then
  die "未找到 npm，请随 Node.js 一起安装。"
fi

ok "依赖检查通过（node $(node -v), git $(git --version | cut -d' ' -f3)）"

# ── 已安装 → 走更新流程 ───────────────────────────────────────────────────

if [ -x "$ENTRY" ]; then
  CURRENT_VER=$(node "$ENTRY" version 2>/dev/null | head -1 || echo "unknown")
  info "检测到已安装版本：$CURRENT_VER"
  info "执行更新..."

  # 尝试直接用 ymesh update（它会 git clone staging、npm ci、构建、安装、健康检查）
  if node "$ENTRY" update; then
    ok "更新完成。"
    NEW_VER=$(node "$ENTRY" version 2>/dev/null | head -1 || echo "unknown")
    info "当前版本：$NEW_VER"
    exit 0
  else
    warn "ymesh update 失败（可能需要手动排查），尝试从源码全新安装..."
    # 继续走全新安装流程
  fi
else
  info "未检测到已安装的 ymesh，开始全新安装..."
fi

# ── 全新安装 ──────────────────────────────────────────────────────────────

STAGING=$(mktemp -d /tmp/yondermesh-install.XXXXXX)
info "克隆源码到临时目录：$STAGING"

git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$STAGING"

info "安装依赖..."
npm ci --prefix "$STAGING"

info "编译 TypeScript..."
npm run build --prefix "$STAGING"

info "构建并安装 release..."
mkdir -p "$DATA_DIR" "$BIN_DIR" "$DATA_DIR/releases"
export YONDERMESH_HOME="$DATA_DIR"
node "$STAGING/dist/bin/ymesh.js" install --force

ok "安装完成！"
CURRENT_VER=$(node "$ENTRY" version 2>/dev/null | head -1 || echo "unknown")
info "版本：$CURRENT_VER"

# 清理 staging
rm -rf "$STAGING"

# ── PATH 设置 ─────────────────────────────────────────────────────────────

setup_path() {
  local rc_file=""

  # 检测当前 shell 的 rc 文件
  case "${SHELL:-}" in
    */zsh)  rc_file="$HOME/.zshrc" ;;
    */bash) rc_file="$HOME/.bashrc" ;;
    *)      rc_file="" ;;
  esac

  if [ -z "$rc_file" ]; then
    warn "无法自动检测 shell rc 文件，请手动将以下行加入你的 shell 配置："
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    return
  fi

  local marker='# yondermesh PATH'
  if grep -qF "$marker" "$rc_file" 2>/dev/null; then
    # 已经配置过
    return
  fi

  echo "" >> "$rc_file"
  echo "$marker" >> "$rc_file"
  echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$rc_file"
  ok "已将 PATH 写入 $rc_file"
  warn "请运行 source $rc_file 或重新打开终端以生效。"
}

setup_path

# ── 完成提示 ──────────────────────────────────────────────────────────────

echo ""
ok "yondermesh 安装成功！"
echo ""
info "快速开始："
echo "  ymesh scan        # 扫描全部 session"
echo "  ymesh status      # 查看状态"
echo "  ymesh sessions    # 列出 session"
echo "  ymesh daemon      # 启动后台监听"
echo "  ymesh service install  # 注册为 macOS 后台服务"
echo ""
