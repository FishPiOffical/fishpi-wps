import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MAX_IMAGE_BYTES } from './upload-limits.js'

const execute = promisify(execFile)

export const pasteboardScript = String.raw`
ObjC.import('AppKit')

function imageOnPasteboard(board, maxBytes) {
  var formats = [
    ['public.png', 'image/png'],
    ['public.jpeg', 'image/jpeg'],
    ['com.compuserve.gif', 'image/gif'],
    ['org.webmproject.webp', 'image/webp'],
    ['public.tiff', 'image/png']
  ]
  for (var i = 0; i < formats.length; i++) {
    var data = board.dataForType(formats[i][0])
    if (!data || data.isNil() || data.length === 0) continue
    if (formats[i][0] === 'public.tiff') {
      var bitmap = $.NSBitmapImageRep.imageRepWithData(data)
      if (!bitmap || bitmap.isNil()) continue
      data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
      if (!data || data.isNil() || data.length === 0) continue
    }
    if (data.length > maxBytes) return 'too_large'
    return formats[i][1] + '\n' + ObjC.unwrap(data.base64EncodedStringWithOptions(0))
  }
  return 'empty'
}
`

export async function readMacClipboardImage({ signal } = {}) {
  const script = `${pasteboardScript}\nimageOnPasteboard($.NSPasteboard.generalPasteboard, ${MAX_IMAGE_BYTES})`
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
    signal,
    timeout: 5000,
    maxBuffer: 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 1024,
  })
  const output = stdout.trim()
  if (output === 'empty' || output === 'too_large') return { status: output }
  const [type, encoded] = output.split('\n')
  if (!/^image\/(png|jpeg|gif|webp)$/u.test(type) || !encoded) throw new Error('Invalid pasteboard result')
  const data = Buffer.from(encoded, 'base64')
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error('Invalid pasteboard image size')
  return { status: 'image', type, data }
}
