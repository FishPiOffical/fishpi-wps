import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = join(root, 'dist')
const web = join(out, 'web')
await mkdir(web, { recursive: true })

await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: { taskpane: 'src/app.js', gallery: 'src/gallery.js' },
    outdir: web,
    bundle: true,
    minify: true,
    target: 'chrome89',
    format: 'esm',
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  build({
    absWorkingDir: root,
    entryPoints: { server: 'src/server.js', install: 'scripts/install.mjs' },
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    legalComments: 'eof',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  }),
  cp(join(root, 'static'), web, { recursive: true }),
  cp(join(root, 'src', 'chat.css'), join(web, 'chat.css')),
])

for (const [page, title] of [['taskpane', '摸鱼派聊天室'], ['gallery', '查看大图']]) {
  await writeFile(join(web, `${page}.html`), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="./chat.css">
</head>
<body>
  <div id="app"><div class="fc-empty" role="status">摸鱼派 · …</div></div>
  <script type="module" src="./${page}.js"></script>
</body>
</html>
`)
}
