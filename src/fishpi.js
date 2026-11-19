/**
 * FishPi (摸鱼派) API v3 client, chat WebSocket manager, and event hub.
 *
 * This module deliberately depends on nothing but Node built-ins so the Host
 * half stays a dependency-free local bundle and can be exercised in a plain
 * Node test. `chat-service.js` wires it into the WPS bridge.
 *
 * API reference: https://github.com/FishPiOffical/rhythm/blob/api_v3/API.md
 */

import { createHash } from 'node:crypto'
import packageInfo from '../package.json' with { type: 'json' }

/** FishPi production origin. A deployment may override it in the service. */
export const DEFAULT_SITE = 'https://fishpi.cn'

export const PLUGIN_VERSION = packageInfo.version

/** Client tag accepted by `/api/v3/chat/messages` (`brand/version`). */
export const CLIENT_TAG = `WPS/${PLUGIN_VERSION}`

/** The largest body the public chat message endpoint accepts. */
export const MAX_MESSAGE_LENGTH = 4096

/** One failed FishPi operation with a stable, client-safe code. */
export class FishPiError extends Error {
  /**
   * @param {string} message - human-readable failure text from the server.
   * @param {{ code?: string, status?: number, cause?: unknown }} [options] - stable code, HTTP status, cause.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'FishPiError'
    this.code = options.code ?? 'fishpi_error'
    this.status = options.status ?? 0
  }
}

/**
 * MD5 of a password, lowercase hex: the form `/api/v3/auth/login` requires.
 * @param {string} value - the plain password typed by the user.
 * @returns {string} 32 lowercase hex characters.
 */
export function md5Hex(value) {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

/**
 * The HttpOnly refresh cookie the website login sets. The Host keeps its value
 * in the local credential store and sends it back to `/api/v3/auth/refresh`, which
 * rotates it on every successful refresh.
 */
export const REFRESH_COOKIE_NAME = 'fp_v3_refresh'

/**
 * Read every `Set-Cookie` line from a Fetch response without relying on a
 * cookie jar. Node exposes `getSetCookie()`; a single joined header is the
 * fallback for runtimes that do not.
 * @param {Headers|undefined} headers - response headers.
 * @returns {string[]} cookie lines.
 */
function setCookieLines(headers) {
  if (headers === undefined || headers === null) return []
  if (typeof headers.getSetCookie === 'function') {
    try {
      const lines = headers.getSetCookie()
      if (Array.isArray(lines)) return lines
    } catch {
      // Fall through to the single-header form.
    }
  }
  const raw = typeof headers.get === 'function' ? headers.get('set-cookie') : null
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

/**
 * Extract the refresh cookie value from `Set-Cookie` lines.
 * @param {string[]} lines - cookie lines.
 * @returns {string} the token, or an empty string.
 */
export function refreshCookieFrom(lines) {
  const pattern = new RegExp(`(?:^|,\\s*)${REFRESH_COOKIE_NAME}=([^;,\\s]+)`)
  for (const line of lines) {
    if (typeof line !== 'string') continue
    const match = pattern.exec(line)
    if (match !== null) return match[1]
  }
  return ''
}

/**
 * Remove the parts of a FishPi message the sidebar never renders and make the
 * shape predictable for the browser.
 * @param {unknown} raw - one message from the list, detail, or realtime socket.
 * @returns {object|undefined} the normalized message, or undefined for non-objects.
 */
export function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = /** @type {Record<string, any>} */ (raw)
  const id = typeof source.id === 'string' || typeof source.id === 'number' ? String(source.id) : ''
  if (id === '') return undefined
  const author = source.author !== null && typeof source.author === 'object' ? source.author : {}
  return {
    id,
    createdAt: Number(source.createdAt) || 0,
    type: typeof source.type === 'string' ? source.type : 'text',
    content: typeof source.content === 'string' ? source.content : '',
    contentHtml: typeof source.contentHtml === 'string' ? source.contentHtml : '',
    author: {
      id: author.id === undefined || author.id === null ? '' : String(author.id),
      userName: typeof author.userName === 'string' ? author.userName : '',
      userNickname: typeof author.userNickname === 'string' ? author.userNickname : '',
      userAvatarURL: typeof author.userAvatarURL === 'string' ? author.userAvatarURL : '',
    },
    client: typeof source.client === 'string' ? source.client : '',
    medals: Array.isArray(source.medals)
      ? source.medals.map(medal => ({
          id: medal?.id === undefined ? '' : String(medal.id),
          name: typeof medal?.name === 'string' ? medal.name : '',
          type: typeof medal?.type === 'string' ? medal.type : '',
          description: typeof medal?.description === 'string' ? medal.description : '',
        }))
      : [],
    card: source.card !== null && typeof source.card === 'object' && !Array.isArray(source.card) ? source.card : {},
    appearance: source.appearance !== null && typeof source.appearance === 'object' ? source.appearance : undefined,
    reactionsUnavailable: source.reactionsUnavailable === true,
    reactions: source.reactions !== null && typeof source.reactions === 'object' ? source.reactions : undefined,
  }
}

/**
 * A slim public user record for the Host state and message snapshots.
 * @param {unknown} raw - `/api/v3/me` data.
 * @returns {{ id: string, userName: string, userNickname: string, userAvatarURL: string, userPoint?: number, capabilities?: { chatRevokeOthers: boolean }, userRole?: string }|undefined}
 */
export function normalizeMe(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, any>} */ (raw)
  const id = source.id === undefined || source.id === null ? '' : String(source.id)
  if (id === '') return undefined
  /** @type {{ id: string, userName: string, userNickname: string, userAvatarURL: string, userPoint?: number, capabilities?: { chatRevokeOthers: boolean }, userRole?: string }} */
  const user = {
    id,
    userName: typeof source.userName === 'string' ? source.userName : '',
    userNickname: typeof source.userNickname === 'string' ? source.userNickname : '',
    userAvatarURL: typeof source.userAvatarURL === 'string' ? source.userAvatarURL : '',
    userPoint: Number.isFinite(Number(source.userPoint)) ? Number(source.userPoint) : undefined,
  }
  if (source.capabilities !== null && typeof source.capabilities === 'object') {
    user.capabilities = { chatRevokeOthers: source.capabilities.chatRevokeOthers === true }
  }
  if (typeof source.userRole === 'string' && source.userRole !== '') user.userRole = source.userRole
  return user
}

/**
 * The HTTP face of the FishPi v3 API used by the sidebar.
 *
 * Every call keeps the unified envelope rules: `code: 0` means success, a
 * non-zero code or a non-2xx status becomes a {@link FishPiError}, and callers
 * receive `data` only.
 */
export class FishPiApi {
  /**
   * @param {{ siteUrl?: string, token?: string, fetchImpl?: typeof fetch, clientTag?: string }} [options] - endpoint and transport overrides.
   */
  constructor(options = {}) {
    this.siteUrl = (options.siteUrl ?? DEFAULT_SITE).replace(/\/+$/u, '')
    this.token = options.token ?? ''
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.clientTag = options.clientTag ?? CLIENT_TAG
  }

  /**
   * @param {string} token - Bearer access token; an empty string clears it.
   */
  setToken(token) {
    this.token = token
  }

  /**
   * @param {string} path - absolute API path such as `/api/v3/me`.
   * @returns {string} the absolute URL on the configured site.
   */
  url(path) {
    return new URL(path, `${this.siteUrl}/`).toString()
  }

  /**
   * One enveloped API request.
   * @param {string} path - absolute API path.
   * @param {{ method?: string, body?: unknown, signal?: AbortSignal, auth?: boolean, idempotencyKey?: string, raw?: boolean, headers?: Record<string, string>, captureCookies?: boolean }} [options] - request shape.
   * @returns {Promise<any>} the envelope's `data`, or `{ data, setCookies }` when `captureCookies` is true.
   */
  async request(path, options = {}) {
    const method = options.method ?? 'GET'
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' }
    /** @type {RequestInit} */
    const init = { method, headers, credentials: 'omit' }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    if (options.auth !== false && this.token !== '') headers.authorization = `Bearer ${this.token}`
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
    if (options.headers !== undefined && options.headers !== null) Object.assign(headers, options.headers)
    const timeout = AbortSignal.timeout(25_000)
    init.signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])

    let response
    try {
      response = await this.fetchImpl(this.url(path), init)
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      throw new FishPiError('无法连接摸鱼派服务器', { code: 'network', cause: error })
    }

    const text = await response.text().catch(() => '')
    let payload = null
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        throw new FishPiError('摸鱼派返回了无法解析的响应', { code: 'invalid_response', status: response.status })
      }
    }
    const envelope = payload !== null && typeof payload === 'object' ? payload : {}
    const code = envelope.code
    if (!response.ok || (code !== undefined && code !== 0 && code !== '0')) {
      throw new FishPiError(
        typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : `HTTP ${response.status}`,
        {
          code: typeof code === 'string' && code !== '' ? code : `http_${response.status}`,
          status: response.status,
        },
      )
    }
    if (options.captureCookies === true) {
      return {
        data: options.raw === true ? payload : envelope.data,
        setCookies: setCookieLines(response.headers),
      }
    }
    if (options.raw === true) return payload
    return envelope.data
  }

  /**
   * @param {{ nameOrEmail: string, userPassword: string, mfaCode?: string }} input - credentials; password is already MD5.
   * @returns {Promise<{ accessToken: string, tokenType?: string, expiresIn?: number, refreshExpiresIn?: number, scope?: string, refreshCookie?: string }>} a login grant and the rotating refresh cookie.
   */
  async login(input) {
    /** @type {Record<string, string>} */
    const body = { nameOrEmail: input.nameOrEmail, userPassword: input.userPassword }
    if (input.mfaCode !== undefined && input.mfaCode !== '') body.mfaCode = input.mfaCode
    const result = await this.request('/api/v3/auth/login', {
      method: 'POST',
      body,
      auth: false,
      captureCookies: true,
    })
    const grant = result.data !== null && typeof result.data === 'object' ? result.data : {}
    return { ...grant, refreshCookie: refreshCookieFrom(result.setCookies) }
  }

  /**
   * Rotate an expired access token with the website refresh cookie.
   *
   * The website refresh endpoint checks the request's Origin, so the Host sends
   * the same origin the first-party page would; it does not need any other
   * cookie because the refresh token itself is the credential.
   * @param {string} refreshCookie - the `fp_v3_refresh` value.
   * @returns {Promise<{ accessToken: string, expiresIn?: number, refreshExpiresIn?: number, scope?: string, refreshCookie?: string }>} the new access token and rotated cookie.
   */
  async refreshWebsite(refreshCookie) {
    if (typeof refreshCookie !== 'string' || refreshCookie === '') {
      throw new FishPiError('登录状态已失效，请重新登录', { code: 'unauthorized', status: 401 })
    }
    const origin = new URL(this.siteUrl).origin
    const result = await this.request('/api/v3/auth/refresh', {
      method: 'POST',
      body: {},
      auth: false,
      captureCookies: true,
      headers: {
        origin,
        referer: `${this.siteUrl}/`,
        cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}`,
      },
    })
    const grant = result.data !== null && typeof result.data === 'object' ? result.data : {}
    return { ...grant, refreshCookie: refreshCookieFrom(result.setCookies) }
  }

  /**
   * End the website session that owns the refresh cookie, when possible.
   * @param {string} refreshCookie - the `fp_v3_refresh` value.
   * @returns {Promise<void>}
   */
  async logoutWebsite(refreshCookie) {
    if (typeof refreshCookie !== 'string' || refreshCookie === '') return
    const origin = new URL(this.siteUrl).origin
    await this.request('/api/v3/auth/logout', {
      method: 'POST',
      body: {},
      auth: false,
      headers: {
        origin,
        referer: `${this.siteUrl}/`,
        cookie: `${REFRESH_COOKIE_NAME}=${refreshCookie}`,
      },
    })
  }

  /** @returns {Promise<any>} the current account profile. */
  me() {
    return this.request('/api/v3/me')
  }

  /**
   * @param {{ size?: number, before?: string, after?: string, signal?: AbortSignal }} [options] - one message window.
   * @returns {Promise<{ list?: unknown[], hasMore?: boolean, nextBefore?: string, nextAfter?: string }>} the window.
   */
  messages(options = {}) {
    const query = new URLSearchParams()
    if (options.size !== undefined) query.set('size', String(options.size))
    if (options.before !== undefined && options.before !== '') query.set('before', options.before)
    if (options.after !== undefined && options.after !== '') query.set('after', options.after)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return this.request(`/api/v3/chat/messages${suffix}`, { signal: options.signal })
  }

  /**
   * @param {string} id - message id.
   * @returns {Promise<any>} one message.
   */
  message(id) {
    return this.request(`/api/v3/chat/messages/${encodeURIComponent(id)}`)
  }

  /**
   * Recall (withdraw) one of the current account's messages.
   * @param {string} id - message id.
   * @param {string} idempotencyKey - stable key for this logical recall.
   * @returns {Promise<{ removed?: boolean }>} the withdrawal receipt.
   */
  revokeMessage(id, idempotencyKey) {
    return this.request(`/api/v3/chat/messages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      idempotencyKey,
    })
  }

  /**
   * @param {string} content - Markdown body, already trimmed by the caller.
   * @param {string} idempotencyKey - stable key for this logical send.
   * @returns {Promise<{ id: string, createdAt: number }>} the accepted message identity.
   */
  send(content, idempotencyKey) {
    return this.request('/api/v3/chat/messages', {
      method: 'POST',
      body: { content, client: this.clientTag },
      idempotencyKey,
    })
  }

  /**
   * @param {string} id - red-packet message id.
   * @returns {Promise<any>} the current red-packet detail and claims.
   */
  redPacket(id) {
    return this.request(`/api/v3/chat/red-packets/${encodeURIComponent(id)}`)
  }

  /**
   * @param {string} id - red-packet message id.
   * @param {{ gesture?: number, riskAccepted?: boolean }} input - risk acknowledgement and RPS gesture.
   * @param {string} idempotencyKey - stable key for this logical claim.
   * @returns {Promise<any>} the claim receipt.
   */
  claimRedPacket(id, input, idempotencyKey) {
    /** @type {Record<string, unknown>} */
    const body = {}
    if (input.riskAccepted === true) body.riskAccepted = true
    if (Number.isInteger(input.gesture)) body.gesture = input.gesture
    return this.request(`/api/v3/chat/red-packets/${encodeURIComponent(id)}/claims`, {
      method: 'POST',
      body,
      idempotencyKey,
    })
  }

  /** @returns {Promise<{ text?: string }>} the current topic. */
  topic() {
    return this.request('/api/v3/chat/topic')
  }

  /**
   * @param {{ size?: number }} [options] - page size; the endpoint caps it at 50.
   * @returns {Promise<{ list?: unknown[], pagination?: unknown }>} online users.
   */
  onlineUsers(options = {}) {
    const query = new URLSearchParams({ p: '1', size: String(options.size ?? 50) })
    return this.request(`/api/v3/chat/online-users?${query.toString()}`)
  }

  /**
   * @param {string} userName - public username.
   * @returns {Promise<any>} the legacy public member record, which carries userNo and userCity.
   */
  legacyUser(userName) {
    return this.request(`/user/${encodeURIComponent(userName)}`, { raw: true })
  }

  /**
   * @param {string} userName - public username.
   * @returns {Promise<any>} the public profile.
   */
  userProfile(userName) {
    return this.request(`/api/v3/users/${encodeURIComponent(userName)}`)
  }

  /**
   * @param {string} userName - public username.
   * @returns {Promise<{ list?: unknown[] }>} the user's public medals.
   */
  userMedals(userName) {
    return this.request(`/user/${encodeURIComponent(userName)}/medal`)
  }

  /**
   * @param {string} prefix - username prefix, 1–64 letters/digits/underscore/hyphen.
   * @returns {Promise<{ list?: unknown[] }>} up to ten matching users.
   */
  suggestUsers(prefix) {
    const query = new URLSearchParams({ prefix })
    return this.request(`/api/v3/suggestions/users?${query.toString()}`)
  }

  /** @returns {Promise<{ ticket: string, tokenType?: string, uploadURL: string, fieldName?: string, expiresIn?: number }>} a short-lived upload ticket. */
  uploadTicket() {
    return this.request('/api/v3/uploads/tickets', { method: 'POST', body: {} })
  }

  /** @returns {Promise<{ ticket: string, expiresIn?: number, path: string, channel: string }>} a one-shot chat socket ticket. */
  realtimeTicket() {
    return this.request('/api/v3/chat/realtime-ticket', { method: 'POST', body: {} })
  }
}

/**
 * A bounded, monotonically numbered event log with long-poll waiters.
 *
 * The browser reads a cursor and asks `wait`; the hub answers immediately with
 * the backlog or holds the request until one event lands. A cursor older than
 * the retained window asks the caller to reset its message window.
 */
export class EventHub {
  /**
   * @param {{ limit?: number, batchSize?: number }} [options] - retained events and replay window.
   */
  constructor(options = {}) {
    this.limit = options.limit ?? 500
    this.batchSize = options.batchSize ?? this.limit
    /** @type {Array<{ seq: number, type: string, data: unknown, at: number }>} */
    this.log = []
    this.seq = 0
    /** @type {Set<{ since: number, finish: (value: unknown) => void }>} */
    this.waiters = new Set()
  }

  /**
   * @param {string} type - event name consumed by the browser.
   * @param {unknown} data - JSON-safe payload.
   */
  emit(type, data) {
    const event = { seq: ++this.seq, type, data, at: Date.now() }
    this.log.push(event)
    if (this.log.length > this.limit) this.log.splice(0, this.log.length - this.limit)
    for (const waiter of [...this.waiters]) {
      if (event.seq > waiter.since) waiter.finish(this.#batch(waiter.since))
    }
  }

  /**
   * @param {number} since - last cursor the caller applied.
   * @param {AbortSignal|undefined} signal - caller lifetime.
   * @param {number} timeoutMs - longest hold before an empty answer.
   * @returns {Promise<{ events?: unknown[], cursor: number, reset?: boolean }>}
   */
  wait(since, signal, timeoutMs) {
    const cursor = this.seq
    if (since > cursor) return Promise.resolve({ reset: true, cursor })
    const first = this.log.length === 0 ? 0 : this.log[0].seq
    if (this.log.length > 0 && since < first - 1) return Promise.resolve({ reset: true, cursor })
    if (since < cursor && this.log.length > 0) return Promise.resolve(this.#batch(since))
    return new Promise(resolve => {
      let settled = false
      /** @type {{ since: number, finish: (value: unknown) => void }} */
      const waiter = {
        since,
        finish: value => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.waiters.delete(waiter)
          resolve(/** @type {any} */ (value))
        },
      }
      const timer = setTimeout(() => waiter.finish({ events: [], cursor: this.seq }), timeoutMs)
      const onAbort = () => waiter.finish({ events: [], cursor: this.seq })
      if (signal !== undefined) {
        if (signal.aborted) {
          waiter.finish({ events: [], cursor: this.seq })
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.waiters.add(waiter)
    })
  }

  /**
   * @param {number} since - exclusive lower bound.
   * @returns {{ events: unknown[], cursor: number }}
   */
  #batch(since) {
    const events = this.log.filter(event => event.seq > since).slice(0, this.batchSize)
    return { events, cursor: events.at(-1)?.seq ?? this.seq }
  }

  /** Release every held request. */
  dispose() {
    for (const waiter of [...this.waiters]) waiter.finish({ events: [], cursor: this.seq })
    this.waiters.clear()
  }
}

/**
 * The chat WebSocket: one ticket per connection, authenticate, heartbeat,
 * refresh before the grant expires, and reconnect with exponential backoff.
 *
 * The socket never calls the HTTP API itself. `getTicket` lets its owner renew
 * the access token first, which is what makes a token refresh recover a
 * closed connection instead of looping on 401.
 */
export class ChatRealtime {
  /**
   * @param {{
   *   getTicket: () => Promise<{ ticket: string, path: string, expiresIn?: number }>,
   *   siteUrl?: string,
   *   onEvent?: (event: { type: string, data: any }) => void,
   *   onState?: (state: 'connecting'|'connected'|'disconnected') => void,
   *   onError?: (error: unknown) => void,
   *   WebSocketImpl?: typeof WebSocket,
   *   logger?: Pick<Console, 'warn'>,
   * }} options - transport and lifecycle hooks.
   */
  constructor(options) {
    this.getTicket = options.getTicket
    this.siteUrl = (options.siteUrl ?? DEFAULT_SITE).replace(/\/+$/u, '')
    this.onEvent = options.onEvent ?? (() => {})
    this.onState = options.onState ?? (() => {})
    this.onError = options.onError ?? (() => {})
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket
    this.logger = options.logger ?? console

    this.state = 'disconnected'
    this.stopped = true
    this.attempt = 0
    /** @type {WebSocket|undefined} */
    this.socket = undefined
    this.reconnectTimer = undefined
    this.heartbeatTimer = undefined
    this.refreshTimer = undefined
    this.handshakeTimer = undefined
    this.lastPong = 0
    this.ticket = ''
    this.generation = 0
  }

  /** Start connecting; repeated calls while running do nothing. */
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    void this.#connect()
  }

  /** Stop permanently and release timers and the socket. */
  stop() {
    this.stopped = true
    this.generation += 1
    this.#clearTimers()
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      try {
        socket.close()
      } catch {
        // Closing a socket the server already closed is not an error here.
      }
    }
    this.#setState('disconnected')
  }

  /** @returns {'connecting'|'connected'|'disconnected'} the last published transport state. */
  getState() {
    return this.state
  }

  /**
   * Close the current socket and reconnect immediately with a fresh ticket.
   * Used when the server asks for a resync or when the grant nears expiry.
   * @param {string} reason - internal reason for diagnostics.
   */
  refresh(reason) {
    if (this.stopped) return
    this.logger.warn?.(`[fishpi-chat] refreshing realtime connection: ${reason}`)
    this.#restart(false)
  }

  async #connect() {
    if (this.stopped) return
    const generation = ++this.generation
    this.#setState('connecting')
    let ticket
    try {
      ticket = await this.getTicket()
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      this.onError(error)
      this.#setState('disconnected')
      if (error?.status === 401 || error?.code === 'unauthorized') {
        this.stopped = true
        this.#clearTimers()
        return
      }
      this.#scheduleReconnect()
      return
    }
    if (this.stopped || generation !== this.generation) return
    this.ticket = ticket.ticket
    if (typeof this.WebSocketImpl !== 'function') {
      this.onError(new Error('This runtime does not provide WebSocket'))
      this.#setState('disconnected')
      return
    }

    const url = new URL(ticket.path, `${this.siteUrl}/`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket
    try {
      socket = new this.WebSocketImpl(url.toString())
    } catch (error) {
      this.onError(error)
      this.#setState('disconnected')
      this.#scheduleReconnect()
      return
    }
    this.socket = socket
    this.handshakeTimer = setTimeout(() => {
      if (socket !== this.socket || this.state === 'connected' || this.stopped) return
      this.logger.warn?.('[fishpi-chat] realtime handshake timed out; reconnecting')
      this.#restart(true)
    }, 15_000)

    socket.addEventListener('message', event => {
      if (socket !== this.socket) return
      this.#onMessage(event.data)
    })
    socket.addEventListener('close', () => {
      if (socket !== this.socket) return
      this.socket = undefined
      this.#clearTimers()
      if (this.stopped) return
      this.#setState('disconnected')
      this.#scheduleReconnect()
    })
    socket.addEventListener('error', event => {
      if (socket !== this.socket) return
      this.onError(event)
    })
  }

  /**
   * @param {unknown} raw - one text frame from the socket.
   */
  #onMessage(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    switch (message.type) {
      case 'authentication.required': {
        this.#send({ type: 'authenticate', ticket: this.ticket })
        return
      }
      case 'ready': {
        this.attempt = 0
        this.lastPong = Date.now()
        clearTimeout(this.handshakeTimer)
        this.handshakeTimer = undefined
        this.#setState('connected')
        this.#startHeartbeat()
        this.#scheduleRefresh(message.data?.expiresAt)
        this.onEvent({ type: 'ready', data: message.data ?? {} })
        return
      }
      case 'pong': {
        this.lastPong = Date.now()
        return
      }
      default: {
        if (typeof message.type === 'string' && message.type.startsWith('chat.')) {
          this.onEvent({ type: 'chat', data: message })
        }
      }
    }
  }

  #startHeartbeat() {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPong > 60_000) {
        this.logger.warn?.('[fishpi-chat] realtime heartbeat timed out; reconnecting')
        this.#restart(true)
        return
      }
      this.#send({ type: 'ping' })
    }, 25_000)
  }

  /**
   * @param {number|undefined} expiresAt - server-published grant expiry.
   */
  #scheduleRefresh(expiresAt) {
    clearTimeout(this.refreshTimer)
    const expiry = Number(expiresAt) || 0
    if (expiry <= 0) return
    const delay = Math.max(5_000, expiry - Date.now() - 30_000)
    this.refreshTimer = setTimeout(() => {
      this.refresh('grant expiring')
    }, delay)
  }

  /**
   * @param {unknown} payload - socket frame to send.
   */
  #send(payload) {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify(payload))
    } catch (error) {
      this.onError(error)
    }
  }

  /**
   * @param {boolean} countAttempt - whether a failure counts against backoff.
   */
  #restart(countAttempt) {
    this.generation += 1
    this.#clearTimers()
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    }
    if (countAttempt) this.attempt += 1
    if (this.stopped) return
    this.#setState('connecting')
    void this.#connect()
  }

  #scheduleReconnect() {
    if (this.stopped) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5))
    this.attempt += 1
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => { void this.#connect() }, delay)
  }

  #clearTimers() {
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.refreshTimer)
    clearTimeout(this.handshakeTimer)
    clearInterval(this.heartbeatTimer)
    this.reconnectTimer = undefined
    this.refreshTimer = undefined
    this.handshakeTimer = undefined
    this.heartbeatTimer = undefined
  }

  /**
   * @param {'connecting'|'connected'|'disconnected'} state - new transport state.
   */
  #setState(state) {
    if (this.state === state) return
    this.state = state
    this.onState(state)
  }
}

/**
 * @param {number} ms - delay length.
 * @param {AbortSignal|undefined} signal - cancels the wait.
 * @returns {Promise<void>}
 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
