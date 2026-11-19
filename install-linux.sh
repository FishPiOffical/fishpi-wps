#!/bin/sh
set -eu
cd "$(dirname "$0")"

if [ -x runtime/bin/node ]; then
  exec ./runtime/bin/node dist/install.mjs "$@"
fi
if ! command -v node >/dev/null || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)'; then
  printf '%s\n' '请先安装 Node.js 22.16 或更新版本。' >&2
  exit 1
fi
if [ -f package.json ]; then
  if [ ! -d node_modules/esbuild ] || [ ! -d node_modules/@xmldom/xmldom ]; then
    npm ci
  fi
  npm run build
fi
node dist/install.mjs "$@"
