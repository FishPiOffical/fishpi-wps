import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import packageInfo from '../package.json' with { type: 'json' }
import lock from '../package-lock.json' with { type: 'json' }

const nodeVersion = 'v22.23.5'
const builds = {
  'macos-arm64': ['darwin-arm64', 'tar.gz', 'e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d'],
  'macos-x64': ['darwin-x64', 'tar.gz', 'c53383238206b9ae4db23c5d8a63645e2e753bec8ab51a49cc81939aa64e9422'],
  'linux-arm64': ['linux-arm64', 'tar.xz', '2babb9eb5264860d540849f4b064a6fbdebcdc323657d9d382ce23d313fd5e09'],
  'linux-x64': ['linux-x64', 'tar.xz', 'cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8'],
  'windows-arm64': ['win-arm64', 'zip', 'c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13'],
  'windows-x64': ['win-x64', 'zip', '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3'],
}
const system = { darwin: 'macos', win32: 'windows', linux: 'linux' }
const launchers = { macos: 'install-mac.command', windows: 'install-windows.cmd', linux: 'install-linux.sh' }
const command = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const downloads = join(root, 'downloads')
const target = process.argv[2] ?? `${system[process.platform]}-${process.arch}`
if (!Object.hasOwn(builds, target)) throw new Error(`Unknown release target: ${target}`)

async function copyNode(to, temp) {
  const [platform, format, expected] = builds[target]
  const base = `node-${nodeVersion}-${platform}`
  const archive = join(temp, `${base}.${format}`)
  const url = `https://nodejs.org/dist/${nodeVersion}/${base}.${format}`
  await command('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--output', archive, url])
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  if (hash.digest('hex') !== expected) throw new Error(`SHA-256 mismatch for Node.js ${target}`)

  await mkdir(to, { recursive: true })
  if (format === 'zip') {
    await command('unzip', ['-jq', archive, `${base}/node.exe`, `${base}/LICENSE`, '-d', to])
  } else {
    await command('tar', ['-xf', archive, '-C', to, '--strip-components=1', `${base}/bin/node`, `${base}/LICENSE`])
    if (((await stat(join(to, 'bin/node'))).mode & 0o111) === 0) throw new Error('Node.js runtime is not executable')
  }
}

async function copyLicenses(to) {
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.dev) continue
    const from = join(root, path)
    const dest = join(to, path.slice('node_modules/'.length))
    const licenses = (await readdir(from)).filter(name => /^(licen[cs]e|copying|notice)([.\-_]|$)/iu.test(name))
    if (licenses.length === 0) throw new Error(`Missing third-party license in ${path}`)
    await mkdir(dest, { recursive: true })
    await Promise.all(licenses.map(file => cp(join(from, file), join(dest, file))))
  }
}

const name = `fishpi-wps-${packageInfo.version}-${target}`
const temp = await mkdtemp(join(tmpdir(), 'fishpi-wps-package-'))
const staging = join(temp, name)
const launcher = launchers[target.split('-')[0]]
const runtime = ['server.mjs', 'install.mjs', 'web']
const copyLauncher = async () => {
  const from = join(root, launcher)
  const to = join(staging, launcher)
  if (!launcher.endsWith('.cmd')) return cp(from, to)
  const script = await readFile(from, 'utf8')
  return writeFile(to, script.replace(/\r?\n/gu, '\r\n'))
}
try {
  await mkdir(join(staging, 'dist'), { recursive: true })
  await mkdir(downloads, { recursive: true })
  await Promise.all([
    copyNode(join(staging, 'runtime'), temp),
    copyLicenses(join(staging, 'licenses')),
    cp(join(root, 'README.md'), join(staging, 'README.md')),
    copyLauncher(),
    cp(join(root, 'scripts', 'update.mjs'), join(staging, 'update.mjs')),
    ...runtime.map(file => cp(join(root, 'dist', file), join(staging, 'dist', file), { recursive: true })),
  ])
  const zip = `${name}.zip`
  const archive = join(downloads, zip)
  await command('zip', ['-qr', join(temp, zip), name], { cwd: temp })
  await cp(join(temp, zip), archive)
  console.log(archive)
} finally {
  await rm(temp, { recursive: true, force: true })
}
