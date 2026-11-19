import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { DOMParser } from '@xmldom/xmldom'
import packageInfo from '../package.json' with { type: 'json' }
import { addinUrl } from '../src/bridge-config.js'

const windows = process.platform === 'win32'
assert.ok(windows || process.platform === 'linux', 'Run the installation smoke test on a disposable Windows or Linux machine')
const extracted = await realpath(process.argv[2])
const probe = createServer().listen(0, '127.0.0.1')
await once(probe, 'listening')
const { port } = probe.address()
await new Promise(resolve => probe.close(resolve))

const temp = await mkdtemp(join(tmpdir(), 'FishPi WPS install '))
const appdata = join(temp, 'AppData', 'Roaming')
const config = join(temp, 'xdg config')
const dataDir = join(temp, '.fishpi-wps')
const manifest = windows
  ? join(appdata, 'kingsoft/wps/jsaddons/publish.xml')
  : join(temp, '.local/share/Kingsoft/wps/jsaddons/publish.xml')
const launcher = windows ? 'install-windows.cmd' : 'install-linux.sh'
const executable = windows ? process.env.ComSpec : '/bin/sh'
const args = windows ? ['/d', '/c', launcher] : [launcher]
const env = {
  ...process.env,
  CI: 'true',
  HOME: temp,
  APPDATA: appdata,
  FISHPI_WPS_DATA_DIR: dataDir,
  FISHPI_WPS_PORT: String(port),
  XDG_CONFIG_HOME: config,
  PATH: windows ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin',
}
let base
try {
  for (const file of ['runtime', 'dist', launcher]) {
    await cp(join(extracted, file), join(temp, file), { recursive: true })
  }
  await mkdir(dirname(manifest), { recursive: true })
  await writeFile(manifest, '<jsplugins><jspluginonline name="existing" debug=""/><jspluginonline name="fishpi-wps" debug="" enable="enable_dev"/></jsplugins>')
  const install = () => promisify(execFile)(executable, args, { cwd: temp, env, timeout: 25_000 })
  await install()
  base = addinUrl(JSON.parse(await readFile(join(dataDir, 'bridge.json'), 'utf8')))
  assert.deepEqual(await (await fetch(new URL('health', base))).json(), { version: packageInfo.version })
  assert.match(await (await fetch(new URL('ribbon.xml', base))).text(), /VisitFishPi/u)
  const xml = new DOMParser().parseFromString(await readFile(manifest, 'utf8'), 'application/xml')
  const entries = Array.from(xml.getElementsByTagName('jspluginonline'))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].getAttribute('name'), 'existing')
  assert.equal(entries[0].hasAttribute('debug'), true)
  assert.ok(entries[1].getAttribute('url') === base, 'Expected FishPi to be registered to the running bridge')
  assert.equal(entries[1].hasAttribute('debug'), false)
  assert.equal(entries[1].hasAttribute('enable'), false)
  if (!windows) {
    const desktop = await readFile(join(config, 'autostart/fishpi-wps.desktop'), 'utf8')
    assert.match(desktop, /^Exec=.*\/dist\/server\.mjs"$/mu)
  }
  await install()
  assert.equal((await fetch(new URL('health', base))).status, 200)
  console.log(`WPS registration, startup setup, initial launch and reinstall passed on ${process.platform}`)
} finally {
  if (base) {
    await fetch(new URL('api/installer/stop', base), {
      method: 'POST',
      headers: { Origin: new URL(base).origin, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    }).catch(() => {})
    await setTimeout(350)
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
}
