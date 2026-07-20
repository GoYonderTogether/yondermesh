#!/bin/sh
# 安装 pre-commit 钩子到父仓库与 docs/ 内嵌子仓库。幂等。
# 由 package.json 的 prepare 脚本自动调用（npm install 时即生效），无需手动操作。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
HOOK_SRC="$HERE/hooks/pre-commit"

install_hook() {
  git_dir="$1"
  if [ -d "$git_dir" ]; then
    mkdir -p "$git_dir/hooks"
    cp "$HOOK_SRC" "$git_dir/hooks/pre-commit"
    chmod +x "$git_dir/hooks/pre-commit"
    echo "[setup-hooks] 已安装 pre-commit → $git_dir/hooks/pre-commit"
  fi
}

# 父仓库
install_hook "$REPO/.git"
# docs/ 内嵌独立 git 仓库
install_hook "$REPO/docs/.git"

echo "[setup-hooks] 完成。"
