#!/bin/zsh
set -e
cd -- "${0:A:h}"
if [[ -x runtime/bin/node ]]; then
  exec ./runtime/bin/node dist/install.mjs
fi
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null || ! node -e 'const [major,minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)'; then
  node_versions=("$HOME"/.nvm/versions/node/*/bin(N))
  for node_bin in ${(On)node_versions}; do
    if "$node_bin/node" -e 'const [major,minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)'; then
      export PATH="$node_bin:$PATH"
      break
    fi
  done
fi
if ! command -v node >/dev/null || ! node -e 'const [major,minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 16) ? 0 : 1)'; then
  print -u2 '请先安装 Node.js 22.16 或更新版本。'
  exit 1
fi
if [[ -f package.json ]]; then
  if [[ ! -d node_modules/esbuild || ! -d node_modules/@xmldom/xmldom ]]; then
    npm ci
  fi
  npm run build
fi
node dist/install.mjs
