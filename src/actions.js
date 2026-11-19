import { z } from 'zod'
import { FishPiChat } from './chat-service.js'
import { localCredentials } from './credentials.js'
import { FishPiError, MAX_MESSAGE_LENGTH } from './fishpi.js'
import { Uploads } from './upload.js'
import { MAX_UPLOAD_FILES, UPLOAD_CHUNK_BYTES } from './upload-limits.js'

const credentials = localCredentials()
export const chat = new FishPiChat({ credentials })
const uploads = new Uploads()

const id = z.string().regex(/^\d{1,32}$/u)
const requestId = z.string().max(64).optional()
const batchId = z.uuid()
const routes = [
  ['state', {}, async () => ({ ...await chat.sync(), prefs: await credentials.preferences() })],
  ['preferences', {
    mode: z.enum(['rich', 'plain']).optional(),
    notifications: z.boolean().optional(),
  }, async args => ({ ok: true, prefs: await credentials.updatePreferences(args) })],
  ['events', { since: z.number().int().nonnegative() }, (args, ctx) => chat.events(args, ctx.signal)],
  ['login', {
    nameOrEmail: z.string().max(200),
    password: z.string().max(1024),
    mfaCode: z.string().max(16).optional(),
    remember: z.boolean().optional(),
  }, args => chat.login(args)],
  ['logout', {}, () => chat.logout()],
  ['messages', { size: z.number().int().min(1).max(50), before: id.optional(), after: id.optional() }, args => chat.messages(args)],
  ['send', { content: z.string().max(MAX_MESSAGE_LENGTH), requestId }, args => chat.send(args)],
  ['recall', { id, requestId }, args => chat.recall(args)],
  ['medals', { names: z.array(z.string().max(64)).max(30) }, args => chat.medals(args.names)],
  ['user', { name: z.string().max(64) }, args => chat.userInfo(args)],
  ['users', { prefix: z.string().max(64) }, args => chat.suggestUsers(args)],
  ['topic', {}, () => chat.topic()],
  ['online', {}, () => chat.online()],
  ['red-packet', { id }, args => chat.redPacket(args)],
  ['red-packet/claim', {
    id,
    gesture: z.number().int().min(0).max(2).optional(),
    riskAccepted: z.boolean().optional(),
    requestId,
  }, args => chat.claimRedPacket(args)],
  ['upload/chunk', {
    batchId,
    index: z.number().int().min(0).max(MAX_UPLOAD_FILES - 1),
    offset: z.number().int().nonnegative(),
    name: z.string().min(1).max(255),
    mime: z.string().regex(/^image\/[a-z0-9.+-]{1,80}$/iu),
    data: z.base64().max(4 * Math.ceil(UPLOAD_CHUNK_BYTES / 3)),
  }, async args => {
    const sessionId = await uploadSession()
    return uploads.add(args, sessionId)
  }],
  ['upload/finish', { batchId }, async args => {
    const sessionId = await uploadSession()
    return chat.upload(uploads.finish(args.batchId, sessionId), sessionId)
  }],
  ['upload/cancel', { batchId }, args => uploads.cancel(args.batchId)],
]

async function uploadSession() {
  await chat.sync()
  if (!chat.record) throw new FishPiError('请先登录', { code: 'unauthorized', status: 401 })
  return chat.record.sessionId
}

export const actions = new Map(routes.map(([name, shape, run]) => [
  `fishpi_${name.replace(/[-/]/gu, '_')}`,
  { schema: z.object(shape), run },
]))
