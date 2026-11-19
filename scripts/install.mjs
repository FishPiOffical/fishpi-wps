import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { addinUrl, bridgeConfig, dataDir } from '../src/bridge-config.js'
import { registerAddin } from '../src/registration.js'

const command = promisify(execFile)
const home = homedir()
const platform = process.platform
const macContainer = join(home, 'Library/Containers/com.kingsoft.wpsoffice.mac')
const macManifest = join(macContainer, 'Data/.kingsoft/wps/jsaddons/publish.xml')
const server = fileURLToPath(new URL('./server.mjs', import.meta.url))
const label = 'com.fishpi.wps.bridge'
const service = join(home, 'Library/LaunchAgents', `${label}.plist`)
const gui = `gui/${process.getuid?.()}`
const escapeXml = value => value.replace(/[&<>]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])

async function stageFile(path, contents) {
  const file = join(dirname(path), `.fishpi-wps-${randomUUID()}.tmp`)
  await writeFile(file, contents, { flag: 'wx', mode: 0o600 })
  return file
}

function manifestPath() {
  if (platform === 'darwin') return macManifest
  if (platform === 'linux') return join(home, '.local/share/Kingsoft/wps/jsaddons/publish.xml')
  if (platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'kingsoft', 'wps', 'jsaddons', 'publish.xml')
  }
  throw new Error('无法确定当前系统的 WPS 加载项目录')
}

async function startMacBridge() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>RunAtLoad</key><true/>
  <key>ProgramArguments</key><array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(server)}</string></array>
  <key>EnvironmentVariables</key><dict><key>FISHPI_WPS_DATA_DIR</key><string>${escapeXml(dataDir)}</string></dict>
  <key>StandardOutPath</key><string>${escapeXml(join(dataDir, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(dataDir, 'bridge-error.log'))}</string>
</dict></plist>
`
  await mkdir(dirname(service), { recursive: true })
  const staged = await stageFile(service, plist)
  try {
    const loaded = await command('/bin/launchctl', ['print', `${gui}/${label}`]).then(() => true, () => false)
    if (loaded) await command('/bin/launchctl', ['bootout', `${gui}/${label}`])
    await rename(staged, service)
    await command('/bin/launchctl', ['bootstrap', gui, service])
  } finally {
    await rm(staged, { force: true })
  }
}

async function installWindowsStartup() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$directory = [Environment]::GetFolderPath('Startup', 'Create')
if (-not $directory) { throw 'Windows Startup folder was not found' }
$shortcut = $shell.CreateShortcut((Join-Path $directory 'FishPi WPS Bridge.lnk'))
$shortcut.TargetPath = $env:FISHPI_WPS_NODE
$shortcut.Arguments = '"' + $env:FISHPI_WPS_SERVER + '"'
$shortcut.WindowStyle = 7
$shortcut.Description = 'FishPi WPS local bridge'
$shortcut.Save()
`
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  await command(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
    env: { ...process.env, FISHPI_WPS_NODE: process.execPath, FISHPI_WPS_SERVER: server },
  })
}

function desktopArgument(value) {
  return `"${value.replace(/(["`$\\])/gu, '\\$1').replace(/%/gu, '%%')}"`
    .replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/\r/gu, '\\r')
}

async function installLinuxStartup() {
  const directory = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'fishpi-wps.desktop')
  const args = ['/usr/bin/env', `FISHPI_WPS_DATA_DIR=${dataDir}`, process.execPath, server]
  const desktop = `[Desktop Entry]\nType=Application\nName=FishPi WPS Bridge\nExec=${args.map(desktopArgument).join(' ')}\nTerminal=false\n`
  const staged = await stageFile(file, desktop)
  try {
    await rename(staged, file)
  } finally {
    await rm(staged, { force: true })
  }
}

function bridgeReady(url) {
  return fetch(new URL('health', url), { signal: AbortSignal.timeout(500), redirect: 'error' })
    .then(response => response.ok, () => false)
}

async function waitForBridge(url, expectedReady) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await bridgeReady(url) === expectedReady) return true
    await setTimeout(250)
  }
  return false
}

async function startDesktopBridge(url) {
  if (await bridgeReady(url)) {
    const response = await fetch(new URL('api/installer/stop', url), {
      method: 'POST',
      headers: { Origin: new URL(url).origin, 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok || !await waitForBridge(url, false)) throw new Error('无法停止已有的摸鱼派本地服务')
  }
  const log = await open(join(dataDir, 'bridge-error.log'), 'a', 0o600)
  try {
    const child = spawn(process.execPath, [server], {
      detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  } finally {
    await log.close()
  }
}

async function install() {
  const manifest = manifestPath()
  await access(server)
  if (platform === 'darwin') await access(macContainer)
  const oldXml = await readFile(manifest, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '<jsplugins/>'
    throw error
  })
  const url = addinUrl(await bridgeConfig())
  const xml = registerAddin(oldXml, url)
  await mkdir(dirname(manifest), { recursive: true })
  const staged = await stageFile(manifest, xml)
  try {
    if (platform === 'darwin') await startMacBridge()
    else await startDesktopBridge(url)
    if (!await waitForBridge(url, true)) {
      throw new Error(`本地服务未能启动，请查看 ${join(dataDir, 'bridge-error.log')}`)
    }
    if (platform === 'win32') await installWindowsStartup()
    if (platform === 'linux') await installLinuxStartup()
    const currentXml = await readFile(manifest, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '<jsplugins/>'
      throw error
    })
    if (currentXml !== oldXml) throw new Error('WPS 加载项配置在安装期间发生了变化，请重试')
    await rename(staged, manifest)
  } finally {
    await rm(staged, { force: true })
  }
  console.log('安装成功。保存文档并完全退出 WPS，然后重新打开 WPS 文字。顶部选择「摸鱼派 → 打开聊天室」。')
}

try {
  await install()
} catch (error) {
  if (platform === 'darwin' && ['EPERM', 'EACCES'].includes(error.code) && error.path?.startsWith(macContainer)) {
    console.error('macOS 拒绝访问 WPS 的加载项目录。请从 Finder 双击 install-mac.command，并允许出现的 WPS App 数据访问提示。')
  } else {
    console.error(`安装失败。${error.message}`)
  }
  process.exitCode = 1
}
