import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { purgeLocalData, removeReleaseFiles, validateReleaseDirectory } from '../scripts/uninstall-files.mjs'

test('removes a selected release while keeping personal files and refusing the active uninstaller', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'fishpi-remove-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const release = join(temp, 'fishpi-wps-0.1.0 Windows x64')
  const fixture = {
    'dist/web/manifest.xml': '<JsPlugin><Name>fishpi-wps</Name></JsPlugin>',
    'dist/install.mjs': '',
    'runtime/node.exe': '',
    'licenses/@xmldom/xmldom/LICENSE': '',
    'personal.txt': 'keep',
    'dist/personal.txt': 'also keep',
  }
  for (const [file, data] of Object.entries(fixture)) {
    const path = join(release, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }
  const canonical = await realpath(release)
  await assert.rejects(validateReleaseDirectory(release, [join(canonical, 'runtime/node.exe')]), /另外一个解压目录/u)
  await assert.rejects(validateReleaseDirectory(temp, []), /无法识别/u)
  await writeFile(join(release, 'package.json'), '{}')
  await assert.rejects(validateReleaseDirectory(release, []), /源码目录/u)
  await rm(join(release, 'package.json'))
  assert.equal(await validateReleaseDirectory(release, []), canonical)
  await removeReleaseFiles(canonical)
  for (const file of ['runtime/node.exe', 'dist/install.mjs', 'dist/web/manifest.xml', 'licenses/@xmldom/xmldom/LICENSE']) {
    await assert.rejects(readFile(join(release, file)), { code: 'ENOENT' })
  }
  assert.equal(await readFile(join(release, 'personal.txt'), 'utf8'), 'keep')
  assert.equal(await readFile(join(release, 'dist/personal.txt'), 'utf8'), 'also keep')
})

test('purging deletes local FishPi state and preserves other files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fishpi-purge-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'account.json'), 'test-account')
  await writeFile(join(directory, 'preferences.json'), 'test-preferences')
  await writeFile(join(directory, 'personal.txt'), 'keep')
  await purgeLocalData(directory)
  await purgeLocalData(directory)
  await assert.rejects(readFile(join(directory, 'account.json')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(directory, 'preferences.json')), { code: 'ENOENT' })
  assert.equal(await readFile(join(directory, 'personal.txt'), 'utf8'), 'keep')
})
