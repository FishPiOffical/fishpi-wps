import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { registerAddin, registeredBridgeUrls, unregisterAddin } from '../src/registration.js'

test('WPS registration removes FishPi debugging settings and preserves other add-ins', () => {
  const other = '<jspluginonline name="existing" url="https://example.test/" debug=""/>'
  const url = 'http://127.0.0.1:36796/example/'
  const old = '<jspluginonline name="fishpi-wps" url="http://localhost:36796/" debug="" enable="enable_dev"/>'
  const xml = registerAddin(`<jsplugins><!-- keep -->${other}${old}</jsplugins>`, url)
  assert.ok(xml.includes(other))
  assert.ok(xml.includes('<!-- keep -->'))
  const fishpi = xml.match(/<jspluginonline name="fishpi-wps"[^>]*\/>/u)?.[0]
  assert.ok(fishpi?.includes('type="wps"'))
  assert.ok(fishpi?.includes(`url="${url}"`))
  assert.doesNotMatch(fishpi, /debug=|enable=/u)
  assert.equal(registerAddin(xml, url), xml)
  assert.throws(() => registerAddin('<broken/>', url), /格式无效/u)
})

test('the website ribbon button opens the official FishPi site through WPS', async () => {
  const script = await readFile(new URL('../static/ribbon.js', import.meta.url), 'utf8')
  const opened = []
  const window = {
    location: { href: 'http://127.0.0.1/fishpi/' },
    Application: { OAAssist: { ShellExecute: url => opened.push(url) } },
  }
  runInNewContext(script, { window, URL })
  assert.equal(window.VisitFishPi(), true)
  assert.deepEqual(opened, ['https://fishpi.cn'])
})

test('uninstall removes just the FishPi add-in and is safe to repeat', () => {
  const other = '<jspluginonline name="existing" debug=""/>'
  const xml = `<jsplugins><!-- keep -->${other}<jspluginonline name="fishpi-wps"/><jspluginonline name="fishpi-wps"/></jsplugins>`
  const removed = unregisterAddin(xml)
  assert.equal(removed, `<jsplugins><!-- keep -->${other}</jsplugins>\n`)
  assert.equal(unregisterAddin(removed), removed)
})

test('uninstall can find a legacy bridge URL in WPS when the bridge config is missing', () => {
  const url = `http://127.0.0.1:36796/${'a'.repeat(64)}/`
  const xml = `<jsplugins><jspluginonline name="fishpi-wps" url="${url}"/>
    <jspluginonline name="fishpi-wps" url="https://example.test/"/>
    <jspluginonline name="other" url="${url}"/></jsplugins>`
  assert.deepEqual(registeredBridgeUrls(xml), [url])
})

test('loopback bridge serves the WPS pages and protects chat and gallery requests', { timeout: 7000 }, async t => {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  const dataDir = await mkdtemp(join(tmpdir(), 'fishpi-wps-test-'))
  const server = fileURLToPath(new URL('../dist/server.mjs', import.meta.url))
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, FISHPI_WPS_DATA_DIR: dataDir, FISHPI_WPS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exit = once(child, 'exit')
  t.after(async () => {
    child.kill()
    await exit
    await rm(dataDir, { recursive: true, force: true })
  })
  await Promise.race([once(child.stdout, 'data'), exit.then(() => assert.fail('Bridge terminated at startup'))])
  const { token } = JSON.parse(await readFile(join(dataDir, 'bridge.json'), 'utf8'))
  const origin = `http://127.0.0.1:${port}`
  const url = path => `${origin}/${token}/${path}`
  const post = (path, body, source = origin) => fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: source },
    body: JSON.stringify(body),
  })

  assert.equal((await fetch(`${origin}/ribbon.xml`)).status, 404)
  assert.match(await (await fetch(url('ribbon.xml'))).text(), /OpenFishPiChat/u)
  assert.match(await (await fetch(url('taskpane.html'))).text(), /taskpane\.js/u)
  assert.equal((await (await fetch(url('health'))).json()).nativeClipboard, process.platform === 'darwin')
  const state = { name: 'fishpi_state', arguments: {} }
  assert.equal((await post('api/chat', state, 'https://example.test')).status, 403)
  assert.equal((await post('api/clipboard/image', {}, 'https://example.test')).status, 403)
  assert.equal((await fetch(url('api/clipboard/image'))).status, 404)
  assert.equal((await (await post('api/chat', state)).json()).structuredContent.loggedIn, false)

  const gallery = { index: 1, images: ['A', 'B'].map(alt => ({ src: `https://fishpi.cn/${alt}.png`, alt })) }
  assert.equal((await post('api/gallery', { ...gallery, index: 2 })).status, 400)
  const { id } = await (await post('api/gallery', gallery)).json()
  assert.deepEqual(await (await fetch(url(`api/gallery?id=${id}`))).json(), gallery)
  assert.equal((await fetch(`${origin}/api/gallery?id=${id}`)).status, 404)
  assert.equal((await post('api/installer/stop', {}, 'https://example.test')).status, 403)
  assert.equal((await post('api/installer/stop', {})).status, 200)
  assert.deepEqual(await exit, [0, null])
})
