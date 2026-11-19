/**
 * FishPi session, chat operations and replayable WebSocket events for the WPS add-in.
 */

import { randomUUID } from 'node:crypto'

import {
  ChatRealtime,
  DEFAULT_SITE,
  delay,
  EventHub,
  FishPiApi,
  FishPiError,
  MAX_MESSAGE_LENGTH,
  md5Hex,
  normalizeMe,
  normalizeMessage,
  PLUGIN_VERSION,
} from './fishpi.js'

const EVENT_WAIT_MS = 15_000
const EVENT_LOG_LIMIT = 500

function unauthorized(error) {
  return error instanceof FishPiError && (error.status === 401 || error.code === 'unauthorized')
}

/**
 * @param {unknown} value - candidate integer.
 * @param {number} fallback - used when the value is absent or unusable.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number}
 */
function integer(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * @param {unknown} value - candidate string.
 * @param {number} max - maximum accepted UTF-16 length.
 * @returns {string}
 */
function text(value, max) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/**
 * Normalize the legacy medal list into icon-bearing records.
 * @param {unknown} data - medal envelope data or a list.
 * @returns {Array<{id: string, name: string, type: string, description: string, url: string, order: number}>}
 */
function normalizeMedals(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
  return list
    .filter(medal => medal !== null && typeof medal === 'object' && medal.enabled !== false)
    .map(medal => {
      const attr = typeof medal.attr === 'string' ? medal.attr : ''
      let url = ''
      try {
        url = new URLSearchParams(attr).get('url') ?? ''
      } catch {
        url = ''
      }
      if (url === '') return null
      return {
        id: medal.id === undefined ? '' : String(medal.id),
        name: typeof medal.name === 'string' ? medal.name : '',
        type: typeof medal.type === 'string' ? medal.type : '',
        description: typeof medal.description === 'string' ? medal.description : '',
        url,
        order: Number(medal.order) || 0,
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order)
}

/** Owns one session view per bridge process. Remembered grants are shared on disk. */
export class FishPiChat {
  constructor({ credentials, api = new FishPiApi() }) {
    this.credentials = credentials
    this.api = api
    this.hub = new EventHub({ limit: EVENT_LOG_LIMIT, batchSize: 30 })
    this.authQueue = Promise.resolve()
    this.record = undefined
    this.realtime = undefined
    this.connectionState = 'disconnected'
    this.lastError = undefined
    this.medalCache = new Map()
    this.stopped = false
  }

  dispose() {
    this.stopped = true
    this.realtime?.stop()
    this.hub.dispose()
  }

  state() {
    return {
      ok: true,
      loggedIn: this.record !== undefined,
      user: this.record?.user ?? null,
      connection: this.connectionState,
      cursor: this.hub.seq,
      error: this.lastError === undefined ? null : { code: this.lastError.code, message: this.lastError.message },
      persistent: this.record?.remember === true,
      hostVersion: PLUGIN_VERSION,
      siteUrl: DEFAULT_SITE,
    }
  }

  async sync() {
    await this.#serializeAuth(() => this.#syncStored())
    return this.state()
  }

  async login(body) {
    const nameOrEmail = text(body.nameOrEmail, 200)
    const password = typeof body.password === 'string' ? body.password : ''
    const mfaCode = text(body.mfaCode, 16)
    if (nameOrEmail === '' || password === '' || password.length > 1024) {
      throw new FishPiError('请输入有效的账号和密码', { code: 'invalid_input', status: 400 })
    }

    return this.#serializeAuth(() => this.credentials.exclusive(async () => {
      await this.#syncStored()
      const old = this.record
      const grant = await this.api.login({ nameOrEmail, userPassword: md5Hex(password), mfaCode })
      if (grant?.mfaRequired === true || grant?.mfa_required === true) {
        throw new FishPiError('该账号启用了两步验证，请输入验证码', { code: 'mfa_required', status: 401 })
      }
      const next = this.#grant(grant, { sessionId: randomUUID(), remember: body.remember !== false })
      next.remember = next.remember && next.refreshCookie !== ''
      const profileApi = new FishPiApi({
        token: next.accessToken, siteUrl: this.api.siteUrl, fetchImpl: this.api.fetchImpl,
      })
      next.user = normalizeMe(await profileApi.me())
      if (next.user === undefined) throw new FishPiError('无法读取账号资料', { code: 'invalid_response' })

      if (next.remember) await this.credentials.write(next)
      else await this.credentials.remove()
      this.#setRecord(next)
      this.#revoke(old)
      return this.state()
    }))
  }

  async logout() {
    return this.#serializeAuth(() => this.credentials.exclusive(async () => {
      await this.#syncStored()
      const old = this.record
      await this.credentials.remove()
      this.#setRecord(undefined)
      this.#revoke(old)
      return this.state()
    }))
  }

  #revoke(record) {
    if (record?.refreshCookie) void this.api.logoutWebsite(record.refreshCookie).catch(() => {})
  }

  #serializeAuth(operation) {
    const next = this.authQueue.then(operation)
    this.authQueue = next.catch(() => {})
    return next
  }

  async #syncStored() {
    const stored = await this.credentials.read()
    if (stored === undefined && this.record?.remember !== true) return
    if (stored !== undefined && stored.sessionId === this.record?.sessionId
      && stored.accessToken === this.record.accessToken
      && stored.refreshCookie === this.record.refreshCookie) return
    this.#setRecord(stored)
  }

  #setRecord(next) {
    const changedAccount = next?.sessionId !== this.record?.sessionId
    this.record = next
    this.lastError = undefined
    this.api.setToken(next?.accessToken ?? '')
    if (changedAccount) {
      const previous = this.realtime
      this.realtime = undefined
      previous?.stop()
      this.connectionState = 'disconnected'
      this.hub.log.length = 0
      if (next !== undefined) this.#startRealtime()
    }
    this.#emitState()
  }

  #grant(grant, previous) {
    const accessToken = typeof grant?.accessToken === 'string' ? grant.accessToken : ''
    if (accessToken === '') {
      throw new FishPiError('登录响应缺少访问令牌', { code: 'invalid_response' })
    }
    const now = Date.now()
    return {
      ...previous,
      accessToken,
      tokenExpiresAt: Number(grant.expiresIn) > 0 ? now + Number(grant.expiresIn) * 1000 : 0,
      refreshCookie: grant.refreshCookie || previous.refreshCookie || '',
      refreshExpiresAt: Number(grant.refreshExpiresIn) > 0
        ? now + Number(grant.refreshExpiresIn) * 1000 : previous.refreshExpiresAt || 0,
    }
  }

  #ensureAuth(rejectedToken) {
    return this.#serializeAuth(async () => {
      await this.#syncStored()
      const fresh = () => this.record !== undefined
        && this.record.accessToken !== rejectedToken
        && (this.record.tokenExpiresAt === 0 || this.record.tokenExpiresAt > Date.now() + 60_000)
      if (fresh()) return this.record
      const refresh = async () => {
        if (this.record === undefined) throw this.#expired()
        if (this.record.remember) await this.#syncStored()
        if (fresh()) return this.record
        const current = this.record
        if (current === undefined) throw this.#expired()
        try {
          if (!current.refreshCookie || (current.refreshExpiresAt > 0 && current.refreshExpiresAt <= Date.now())) {
            throw this.#expired()
          }
          const next = this.#grant(await this.api.refreshWebsite(current.refreshCookie), current)
          if (next.remember) await this.credentials.write(next)
          this.#setRecord(next)
          return next
        } catch (error) {
          if (unauthorized(error)) {
            if (current.remember) await this.credentials.remove()
            this.#setRecord(undefined)
            this.lastError = this.#expired()
            this.#emitState()
          }
          throw error
        }
      }
      return this.record?.remember ? this.credentials.exclusive(refresh) : refresh()
    })
  }

  #expired() {
    return new FishPiError('登录状态已失效，请重新登录', { code: 'unauthorized', status: 401 })
  }

  async #withAuth(operation) {
    const original = await this.#ensureAuth()
    try {
      return await operation()
    } catch (error) {
      if (!unauthorized(error)) throw error
      const current = await this.#ensureAuth(original.accessToken)
      if (current.sessionId !== original.sessionId) throw this.#expired()
      return operation()
    }
  }

  /**
   * @param {{ size?: unknown, before?: unknown, after?: unknown }} query - one window.
   * @returns {Promise<Record<string, unknown>>}
   */
  async messages(query) {
    const size = integer(query.size, 30, 1, 50)
    const before = typeof query.before === 'string' && /^\d+$/u.test(query.before) ? query.before : undefined
    const after = typeof query.after === 'string' && /^\d+$/u.test(query.after) ? query.after : undefined
    const data = await this.#withAuth(() => this.api.messages({ size, before, after }))
    const list = Array.isArray(data?.list) ? data.list.map(normalizeMessage).filter(Boolean) : []
    return {
      ok: true,
      list,
      hasMore: data?.hasMore === true,
      nextBefore: data?.nextBefore === undefined ? '' : String(data.nextBefore),
      nextAfter: data?.nextAfter === undefined ? '' : String(data.nextAfter),
    }
  }

  /**
   * Resolve medal icons for message authors, cached per user.
   * @param {string[]} names - public usernames.
   * @returns {Promise<Record<string, unknown>>} medal lists keyed by username.
   */
  async medals(names) {
    const clean = [...new Set(names
      .filter(name => typeof name === 'string' && name !== '' && /^[A-Za-z0-9_-]{1,64}$/u.test(name))
      .slice(0, 30))]
    const output = Object.create(null)
    await Promise.all(clean.map(async name => {
      const cached = this.medalCache.get(name)
      if (cached !== undefined && Date.now() - cached.at < 10 * 60 * 1000) {
        output[name] = cached.medals
        return
      }
      try {
        const medals = normalizeMedals(await this.api.userMedals(name))
        this.medalCache.set(name, { at: Date.now(), medals })
        output[name] = medals
      } catch {
        output[name] = []
      }
    }))
    return { ok: true, medals: output }
  }

  /**
   * @param {{ name?: unknown }} query - public username.
   * @returns {Promise<Record<string, unknown>>} public profile and medal icons.
   */
  async userInfo(query) {
    const userName = typeof query.name === 'string' ? query.name.trim().slice(0, 64) : ''
    if (userName === '' || !/^[A-Za-z0-9_-]+$/u.test(userName)) {
      throw new FishPiError('用户名不正确', { code: 'invalid_input', status: 400 })
    }
    let source
    try {
      source = await this.#withAuth(() => this.api.legacyUser(userName))
    } catch {
      source = await this.#withAuth(() => this.api.userProfile(userName))
    }
    const raw = source !== null && typeof source === 'object' ? source : {}
    const profile = {
      id: raw.oId === undefined && raw.id === undefined ? '' : String(raw.oId ?? raw.id),
      userNo: raw.userNo === undefined || raw.userNo === null ? '' : String(raw.userNo),
      userName: typeof raw.userName === 'string' ? raw.userName : userName,
      userNickname: typeof raw.userNickname === 'string' ? raw.userNickname : '',
      userAvatarURL: typeof raw.userAvatarURL === 'string' ? raw.userAvatarURL : '',
      userIntro: typeof raw.userIntro === 'string' ? raw.userIntro : '',
      userURL: typeof raw.userURL === 'string' ? raw.userURL : '',
      userRole: typeof raw.userRole === 'string' ? raw.userRole : '',
      userCity: typeof raw.userCity === 'string' ? raw.userCity : '',
      cardBg: typeof raw.cardBg === 'string' ? raw.cardBg : '',
      userPoint: Number.isFinite(Number(raw.userPoint)) ? Number(raw.userPoint) : undefined,
      onlineMinute: Number.isFinite(Number(raw.onlineMinute)) ? Number(raw.onlineMinute) : undefined,
    }
    let medals = []
    try {
      medals = normalizeMedals(await this.api.userMedals(userName))
    } catch {
      medals = []
    }
    return { ok: true, profile, medals }
  }

  /**
   * @param {{ prefix?: unknown }} query - username prefix typed after `@`.
   * @returns {Promise<Record<string, unknown>>} matching users.
   */
  async suggestUsers(query) {
    const prefix = typeof query.prefix === 'string' ? query.prefix.slice(0, 64) : ''
    if (prefix === '' || !/^[A-Za-z0-9_-]+$/u.test(prefix)) return { ok: true, list: [] }
    const data = await this.#withAuth(() => this.api.suggestUsers(prefix))
    const list = Array.isArray(data?.list)
      ? data.list
          .filter(user => user !== null && typeof user === 'object')
          .map(user => ({
            id: user.id === undefined ? '' : String(user.id),
            userName: typeof user.userName === 'string' ? user.userName : '',
            userNickname: typeof user.userNickname === 'string' ? user.userNickname : '',
            userAvatarURL: typeof user.userAvatarURL === 'string' ? user.userAvatarURL : '',
          }))
      : []
    return { ok: true, list }
  }

  /**
   * Upload image files through a FishPi upload ticket and return their URLs.
   * @param {FormData} form - multipart body with one or more `file` entries.
   * @returns {Promise<Record<string, unknown>>} uploaded file names and URLs.
   */
  async upload(form, sessionId) {
    const files = form.getAll('file').filter(value => value !== null && typeof value === 'object' && typeof value.arrayBuffer === 'function')
    if (files.length === 0) throw new FishPiError('请选择要上传的图片', { code: 'invalid_input', status: 400 })
    if (files.length > 9) throw new FishPiError('一次最多上传 9 张图片', { code: 'invalid_input', status: 400 })
    let total = 0
    for (const file of files) {
      const size = Number(file.size) || 0
      if (size === 0) throw new FishPiError('图片内容为空', { code: 'invalid_input', status: 400 })
      if (size > 10 * 1024 * 1024) throw new FishPiError('单张图片不能超过 10MB', { code: 'invalid_input', status: 413 })
      total += size
    }
    if (total > 30 * 1024 * 1024) throw new FishPiError('图片总大小不能超过 30MB', { code: 'invalid_input', status: 413 })

    const ticket = await this.#withAuth(() => {
      if (sessionId !== this.record?.sessionId) throw this.#expired()
      return this.api.uploadTicket()
    })
    if (ticket === null || typeof ticket !== 'object' || typeof ticket.uploadURL !== 'string') {
      throw new FishPiError('上传票据无效', { code: 'invalid_response' })
    }
    const uploadUrl = new URL(ticket.uploadURL)
    if (uploadUrl.protocol !== 'https:' || !['pic.fishpi.cn', 'file.fishpi.cn'].includes(uploadUrl.hostname)
      || uploadUrl.username || uploadUrl.password || uploadUrl.port) {
      throw new FishPiError('上传票据的地址不正确', { code: 'invalid_response' })
    }
    const fieldName = typeof ticket.fieldName === 'string' && ticket.fieldName !== '' ? ticket.fieldName : 'file'
    const upload = new FormData()
    const names = new Map()
    files.forEach((file, index) => {
      const original = typeof file.name === 'string' && file.name !== '' ? file.name : `image-${index + 1}.png`
      const extension = /\.[a-z0-9]{1,10}$/iu.exec(original)?.[0] ?? ''
      const name = `${randomUUID()}${extension}`
      names.set(name, original)
      upload.append(fieldName, file, name)
    })

    let response
    try {
      response = await this.api.fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${ticket.ticket}` },
        body: upload,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      throw new FishPiError('图片上传失败，请检查网络后重试', { code: 'network', cause: error })
    }
    let payload = null
    try {
      payload = await response.json()
    } catch {
      // The status and upload response carry the failure.
    }
    if (!response.ok || payload?.code !== 0 && payload?.code !== '0') {
      throw new FishPiError(
        typeof payload?.msg === 'string' && payload.msg !== '' ? payload.msg : `图片上传失败（HTTP ${response.status}）`,
        { code: 'upload_failed', status: response.status },
      )
    }
    const succMap = payload?.data?.succMap !== null && typeof payload?.data?.succMap === 'object' ? payload.data.succMap : {}
    const uploaded = []
    for (const [name, original] of names) {
      const url = succMap[name]
      if (typeof url === 'string' && url !== '') uploaded.push({ name: original, url })
    }
    if (uploaded.length === 0) {
      throw new FishPiError('图片上传失败，请稍后重试', { code: 'upload_failed', status: 502 })
    }
    return { ok: true, files: uploaded }
  }

  /**
   * @param {{ id?: unknown }} query - red-packet message id.
   * @returns {Promise<Record<string, unknown>>} the red-packet detail.
   */
  async redPacket(query) {
    const id = typeof query.id === 'string' && /^\d+$/u.test(query.id) ? query.id : ''
    if (id === '') throw new FishPiError('红包 ID 不正确', { code: 'invalid_input', status: 400 })
    const detail = await this.#withAuth(() => this.api.redPacket(id))
    return { ok: true, detail }
  }

  /**
   * @param {{ id?: unknown, gesture?: unknown, riskAccepted?: unknown, requestId?: unknown }} body - claim form.
   * @returns {Promise<Record<string, unknown>>} the claim and refreshed detail.
   */
  async claimRedPacket(body) {
    const id = typeof body.id === 'string' && /^\d+$/u.test(body.id) ? body.id : ''
    if (id === '') throw new FishPiError('红包 ID 不正确', { code: 'invalid_input', status: 400 })
    const gesture = Number.isInteger(body.gesture) && body.gesture >= 0 && body.gesture <= 2 ? body.gesture : undefined
    const riskAccepted = body.riskAccepted === true
    const rawId = typeof body.requestId === 'string' ? body.requestId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) : ''
    const requestId = rawId === '' ? randomUUID() : rawId
    const idempotencyKey = `fishpi-chat-claim-${requestId}`
    const claim = await this.#withAuth(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.api.claimRedPacket(id, { gesture, riskAccepted }, idempotencyKey)
        } catch (error) {
          const retryable = error instanceof FishPiError
            && attempt === 0
            && (error.code === 'confirmation_required' || error.code === 'network')
          if (!retryable) throw error
          if (error.code === 'network') await delay(400)
        }
      }
    })
    let detail
    try {
      detail = await this.#withAuth(() => this.api.redPacket(id))
    } catch {
      detail = undefined
    }
    return { ok: true, claim, detail: detail ?? null }
  }

  /** @returns {Promise<Record<string, unknown>>} the current topic. */
  async topic() {
    const data = await this.#withAuth(() => this.api.topic())
    return { ok: true, text: typeof data?.text === 'string' ? data.text : '' }
  }

  /** @returns {Promise<Record<string, unknown>>} visible online users. */
  async online() {
    const data = await this.#withAuth(() => this.api.onlineUsers({ size: 50 }))
    const list = Array.isArray(data?.list)
      ? data.list
          .filter(user => user !== null && typeof user === 'object')
          .map(user => ({
            id: user.id === undefined ? '' : String(user.id),
            userName: typeof user.userName === 'string' ? user.userName : '',
            userAvatarURL: typeof user.userAvatarURL === 'string' ? user.userAvatarURL : '',
          }))
      : []
    return { ok: true, total: Number(data?.pagination?.total) || list.length, list }
  }

  /**
   * Recall one of the current account's messages.
   * @param {{ id?: unknown, requestId?: unknown }} body - recall request.
   * @returns {Promise<Record<string, unknown>>}
   */
  async recall(body) {
    const id = typeof body.id === 'string' && /^\d+$/u.test(body.id) ? body.id : ''
    if (id === '') throw new FishPiError('消息 ID 不正确', { code: 'invalid_input', status: 400 })
    const rawId = typeof body.requestId === 'string' ? body.requestId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) : ''
    const requestId = rawId === '' ? randomUUID() : rawId
    const result = await this.#withAuth(() => this.api.revokeMessage(id, `fishpi-chat-revoke-${requestId}`))
    if (result?.removed === false) throw new FishPiError('消息未能撤回', { code: 'recall_failed' })
    this.hub.emit('message.deleted', { messageId: id })
    return { ok: true, id, removed: true }
  }

  /**
   * Send one message with a caller-stable request id.
   * @param {{ content?: unknown, requestId?: unknown }} body - composer payload.
   * @returns {Promise<Record<string, unknown>>}
   */
  async send(body) {
    const content = text(body.content, MAX_MESSAGE_LENGTH + 1)
    if (content === '') throw new FishPiError('消息不能为空', { code: 'invalid_input', status: 400 })
    if (content.length > MAX_MESSAGE_LENGTH) throw new FishPiError('消息超过 4096 个字符', { code: 'invalid_input', status: 400 })
    const rawId = typeof body.requestId === 'string' ? body.requestId.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64) : ''
    const requestId = rawId === '' ? randomUUID() : rawId
    const idempotencyKey = `fishpi-chat-${requestId}`

    const accepted = await this.#withAuth(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.api.send(content, idempotencyKey)
        } catch (error) {
          const retryable = error instanceof FishPiError
            && attempt === 0
            && (error.code === 'confirmation_required' || error.code === 'network')
          if (!retryable) throw error
          if (error.code === 'network') await delay(400)
        }
      }
    })

    let message
    try {
      const raw = await this.#withAuth(() => this.api.message(String(accepted?.id ?? '')))
      message = normalizeMessage(raw)
    } catch {
      message = undefined
    }
    if (message !== undefined) this.hub.emit('message.created', { message })
    return {
      ok: true,
      id: accepted?.id === undefined ? '' : String(accepted.id),
      createdAt: Number(accepted?.createdAt) || Date.now(),
      message: message ?? null,
    }
  }

  async events(query, signal) {
    await this.sync()
    const since = integer(query.since, 0, 0, Number.MAX_SAFE_INTEGER)
    return this.hub.wait(since, signal, EVENT_WAIT_MS)
  }

  /** Start a fresh socket for the current token. */
  #startRealtime() {
    if (this.stopped) return
    this.realtime?.stop()
    this.connectionState = 'connecting'
    const realtime = new ChatRealtime({
      siteUrl: this.api.siteUrl,
      getTicket: () => this.#withAuth(() => this.api.realtimeTicket()),
      onState: state => {
        if (this.realtime !== realtime) return
        this.connectionState = state
        this.hub.emit('connection', { state })
        this.#emitState()
      },
      onEvent: event => {
        if (this.realtime === realtime) void this.#onRealtime(event)
      },
      onError: () => {},
    })
    this.realtime = realtime
    realtime.start()
  }

  /**
   * @param {{ type: string, data: any }} event - one socket event.
   */
  async #onRealtime(event) {
    if (this.stopped) return
    if (event.type === 'ready') {
      this.hub.emit('sync', { reason: 'ready' })
      return
    }
    const message = event.data
    if (message === null || typeof message !== 'object') return
    switch (message.type) {
      case 'chat.message.created':
      case 'chat.message.updated': {
        const snapshot = normalizeMessage(message.data?.message)
        if (snapshot !== undefined) {
          this.hub.emit(message.type === 'chat.message.created' ? 'message.created' : 'message.updated', { message: snapshot })
          return
        }
        const id = message.data?.messageId === undefined ? '' : String(message.data.messageId)
        if (id !== '') await this.#fetchAndEmitMessage(id, message.type === 'chat.message.updated')
        return
      }
      case 'chat.message.deleted': {
        const id = message.data?.messageId === undefined ? '' : String(message.data.messageId)
        if (id !== '') this.hub.emit('message.deleted', { messageId: id })
        return
      }
      case 'chat.message.reactions':
        return
      case 'chat.topic_changed': {
        void this.#refreshTopic()
        return
      }
      case 'chat.sync_required': {
        this.hub.emit('sync', { reason: 'server' })
        return
      }
      case 'chat.presence.changed': {
        const data = message.data ?? {}
        this.hub.emit('presence', {
          id: data.id === undefined ? '' : String(data.id),
          kind: data.kind === 'leave' ? 'leave' : 'join',
          text: typeof data.text === 'string' ? data.text : '',
          actor: data.actor ?? null,
          mount: data.mount ?? null,
          avatarURL: typeof data.avatarURL === 'string' ? data.avatarURL : '',
          createdAt: Number(data.createdAt) || Date.now(),
        })
        return
      }
      case 'chat.red_packet.claimed': {
        const data = message.data ?? {}
        this.hub.emit('redPacket.claimed', {
          id: data.id === undefined ? '' : String(data.id),
          sender: data.sender ?? null,
          actor: data.actor ?? null,
          got: Number(data.got) || 0,
          count: Number(data.count) || 0,
          createdAt: Number(data.createdAt) || Date.now(),
        })
        return
      }
      default:
        return
    }
  }

  /** Re-read the topic and publish it. */
  async #refreshTopic() {
    try {
      const data = await this.#withAuth(() => this.api.topic())
      this.hub.emit('topic', { text: typeof data?.text === 'string' ? data.text : '' })
    } catch {
      // A topic refresh is best-effort; the next sync retries it.
    }
  }

  /**
   * @param {string} id - message id from a revision-only event.
   * @param {boolean} updated - whether the message already existed.
   */
  async #fetchAndEmitMessage(id, updated) {
    try {
      const raw = await this.#withAuth(() => this.api.message(id))
      const message = normalizeMessage(raw)
      if (message !== undefined) {
        this.hub.emit(updated ? 'message.updated' : 'message.created', { message })
      }
    } catch {
      // The next sync reads the window again, so a missed snapshot is recoverable.
    }
  }

  /** Publish the whole session state to every browser. */
  #emitState() {
    this.hub.emit('state', this.state())
  }

}
