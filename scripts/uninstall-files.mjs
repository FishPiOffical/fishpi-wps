import { lstat, readdir, readFile, realpath, rm, rmdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import lock from '../package-lock.json' with { type: 'json' }

const releaseLayout = [
  ['runtime/bin', ['node']],
  ['runtime', ['node.exe', 'LICENSE']],
  ['dist/web/assets', ['icon.png']],
  ['dist/web', [
    'index.html', 'ribbon.xml', 'ribbon.js', 'taskpane.html', 'taskpane.js',
    'gallery.html', 'gallery.js', 'chat.css',
  ]],
  ['dist', ['server.mjs', 'install.mjs']],
  ['', ['README.md', 'update.mjs', 'install-windows.cmd', 'install-mac.command', 'install-linux.sh', '.DS_Store']],
]
const dataFiles = ['account.json', 'preferences.json', 'bridge.log', 'bridge-error.log', 'bridge.json']

function statIfPresent(path) {
  return lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
}

function contains(parent, path) {
  const offset = relative(parent, path)
  return !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}

export async function validateReleaseDirectory(path, inUsePaths) {
  const info = await statIfPresent(path)
  if (!info) return null
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`请选择摸鱼派的解压目录：${path}`)
  const directory = await realpath(path)
  if (inUsePaths.some(inUse => contains(directory, inUse))) {
    throw new Error('请从另外一个解压目录运行卸载，再指定要删除的旧目录。')
  }
  if (await statIfPresent(join(directory, '.git')) || await statIfPresent(join(directory, 'package.json'))) {
    throw new Error(`不能删除源码目录：${directory}`)
  }
  // Inspect the manifest only through normal directories. A link must not establish ownership.
  for (const child of ['dist', 'dist/web']) {
    const entry = await statIfPresent(join(directory, child))
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error(`无法识别摸鱼派安装目录：${directory}`)
  }
  const manifest = join(directory, 'dist/web/manifest.xml')
  const file = await statIfPresent(manifest)
  if (!file?.isFile() || file.size > 8192 || !/<Name>fishpi-wps<\/Name>/u.test(await readFile(manifest, 'utf8'))) {
    throw new Error(`无法识别摸鱼派安装目录：${directory}`)
  }
  return directory
}

async function removeEmptyDirectory(directory) {
  await rmdir(directory).catch(error => {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error
  })
}

async function isUnlinkedDirectory(directory) {
  const info = await statIfPresent(directory)
  return info?.isDirectory() && !info.isSymbolicLink() && relative(directory, await realpath(directory)) === ''
}

async function removeFiles(directory, files) {
  for (const name of files) {
    const path = join(directory, name)
    if (!(await statIfPresent(path))?.isFile()) continue
    // A stopped Windows process may still be closing its executable and log handles.
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(path, { force: true })
        break
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 7) throw error
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
  }
}

async function removeLicenses(directory) {
  const parents = new Set()
  const root = join(directory, 'licenses')
  for (const [key, info] of Object.entries(lock.packages)) {
    if (key === '' || info.dev) continue
    const path = join(root, key.slice('node_modules/'.length))
    if (!await isUnlinkedDirectory(path)) continue
    const files = (await readdir(path)).filter(name => /^(licen[cs]e|copying|notice)([.\-_]|$)/iu.test(name))
    await removeFiles(path, files)
    await removeEmptyDirectory(path)
    const parent = join(path, '..')
    if (parent !== root) parents.add(parent)
  }
  for (const parent of parents) await removeEmptyDirectory(parent)
  if (await isUnlinkedDirectory(root)) await removeEmptyDirectory(root)
}

export async function removeReleaseFiles(directory) {
  // Keep the identifying manifest until the other parts have been removed.
  await removeLicenses(directory)
  for (const [part, files] of releaseLayout) {
    const path = join(directory, part)
    if (!await isUnlinkedDirectory(path)) continue
    await removeFiles(path, files)
    await removeEmptyDirectory(path)
  }
  const web = join(directory, 'dist/web')
  if (await isUnlinkedDirectory(web)) {
    await removeFiles(web, ['manifest.xml'])
    await removeEmptyDirectory(web)
    await removeEmptyDirectory(join(directory, 'dist'))
    await removeEmptyDirectory(directory)
  }
}

export async function purgeLocalData(directory) {
  const info = await statIfPresent(directory)
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`无法安全清理本地数据目录：${directory}`)
  await removeFiles(directory, dataFiles)
  await removeEmptyDirectory(directory)
}
