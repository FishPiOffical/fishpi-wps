import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const repo = 'FishPiOffical/fishpi-wps'
const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
const command = promisify(execFile)
const maxBytes = 128 * 1024 * 1024

async function download(asset, archive) {
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`)
  let received = 0
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) {
      received += chunk.length
      if (received > asset.size) throw new Error('安装包大小与 GitHub Release 不一致')
      yield chunk
    }
  }, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  if (received !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('安装包 SHA-256 校验失败')
}

async function extract(archive, directory) {
  if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const script = "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:FISHPI_UPDATE_ZIP -DestinationPath $env:FISHPI_UPDATE_DIR"
    return command(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FISHPI_UPDATE_ZIP: archive, FISHPI_UPDATE_DIR: directory },
    })
  }
  return command('unzip', ['-q', archive, '-d', directory])
}

async function update() {
  const [tag, extra] = process.argv.slice(2)
  const versionTag = /^v\d+\.\d+\.\d+$/u
  if (extra || (tag !== undefined && !versionTag.test(tag))) throw new Error('用法：node update.mjs [v版本号]')
  if (!platform || !['x64', 'arm64'].includes(process.arch)) throw new Error('当前系统或架构没有对应的安装包')
  const path = tag ? `tags/${tag}` : 'latest'
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fishpi-wps-updater' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`无法查询 GitHub Release（HTTP ${response.status}）`)
  const release = await response.json()
  if (typeof release.tag_name !== 'string' || !versionTag.test(release.tag_name)
    || (tag && release.tag_name !== tag) || release.draft || release.prerelease) {
    throw new Error('未找到所需的正式发布版本')
  }

  const name = `fishpi-wps-${release.tag_name.slice(1)}-${platform}-${process.arch}`
  const asset = release.assets?.find(item => item.name === `${name}.zip` && item.state === 'uploaded')
  const expectedUrl = `https://github.com/${repo}/releases/download/${release.tag_name}/${name}.zip`
  if (!asset || asset.browser_download_url !== expectedUrl || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? '')
    || !Number.isInteger(asset.size) || asset.size <= 0 || asset.size > maxBytes) {
    throw new Error('GitHub Release 缺少对应安装包或校验值')
  }

  const releases = join(process.env.FISHPI_WPS_DATA_DIR || join(homedir(), '.fishpi-wps'), 'releases')
  await mkdir(releases, { recursive: true, mode: 0o700 })
  const temp = await mkdtemp(join(releases, '.download-'))
  try {
    console.log(`正在下载摸鱼派 WPS ${release.tag_name}（${platform}-${process.arch}）…`)
    const archive = join(temp, `${name}.zip`)
    await download(asset, archive)
    await extract(archive, temp)
    const unpacked = join(temp, name)
    const runtime = platform === 'windows' ? 'runtime/node.exe' : 'runtime/bin/node'
    await access(join(unpacked, runtime))
    await access(join(unpacked, 'dist/install.mjs'))

    // Each attempt stages a new directory so an installed version can remain running during download.
    const destination = await mkdtemp(join(releases, `${name}-`))
    const installed = join(destination, name)
    await rename(unpacked, installed)
    await new Promise((resolve, reject) => {
      const child = spawn(join(installed, runtime), [join(installed, 'dist/install.mjs')], { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`新版安装器未完成（退出码 ${code}）`)))
    })
    console.log(`已升级到 ${release.tag_name}。新版目录 ${installed}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

try {
  await update()
} catch (error) {
  console.error(`升级失败。${error.message}`)
  process.exitCode = 1
}
