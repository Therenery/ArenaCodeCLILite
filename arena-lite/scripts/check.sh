#!/usr/bin/env bash
# 没有 cargo 时的等价构建脚本：直接用 rustc 编。
#
# 这个 crate 零第三方依赖，所以 cargo 唯一多做的事就是解析依赖图 +
# 传一堆 --extern；这里用 rustc 一把过，结果等价。
#
# 有 mingw 时会顺带交叉编出 Windows 的 arena-lite.exe，所以不需要
# 在 Windows 机器上装 Rust。
#
# 用法：
#   scripts/check.sh            # 编 release + 跑单测（有 mingw 再出 exe）
#   scripts/check.sh build      # 产物目录
#   MINGW_GCC=... scripts/check.sh   # 指定链接器
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-build}"
export PATH="${RUSTC_DIR:-}:$PATH"

rustc --version
mkdir -p "$OUT"

echo "==> 编译 release"
rustc --edition 2021 -O -C panic=abort -o "$OUT/arena-lite" src/main.rs

echo "==> 编译测试"
rustc --edition 2021 --test -o "$OUT/arena-lite-tests" src/main.rs

echo "==> 跑单元测试"
"$OUT/arena-lite-tests"

echo "==> 版本自检"
"$OUT/arena-lite" --version

# Windows 交叉编译：本机没装 Windows 时用它出 exe，不需要 PC 上有 Rust。
# 需要两样东西：
#   1. rustc 自带 x86_64-pc-windows-gnu 的 std（离线工具链里就有）
#   2. mingw 的 x86_64-w64-mingw32-gcc 当链接器
# 产物只依赖 KERNEL32/USER32/WS2_32/msvcrt 等系统 DLL，拷过去就能跑。
if rustc --target x86_64-pc-windows-gnu --print sysroot >/dev/null 2>&1; then
  MINGW_GCC="${MINGW_GCC:-}"
  if [ -z "$MINGW_GCC" ]; then
    for c in x86_64-w64-mingw32-gcc x86_64-w64-mingw32-gcc-13-win32 x86_64-w64-mingw32-gcc-13-posix; do
      if command -v "$c" >/dev/null 2>&1; then MINGW_GCC="$c"; break; fi
    done
  fi
  if [ -n "$MINGW_GCC" ]; then
    echo "==> Windows 交叉编译（x86_64-pc-windows-gnu，链接器 $MINGW_GCC）"
    rustc --edition 2021 -O -C panic=abort -C strip=symbols -C codegen-units=1 -C lto=fat \
      --target x86_64-pc-windows-gnu -C linker="$MINGW_GCC" \
      -o "$OUT/arena-lite.exe" src/main.rs
    echo "    产物：$OUT/arena-lite.exe ($(stat -c%s "$OUT/arena-lite.exe") 字节)"
  else
    echo "==> 跳过 Windows 交叉编译：没找到 mingw 的 gcc"
  fi
fi

echo "全部完成。产物在 $OUT/"
