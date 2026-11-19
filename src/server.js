import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { z } from 'zod'
import { actions, chat } from './actions.js'
import { bridgeConfig, originFor } from './bridge-config.js'
import { FishPiError, PLUGIN_VERSION } from './fishpi.js'

const { port, token } = await bridgeConfig()
const origin = originFor(port)
const prefix = `/${token}/`
const assets = new Map([
  ['', 'index.html'],
  ['index.html', 'index.html'],
  ['manifest.xml', 'manifest.xml'],
  ['ribbon.xml', 'ribbon.xml'],
  ['ribbon.js', 'ribbon.js'],
  ['taskpane.html', 'taskpane.html'],
  ['taskpane.js', 'taskpane.js'],
  ['gallery.html', 'gallery.html'],
  ['gallery.js', 'gallery.js'],
  ['chat.css', 'chat.css'],
  ['assets/icon.png', 'assets/icon.png'],
])
const types = { html: 'text/html; charset=utf-8', xml: 'application/xml; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png' }
const json = 'application/json; charset=utf-8'
const maxBody = 512 * 1024
const galleries = new Map()
const galleryInput = z.object({
  index: z.number().int().nonnegative(),
  images: z.array(z.object({ src: z.url({ protocol: /^https?$/u }).max(4096), alt: z.string().max(256) })).min(1).max(200),
}).refine(value => value.index < value.images.length)
const rpcInput = z.object({
  name: z.string(),
  arguments: z.unknown(),
})

function reply(res, status, type, data) {
  if (res.destroyed) return
  res.writeHead(status, { 'Content-Type': type })
  res.end(data)
}

function send(res, status, data) {
  reply(res, status, json, JSON.stringify(data))
}

async function readInput(req) {
  const buffers = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > maxBody) throw new FishPiError('请求内容过大', { status: 413, code: 'invalid_input' })
    buffers.push(chunk)
  }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'))
}

function saveGallery(input) {
  const gallery = galleryInput.parse(input)
  for (const [id, value] of galleries) {
    if (value.expires <= Date.now()) galleries.delete(id)
  }
  if (galleries.size >= 16) galleries.delete(galleries.keys().next().value)
  const id = randomUUID()
  galleries.set(id, { gallery, expires: Date.now() + 20 * 60_000 })
  return { id }
}

async function handle(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    "img-src 'self' data: https://fishpi.cn https://*.fishpi.cn https://www.gravatar.com https://cravatar.cn https://weavatar.com https://avatars.githubusercontent.com",
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  ].join('; '))

  if (req.headers.host !== `127.0.0.1:${port}` || !req.url?.startsWith(prefix)) {
    return send(res, 404, { ok: false })
  }
  const url = new URL(req.url, origin)
  const path = url.pathname.slice(prefix.length)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const asset = assets.get(path)
    if (asset) {
      const body = await readFile(new URL(`./web/${asset}`, import.meta.url))
      return reply(res, 200, types[asset.split('.').at(-1)], req.method === 'HEAD' ? undefined : body)
    }
    if (path === 'health') return send(res, 200, { version: PLUGIN_VERSION })
    if (path === 'api/gallery') {
      const entry = galleries.get(url.searchParams.get('id'))
      if (entry?.expires > Date.now()) return send(res, 200, entry.gallery)
    }
    return send(res, 404, { ok: false })
  }
  if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return send(res, 403, { ok: false })
  }
  if (path === 'api/installer/stop') {
    res.once('finish', stop)
    return send(res, 200, { ok: true })
  }
  if (path === 'api/gallery') return send(res, 200, saveGallery(await readInput(req)))
  if (path !== 'api/chat') return send(res, 404, { ok: false })

  const request = rpcInput.parse(await readInput(req))
  const action = actions.get(request.name)
  if (!action) return send(res, 404, { isError: true, structuredContent: { ok: false, code: 'invalid_input' } })
  const controller = new AbortController()
  res.once('close', () => controller.abort())
  const data = await action.run(action.schema.parse(request.arguments), { signal: controller.signal })
  return send(res, 200, { structuredContent: data, content: [] })
}

const server = createServer((req, res) => {
  void handle(req, res).catch(error => {
    const known = error instanceof FishPiError
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError
    if (!known && !invalid) console.error('[fishpi-wps] Local bridge request failed', error.name)
    const code = known ? error.code : invalid ? 'invalid_input' : 'internal'
    const status = known && error.status >= 400 && error.status < 600 ? error.status : invalid ? 400 : 500
    const message = known ? error.message : invalid ? '请求参数无效' : '摸鱼派操作失败'
    send(res, status, { isError: true, structuredContent: { ok: false, code, status, message } })
  })
})
server.on('error', error => {
  console.error('[fishpi-wps] Local bridge failed to listen', error.code)
  process.exitCode = 1
})
server.listen(port, '127.0.0.1', () => console.log(`摸鱼派 WPS 本地服务已运行，端口 ${port}`))
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, stop)
}

function stop() {
  chat.dispose()
  server.close()
  server.closeAllConnections()
}
