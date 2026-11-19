import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { addinUrl, bridgeConfig, dataDir, readBridgeConfig } from '../src/bridge-config.js'
import { registerAddin, unregisterAddin } from '../src/registration.js'
import { restartMacAgent, stopMacAgent } from './mac-launch-agent.mjs'

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
  const installedPlist = await readFile(service, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (installedPlist === plist) {
    await restartMacAgent({ command, domain: gui, label, plistPath: service, updatePlist: () => {} })
    return
  }
  const staged = await stageFile(service, plist)
  try {
    await restartMacAgent({
      command, domain: gui, label, plistPath: service, updatePlist: () => rename(staged, service),
    })
  } finally {
    await rm(staged, { force: true })
  }
}

async function windowsStartup(action) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$directory = [Environment]::GetFolderPath('Startup', 'Create')
if (-not $directory) { throw 'Windows Startup folder was not found' }
$link = Join-Path $directory 'FishPi WPS Bridge.lnk'
if ($env:FISHPI_WPS_STARTUP_ACTION -eq 'remove') {
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link }
  exit
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $env:FISHPI_WPS_NODE
$shortcut.Arguments = '"' + $env:FISHPI_WPS_SERVER + '"'
$shortcut.WindowStyle = 7
$shortcut.Description = 'FishPi WPS local bridge'
$shortcut.Save()
`
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  await command(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
    env: { ...process.env, FISHPI_WPS_STARTUP_ACTION: action, FISHPI_WPS_NODE: process.execPath, FISHPI_WPS_SERVER: server },
  })
}

function desktopArgument(value) {
  return `"${value.replace(/(["`$\\])/gu, '\\$1').replace(/%/gu, '%%')}"`
    .replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/\r/gu, '\\r')
}

function linuxStartupPath() {
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'autostart', 'fishpi-wps.desktop')
}

async function installLinuxStartup() {
  const file = linuxStartupPath()
  await mkdir(dirname(file), { recursive: true })
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

async function stopDesktopBridge(url) {
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
}

async function startDesktopBridge(url) {
  await stopDesktopBridge(url)
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

function readManifest(manifest) {
  return readFile(manifest, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

async function changeManifest(manifest, oldXml, xml, changeService) {
  if (xml === oldXml) return changeService()
  await mkdir(dirname(manifest), { recursive: true })
  const staged = await stageFile(manifest, xml)
  try {
    await changeService()
    if (await readManifest(manifest) !== oldXml) throw new Error('WPS 加载项配置在操作期间发生了变化，请重试')
    await rename(staged, manifest)
  } finally {
    await rm(staged, { force: true })
  }
}

async function install() {
  const manifest = manifestPath()
  await access(server)
  if (platform === 'darwin') await access(macContainer)
  const oldXml = await readManifest(manifest)
  const url = addinUrl(await bridgeConfig())
  await changeManifest(manifest, oldXml, registerAddin(oldXml ?? '<jsplugins/>', url), async () => {
    if (platform === 'darwin') await startMacBridge()
    else await startDesktopBridge(url)
    if (!await waitForBridge(url, true)) {
      throw new Error(`本地服务未能启动，请查看 ${join(dataDir, 'bridge-error.log')}`)
    }
    if (platform === 'win32') await windowsStartup('install')
    if (platform === 'linux') await installLinuxStartup()
  })
  console.log('安装成功。保存文档并完全退出 WPS，然后重新打开 WPS 文字。顶部选择「摸鱼派 → 打开聊天室」。')
}

async function uninstall() {
  const manifest = manifestPath()
  const oldXml = await readManifest(manifest)
  await changeManifest(manifest, oldXml, oldXml === null ? null : unregisterAddin(oldXml), async () => {
    if (platform === 'darwin') {
      await stopMacAgent({ command, domain: gui, label })
      await rm(service, { force: true })
    } else {
      const config = await readBridgeConfig()
      if (config) await stopDesktopBridge(addinUrl(config))
      if (platform === 'win32') await windowsStartup('remove')
      if (platform === 'linux') await rm(linuxStartupPath(), { force: true })
    }
  })
  console.log('卸载成功。请保存文档并完全退出 WPS。重新打开后，摸鱼派入口会消失。')
}

try {
  const args = process.argv.slice(2)
  if (args.length === 0) await install()
  else if (args.length === 1 && args[0] === '--uninstall') await uninstall()
  else throw new Error('仅支持安装（无参数）或卸载（--uninstall）')
} catch (error) {
  if (platform === 'darwin' && ['EPERM', 'EACCES'].includes(error.code) && error.path?.startsWith(macContainer)) {
    console.error('macOS 拒绝访问 WPS 的加载项目录。请从 Finder 双击 install-mac.command，并允许出现的 WPS App 数据访问提示。')
  } else {
    console.error(`操作失败。${error.message}`)
  }
  process.exitCode = 1
}
