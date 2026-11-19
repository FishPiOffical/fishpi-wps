import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pasteboardScript } from '../src/mac-clipboard.js'

test('macOS pasteboard reader returns PNG, handles TIFF, and respects the image limit', { skip: process.platform !== 'darwin' }, async () => {
  const path = fileURLToPath(new URL('../static/assets/icon.png', import.meta.url))
  const fixture = JSON.stringify(path)
  const script = pasteboardScript + `
var board = $.NSPasteboard.pasteboardWithUniqueName
try {
  var png = $.NSData.dataWithContentsOfFile(${fixture})
  var bitmap = $.NSBitmapImageRep.imageRepWithData(png)
  board.setStringForType('not an image', 'public.utf8-plain-text')
  var empty = imageOnPasteboard(board, 1000000)
  board.clearContents
  board.setDataForType(png, 'public.png')
  var direct = imageOnPasteboard(board, 1000000)
  var oversized = imageOnPasteboard(board, 10)
  board.clearContents
  board.setDataForType(bitmap.TIFFRepresentation, 'public.tiff')
  var converted = imageOnPasteboard(board, 1000000)
  JSON.stringify({ empty: empty, direct: direct, oversized: oversized, converted: converted })
} finally {
  board.releaseGlobally
}
`
  const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8000 })
  const { empty, direct, oversized, converted } = JSON.parse(stdout)
  assert.equal(empty, 'empty')
  assert.equal(oversized, 'too_large')
  const png = await readFile(path)
  const [directMime, directData] = direct.split('\n')
  assert.equal(directMime, 'image/png')
  assert.deepEqual(Buffer.from(directData, 'base64'), png)
  const [convertedMime, convertedData] = converted.split('\n')
  assert.equal(convertedMime, 'image/png')
  assert.deepEqual(Buffer.from(convertedData, 'base64').subarray(0, 8), png.subarray(0, 8))
})
