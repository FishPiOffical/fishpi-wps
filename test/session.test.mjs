import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FishPiChat } from '../src/chat-service.js'
import { localCredentials } from '../src/credentials.js'
import { FishPiApi, md5Hex } from '../src/fishpi.js'
import { Uploads } from '../src/upload.js'

const cookie = value => ({ 'set-cookie': `fp_v3_refresh=${value}; Path=/api/v3/auth; HttpOnly; Secure` })
const reply = (data, headers) => Response.json({ code: 0, data }, { headers })

test('two panel processes can restore and rotate a remembered session once, then share sign-out', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'fishpi-codex-session-'))
  const data = join(temp, 'data')
  const services = []
  t.after(async () => {
    for (const service of services) service.dispose()
    await rm(temp, { recursive: true, force: true })
  })

  let refreshCount = 0
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname
    switch (path) {
      case '/api/v3/auth/login':
        assert.equal(JSON.parse(init.body).userPassword, md5Hex('not-a-real-password'))
        return reply({ accessToken: 'token-before', expiresIn: 900 }, cookie('refresh-before'))
      case '/api/v3/me':
        return reply({ id: '7', userName: 'fish' })
      case '/api/v3/auth/refresh':
        refreshCount++
        assert.equal(init.headers.cookie, 'fp_v3_refresh=refresh-before')
        await new Promise(resolve => setTimeout(resolve, 30))
        return reply({ accessToken: 'token-after', expiresIn: 900 }, cookie('refresh-after'))
      case '/api/v3/chat/topic':
        if (init.headers.authorization !== 'Bearer token-after') {
          return Response.json({ code: 'unauthorized' }, { status: 401 })
        }
        return reply({ text: 'topic' })
      default:
        // Offline test, including WebSocket tickets and remote logout.
        return reply({})
    }
  }
  const open = () => {
    const service = new FishPiChat({ credentials: localCredentials(data), api: new FishPiApi({ fetchImpl }) })
    services.push(service)
    return service
  }
  const first = open()
  const login = await first.login({ nameOrEmail: 'fish', password: 'not-a-real-password', remember: true })
  assert.equal(login.user.id, '7')
  assert.equal(login.persistent, true)
  assert.doesNotMatch(JSON.stringify(login), /token-before|refresh-before|not-a-real-password/)
  const stored = join(data, 'account.json')
  assert.doesNotMatch(await readFile(stored, 'utf8'), /not-a-real-password/iu)
  if (process.platform !== 'win32') {
    assert.equal((await stat(stored)).mode & 0o777, 0o600)
    assert.equal((await stat(data)).mode & 0o777, 0o700)
  }

  const second = open()
  assert.equal((await second.sync()).user.id, '7')
  assert.deepEqual(await Promise.all([first.topic(), second.topic()]), [
    { ok: true, text: 'topic' }, { ok: true, text: 'topic' },
  ])
  assert.equal(refreshCount, 1)
  assert.equal(JSON.parse(await readFile(stored, 'utf8')).refreshCookie, 'refresh-after')

  await second.logout()
  assert.equal((await first.sync()).loggedIn, false)
  assert.equal((await open().sync()).loggedIn, false)
  await assert.rejects(readFile(stored, 'utf8'), { code: 'ENOENT' })

  const temporary = await second.login({ nameOrEmail: 'fish', password: 'not-a-real-password', remember: false })
  assert.equal(temporary.loggedIn, true)
  assert.equal(temporary.persistent, false)
  assert.equal((await open().sync()).loggedIn, false)
})

test('image chunks only assemble in sequence within the same signed-in session', async () => {
  const uploads = new Uploads()
  const chunk = { batchId: 'batch', index: 0, offset: 0, mime: 'image/png', name: 'fish.png', data: 'YWJj' }
  assert.deepEqual(uploads.add(chunk, 'account-a'), { ok: true })
  assert.throws(() => uploads.add(chunk, 'account-a'), { code: 'invalid_input' })
  uploads.add({ ...chunk, offset: 3, data: 'ZGVm' }, 'account-a')
  const file = uploads.finish('batch', 'account-a').get('file')
  assert.equal(file.name, 'fish.png')
  assert.equal(file.type, 'image/png')
  assert.equal(await file.text(), 'abcdef')

  uploads.add(chunk, 'account-a')
  assert.throws(() => uploads.finish('batch', 'account-b'), { code: 'invalid_input' })
})
