import { FishPiError } from './fishpi.js'

import { MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from './upload-limits.js'

const UPLOAD_EXPIRY_MS = 3 * 60_000

const invalid = message => new FishPiError(message, { code: 'invalid_input', status: 400 })

/** Assemble files from small local requests before requesting a FishPi upload ticket. */
export class Uploads {
  #batches = new Map()

  add({ batchId, index, offset, name, mime, data }, sessionId) {
    for (const [id, batch] of this.#batches) {
      if (batch.expires <= Date.now() || batch.sessionId !== sessionId) this.#batches.delete(id)
    }
    let batch = this.#batches.get(batchId)
    if (batch === undefined) {
      if (offset !== 0 || index !== 0 || this.#batches.size >= 2) {
        throw invalid('上传已超时或有其他上传正在进行，请重试')
      }
      batch = { sessionId, bytes: 0, files: [], expires: 0 }
      this.#batches.set(batchId, batch)
    }

    let file = batch.files[index]
    if (file === undefined) {
      if (index !== batch.files.length || offset !== 0) throw invalid('上传片段顺序不正确')
      file = { name, mime, bytes: 0, parts: [] }
      batch.files.push(file)
    }
    const chunk = Buffer.from(data, 'base64')
    if (file.name !== name || file.mime !== mime || file.bytes !== offset) throw invalid('上传片段顺序不正确')
    if (chunk.length === 0 || chunk.length > UPLOAD_CHUNK_BYTES
      || file.bytes + chunk.length > MAX_IMAGE_BYTES || batch.bytes + chunk.length > MAX_UPLOAD_BYTES) {
      this.#batches.delete(batchId)
      throw invalid('图片大小超出限制')
    }
    file.parts.push(chunk)
    file.bytes += chunk.length
    batch.bytes += chunk.length
    batch.expires = Date.now() + UPLOAD_EXPIRY_MS
    return { ok: true }
  }

  finish(id, sessionId) {
    const batch = this.#batches.get(id)
    this.#batches.delete(id)
    if (batch?.sessionId !== sessionId || batch.expires <= Date.now() || batch.bytes === 0) {
      throw invalid('上传已超时，请重新选择图片')
    }
    const form = new FormData()
    for (const file of batch.files) {
      form.append('file', new Blob(file.parts, { type: file.mime }), file.name)
    }
    return form
  }

  cancel(id) {
    this.#batches.delete(id)
    return { ok: true }
  }
}
