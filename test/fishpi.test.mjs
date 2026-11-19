import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ChatRealtime,
  CLIENT_TAG,
  EventHub,
  FishPiApi,
  FishPiError,
  md5Hex,
  normalizeMe,
  normalizeMessage,
  PLUGIN_VERSION,
  refreshCookieFrom,
} from '../src/fishpi.js'

/**
 * @param {unknown} body - JSON response body.
 * @param {number} [status] - HTTP status.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {Response}
 */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

test('md5Hex matches the FishPi login contract', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5Hex('password'), '5f4dcc3b5aa765d61d8327deb882cf99')
})

test('normalizeMessage keeps the rendered fields and drops the rest', () => {
  const message = normalizeMessage({
    id: 1792304100000,
    createdAt: 1792304100000,
    type: 'text',
    content: 'hi',
    contentHtml: '<p>hi</p>',
    author: { id: 1, userName: 'fish', userNickname: '小鱼', userAvatarURL: 'https://x/a.png' },
    client: 'Web',
    medals: [{ id: 2, name: '粉丝', type: '稀有', description: '感谢' }],
    card: {},
    reactions: { summary: [] },
    extra: 'ignored',
  })
  assert.equal(message.id, '1792304100000')
  assert.equal(message.author.id, '1')
  assert.equal(message.author.userNickname, '小鱼')
  assert.equal(message.medals[0].name, '粉丝')
  assert.equal('extra' in message, false)
  assert.equal(normalizeMessage({}), undefined)
  assert.equal(normalizeMessage(null), undefined)
})

test('normalizeMe requires an id and keeps public fields', () => {
  assert.deepEqual(normalizeMe({ id: 7, userName: 'a', userNickname: 'A', userAvatarURL: 'u', userPoint: 3 }), {
    id: '7', userName: 'a', userNickname: 'A', userAvatarURL: 'u', userPoint: 3,
  })
  const moderator = normalizeMe({
    id: 7,
    userName: 'a',
    capabilities: { chatRevokeOthers: true },
    userRole: 'OP',
  })
  assert.equal(moderator.capabilities.chatRevokeOthers, true)
  assert.equal(moderator.userRole, 'OP')
  assert.equal(normalizeMe({ userName: 'a' }), undefined)
})

test('FishPiApi sends the Bearer token and unwraps the envelope', async () => {
  const calls = []
  const api = new FishPiApi({
    siteUrl: 'https://fishpi.example/',
    token: 'TOKEN',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({ code: 0, msg: '', data: { id: 9, userName: 'fish' } })
    },
  })
  const me = await api.me()
  assert.equal(me.userName, 'fish')
  assert.equal(calls[0].url, 'https://fishpi.example/api/v3/me')
  assert.equal(calls[0].init.headers.authorization, 'Bearer TOKEN')
  assert.equal(calls[0].init.credentials, 'omit')
})

test('FishPiApi send carries the extension client tag', async () => {
  const calls = []
  const api = new FishPiApi({
    token: 'TOKEN',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ code: 0, data: { id: '1792304100000', createdAt: 1 } })
    },
  })
  await api.send('hello', 'fishpi-chat-test')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.content, 'hello')
  assert.equal(body.client, CLIENT_TAG)
  assert.equal(body.client, `WPS/${PLUGIN_VERSION}`)
  assert.equal(calls[0].init.headers['idempotency-key'], 'fishpi-chat-test')
})

test('FishPiApi maps a business code to FishPiError', async () => {
  const api = new FishPiApi({
    fetchImpl: async () => jsonResponse({ code: 'invalid_credentials', msg: '密码错误', data: null }, 401),
  })
  await assert.rejects(
    () => api.login({ nameOrEmail: 'a', userPassword: md5Hex('b') }),
    error => {
      assert.ok(error instanceof FishPiError)
      assert.equal(error.code, 'invalid_credentials')
      assert.equal(error.status, 401)
      assert.equal(error.message, '密码错误')
      return true
    },
  )
})

test('FishPiApi treats a network rejection as a retryable network failure', async () => {
  const api = new FishPiApi({
    fetchImpl: async () => { throw new TypeError('offline') },
  })
  await assert.rejects(() => api.me(), error => {
    assert.equal(error.code, 'network')
    return true
  })
})

test('ChatRealtime authenticates, reports ready, and heartbeats', async () => {
  const instances = []
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.sent = []
      instances.push(this)
    }

    send(frame) {
      this.sent.push(JSON.parse(frame))
    }

    close() {
      this.readyState = 3
    }
  }

  const states = []
  const events = []
  const realtime = new ChatRealtime({
    siteUrl: 'https://fishpi.cn',
    getTicket: async () => ({ ticket: 'TICKET', path: '/api/v3/realtime' }),
    WebSocketImpl: FakeWebSocket,
    onState: state => states.push(state),
    onEvent: event => events.push(event),
  })
  realtime.start()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(instances.length, 1)
  assert.equal(instances[0].url, 'wss://fishpi.cn/api/v3/realtime')
  instances[0].readyState = 1

  instances[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'authentication.required' }) }))
  assert.deepEqual(instances[0].sent[0], { type: 'authenticate', ticket: 'TICKET' })

  instances[0].dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ type: 'ready', data: { channel: 'chat', expiresAt: Date.now() + 60_000 } }),
  }))
  assert.equal(states.at(-1), 'connected')
  assert.equal(events.at(-1).type, 'ready')

  instances[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) }))
  instances[0].dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify({ type: 'chat.message.created', data: { messageId: '1' } }),
  }))
  assert.equal(events.at(-1).type, 'chat')
  realtime.stop()
  assert.equal(states.at(-1), 'disconnected')
})

test('EventHub replays a backlog and resolves a held waiter', async () => {
  const hub = new EventHub({ limit: 3 })
  hub.emit('a', { n: 1 })
  hub.emit('b', { n: 2 })
  const first = await hub.wait(0, undefined, 100)
  assert.equal(first.cursor, 2)
  assert.deepEqual(first.events.map(event => event.type), ['a', 'b'])

  const held = hub.wait(2, undefined, 1_000)
  hub.emit('c', { n: 3 })
  const second = await held
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].type, 'c')

  hub.emit('d', {})
  hub.emit('e', {})
  const gap = await hub.wait(0, undefined, 100)
  assert.equal(gap.reset, true)
  hub.dispose()
})

test('FishPiApi login keeps the fp_v3_refresh cookie', async () => {
  const calls = []
  const api = new FishPiApi({
    siteUrl: 'https://fishpi.cn',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'ACCESS', tokenType: 'Bearer', expiresIn: 900, refreshExpiresIn: 2_592_000, scope: 'content.read content.write profile.read' },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'fp_v3_refresh=COOKIE1; Path=/api/v3/auth; HttpOnly; Secure; SameSite=Strict',
        },
      })
    },
  })
  const grant = await api.login({ nameOrEmail: 'iwpz', userPassword: md5Hex('secret') })
  assert.equal(grant.accessToken, 'ACCESS')
  assert.equal(grant.refreshCookie, 'COOKIE1')
  assert.equal(calls[0].url, 'https://fishpi.cn/api/v3/auth/login')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, undefined)
})

test('FishPiApi refreshWebsite sends the rotating cookie and captures its replacement', async () => {
  const calls = []
  const api = new FishPiApi({
    siteUrl: 'https://fishpi.cn',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        code: 0,
        data: { accessToken: 'FRESH', tokenType: 'Bearer', expiresIn: 900, refreshExpiresIn: 2_592_000, scope: 'content.read content.write profile.read' },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'fp_v3_refresh=COOKIE2; Path=/api/v3/auth; HttpOnly; Secure; SameSite=Strict',
        },
      })
    },
  })
  const grant = await api.refreshWebsite('COOKIE1')
  assert.equal(grant.accessToken, 'FRESH')
  assert.equal(grant.refreshCookie, 'COOKIE2')
  assert.equal(calls[0].url, 'https://fishpi.cn/api/v3/auth/refresh')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.origin, 'https://fishpi.cn')
  assert.equal(calls[0].init.headers.cookie, 'fp_v3_refresh=COOKIE1')
  assert.equal(calls[0].init.body, '{}')
})

test('FishPiApi refreshWebsite reports a revoked refresh cookie as unauthorized', async () => {
  const api = new FishPiApi({
    siteUrl: 'https://fishpi.cn',
    fetchImpl: async () => new Response(JSON.stringify({ code: 'unauthorized', msg: '登录状态已失效', data: null }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  })
  await assert.rejects(() => api.refreshWebsite('OLD'), error => {
    assert.ok(error instanceof FishPiError)
    assert.equal(error.code, 'unauthorized')
    assert.equal(error.status, 401)
    return true
  })
})

test('refreshCookieFrom reads the cookie from joined and split headers', () => {
  assert.equal(refreshCookieFrom(['fp_v3_refresh=ONE; Path=/api/v3/auth']), 'ONE')
  assert.equal(refreshCookieFrom(['other=x; Path=/', 'fp_v3_refresh=TWO; Path=/api/v3/auth']), 'TWO')
  assert.equal(refreshCookieFrom([]), '')
})

test('FishPiApi revokeMessage sends DELETE with the idempotency key', async () => {
  const calls = []
  const api = new FishPiApi({
    token: 'TOKEN',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ code: 0, data: { removed: true } })
    },
  })
  const result = await api.revokeMessage('1792304100000', 'fishpi-chat-revoke-abc')
  assert.equal(result.removed, true)
  assert.equal(calls[0].url, 'https://fishpi.cn/api/v3/chat/messages/1792304100000')
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(calls[0].init.headers['idempotency-key'], 'fishpi-chat-revoke-abc')
  assert.equal(calls[0].init.headers.authorization, 'Bearer TOKEN')
})
