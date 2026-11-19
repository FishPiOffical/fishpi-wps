import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import DOMPurify from 'dompurify'
import { ImagePreview, imagePreviewFromEvent } from './image-preview.js'
import packageInfo from '../package.json'
import { translator } from './copy.js'
import { LOGO_ANIMATION } from './logo.js'
import { MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, UPLOAD_CHUNK_BYTES } from './upload-limits.js'

const { version } = packageInfo
const h = React.createElement
let bridge
let sharedStore

/** FishPi registration page, returning to the chatroom after sign-up. */
const REGISTER_URL = 'https://fishpi.cn/register?goto=https%3A%2F%2Ffishpi.cn%2Fcr'
/** Message window size used by the initial load and by sync/reconnect. */
const WINDOW_SIZE = 30
/** A longer server-published topic or message is clipped for display. */
const MAX_TOPIC = 160
/** Retained messages before the oldest is dropped from the live window. */
const MAX_RETAINED = 400
/** @returns {string} a UUID for idempotent sends, with a fallback for old engines. */
function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Local record of red packets this browser account has already claimed. */
const CLAIMED_KEY_PREFIX = 'fishpi-chat.claimed.v1.'

/** @param {string} userId - account id. @returns {string[]} claimed packet ids. */
function readClaimed(userId) {
  try {
    const raw = localStorage.getItem(`${CLAIMED_KEY_PREFIX}${userId}`)
    if (raw === null) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** @param {string} userId - account id. @param {string[]} ids - claimed packet ids. */
function writeClaimed(userId, ids) {
  if (userId === '') return
  try {
    localStorage.setItem(`${CLAIMED_KEY_PREFIX}${userId}`, JSON.stringify(ids))
  } catch {
    // Claim state is a display cache; the server remains authoritative.
  }
}

async function call(action, args = {}, options = {}) {
  let result
  try {
    result = await bridge.callServerTool({
      name: `fishpi_${action.replace(/[-/]/gu, '_')}`,
      arguments: args,
    }, options)
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw Object.assign(new Error('network'), { code: 'network' })
  }
  const data = result.structuredContent
  if (result.isError || data?.ok === false) {
    const detail = result.content?.find(item => item.type === 'text')?.text
    throw Object.assign(new Error(data?.message || detail || 'FishPi operation failed'), {
      code: data?.code ?? 'generic',
      status: data?.status,
    })
  }
  return data ?? {}
}

/**
 * @param {number} ms - wait length.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * @param {unknown} raw - a Host-normalized message.
 * @returns {object|undefined}
 */
function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const source = /** @type {Record<string, any>} */ (raw)
  const id = source.id === undefined || source.id === null ? '' : String(source.id)
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
    medals: Array.isArray(source.medals) ? source.medals : [],
    card: source.card !== null && typeof source.card === 'object' ? source.card : {},
    reactionsUnavailable: source.reactionsUnavailable === true,
  }
}

/**
 * @param {object|undefined} user - a user record.
 * @returns {string} `nickname(username)`, or whichever part exists.
 */
function displayUser(user) {
  const nickname = typeof user?.userNickname === 'string' ? user.userNickname.trim() : ''
  const username = typeof user?.userName === 'string' ? user.userName.trim() : ''
  if (nickname !== '' && username !== '') return `${nickname}(${username})`
  return nickname || username || '—'
}

/**
 * @param {number} ms - timestamp.
 * @returns {string} local `HH:mm`.
 */
function clock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * @param {number} ms - timestamp.
 * @returns {string} a day bucket for separators.
 */
function dayKey(ms) {
  const date = new Date(Number(ms) || 0)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/**
 * @param {number} ms - timestamp.
 * @param {Function} t - bound translate.
 * @returns {string} a localized date separator.
 */
function dayLabel(ms, t) {
  const date = new Date(Number(ms) || 0)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(ms) === dayKey(today.getTime())) return t('day.today')
  if (dayKey(ms) === dayKey(yesterday.getTime())) return t('day.yesterday')
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * @param {string} html - server-sanitized HTML.
 * @returns {string} HTML whose links and images are hardened for an embedded panel.
 */
const htmlCache = new Map()
function prepareHtml(html, base, previewLabel = '') {
  if (html === '') return ''
  const cacheKey = `${base}\n${previewLabel}\n${html}`
  const cached = htmlCache.get(cacheKey)
  if (cached !== undefined) return cached
  const origin = typeof base === 'string' && base !== '' ? base : 'https://fishpi.cn'
  const resolve = value => {
    try {
      const url = new URL(value, origin)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
    } catch {
      return ''
    }
  }
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'a', 'img', 'p', 'div', 'span', 'br', 'hr', 'strong', 'b', 'em', 'i',
      's', 'del', 'u', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table',
      'thead', 'tbody', 'tr', 'th', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'details', 'summary', 'kbd', 'sup', 'sub',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'start', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  })
  for (const element of sanitized.querySelectorAll('a[href], img[src]')) {
    const link = element.tagName === 'A'
    const attribute = link ? 'href' : 'src'
    const resolved = resolve(element.getAttribute(attribute))
    if (resolved === '') element.removeAttribute(attribute)
    else element.setAttribute(attribute, resolved)
    if (link) {
      element.target = '_blank'
      element.rel = 'noopener noreferrer'
    } else {
      element.loading = 'lazy'
      element.referrerPolicy = 'no-referrer'
      if (resolved !== '' && previewLabel !== '') {
        element.dataset.fcPreview = ''
        element.tabIndex = 0
        element.setAttribute('role', 'button')
        element.setAttribute('aria-label', element.alt ? `${previewLabel}: ${element.alt}` : previewLabel)
      }
    }
  }
  const template = document.createElement('template')
  template.content.append(sanitized)
  const output = template.innerHTML
  if (htmlCache.size > 200) htmlCache.clear()
  htmlCache.set(cacheKey, output)
  return output
}

/**
 * @param {string} html - markup from the server.
 * @param {string} [imageLabel] - text substituted for each image.
 * @returns {string} its text content.
 */
function plainFromHtml(html, imageLabel = '') {
  if (html === '') return ''
  try {
    const holder = document.createElement('div')
    holder.innerHTML = html
    if (imageLabel !== '') {
      for (const image of holder.querySelectorAll('img')) {
        image.replaceWith(document.createTextNode(imageLabel))
      }
    }
    return holder.textContent ?? ''
  } catch {
    return html
  }
}

/**
 * Replace Markdown and HTML image syntax with a plain text label, leaving
 * fenced and inline code untouched so copied code stays readable.
 * @param {string} text - Markdown source.
 * @param {string} label - text substituted for each image.
 * @returns {string} source with images labelled.
 */
function replaceImages(text, label) {
  const replaceSegment = segment => segment
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/gu, label)
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, label)
    .replace(/!\[[^\]]*\]\[[^\]]*\]/gu, label)
    .replace(/<img\b[^>]*>/giu, label)
  const code = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu
  let output = ''
  let last = 0
  let match
  while ((match = code.exec(text)) !== null) {
    output += replaceSegment(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return output + replaceSegment(text.slice(last))
}

/**
 * @param {object} message - normalized message.
 * @param {Function} t - bound translate.
 * @returns {string} plain-mode text with image source replaced by a label.
 */
function plainMessage(message, t) {
  const label = `[${t('plain.image')}]`
  if (message.content !== '') return replaceImages(message.content, label)
  return plainFromHtml(message.contentHtml, label)
}

/**
 * @param {object} message - normalized message.
 * @param {Function} t - bound translate.
 * @returns {string} one-line text for notifications and accessibility.
 */
function messageSummary(message, t) {
  if (message.type === 'redPacket') {
    const card = message.card?.redPacket ?? message.card ?? {}
    return `${t('card.redPacket')} ${typeof card.message === 'string' ? card.message : ''}`.trim()
  }
  if (message.type === 'music') {
    const card = message.card?.music ?? message.card ?? {}
    return `${t('card.music')} ${typeof card.title === 'string' ? card.title : ''}`.trim()
  }
  if (message.type === 'weather') {
    const card = message.card?.weather ?? message.card ?? {}
    return `${t('card.weather')} ${typeof card.t === 'string' ? card.t : ''}`.trim()
  }
  if (message.type === 'unavailable') return t('card.unavailable')
  return replaceImages(message.content || plainFromHtml(message.contentHtml, `[${t('plain.image')}]`), `[${t('plain.image')}]`).slice(0, 160)
}

/**
 * @param {string} code - stable failure code.
 * @param {string|undefined} fallback - server text.
 * @param {Function} t - bound translate.
 * @returns {string}
 */
function localizedError(code, fallback, t) {
  switch (code) {
    case 'network': return t('error.network')
    case 'unauthorized': return t('error.unauthorized')
    case 'invalid_credentials': return t('error.credentials')
    case 'mfa_required': return t('error.mfa')
    case 'captcha_required': return t('error.captcha')
    case 'forbidden': return t('error.forbidden')
    case 'insufficient_points': return t('error.points')
    case 'rate_limited': return t('error.rate')
    case 'upload_failed': return t('error.upload')
    case 'message_not_removable': return t('error.notRemovable')
    case 'http_404':
    case 'not_found': return t('error.notFound')
    case 'recall_failed': return t('error.recallFailed')
    case 'realtime_unavailable':
    case 'internal':
    case 'http_500':
    case 'http_502':
    case 'http_503': return t('error.server')
    default: return fallback !== undefined && fallback !== '' ? fallback : t('error.generic')
  }
}

/**
 * Shared reactive state for the chat panel and settings.
 * The local bridge owns the FishPi session.
 * @param {Function} t - bound translate used for system lines and notifications.
 */
function createStore(t) {
  let state = {
    loaded: false,
    loggedIn: false,
    user: null,
    connection: 'disconnected',
    messages: [],
    hasMore: false,
    loadingMessages: false,
    loadingOlder: false,
    sending: false,
    recalling: false,
    uploadingImages: false,
    loggingIn: false,
    loginError: null,
    mfaRequired: false,
    topic: '',
    online: 0,
    onlineUsers: [],
    cursor: 0,
    unread: 0,
    chatVisible: false,
    error: null,
    siteUrl: 'https://fishpi.cn',
    prefs: { mode: 'rich', notifications: false },
    redPacketId: null,
    redPacketGesture: null,
    redPacket: null,
    redPacketLoading: false,
    redPacketError: null,
    redPacketClaiming: false,
    redPacketClaim: null,
    claimedPacketIds: [],
    userInfoName: null,
    userInfo: null,
    userInfoMedals: [],
    userInfoLoading: false,
    userInfoError: null,
    medalIcons: {},
  }
  let disposed = false
  let controller = new AbortController()
  let started = false
  let claimedUserId = ''
  let redPacketSeq = 0
  let preferencesQueue = Promise.resolve()
  let recallKey = { id: '', requestId: '' }
  const medalPending = new Set()
  const listeners = new Set()
  const store = {
    getSnapshot: () => state,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  /**
   * @param {Partial<typeof state>} patch - state fields to replace.
   */
  function set(patch) {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of [...listeners]) listener()
  }

  function trim(messages) {
    return messages.length > MAX_RETAINED ? messages.slice(messages.length - MAX_RETAINED) : messages
  }

  /**
   * @param {object[]} messages - current list.
   * @param {object} message - message to insert or replace.
   * @returns {object[]} sorted, deduplicated list.
   */
  function mergeOne(messages, message) {
    const index = messages.findIndex(item => item.id === message.id)
    if (index >= 0) {
      const next = messages.slice()
      next[index] = message
      return next
    }
    const next = [...messages, message]
    next.sort((left, right) => (left.createdAt - right.createdAt) || (Number(left.id) - Number(right.id)))
    return next
  }

  /**
   * @param {object} message - one normalized message.
   * @param {boolean} isNew - whether the event announces a new message.
   */
  function receive(message, isNew) {
    const existing = state.messages.findIndex(item => item.id === message.id)
    if (existing >= 0) {
      set({ messages: mergeOne(state.messages, message) })
      return
    }
    const own = message.author?.id !== undefined && message.author.id !== '' && message.author.id === state.user?.id
    const hidden = !state.chatVisible || document.hidden || !document.hasFocus()
    const next = mergeOne(state.messages, message)
    if (isNew && !own && hidden) {
      set({ messages: trim(next), unread: state.unread + 1 })
      notify(message)
      return
    }
    set({ messages: trim(next) })
  }

  /**
   * @param {object} message - new message.
   */
  function notify(message) {
    if (!state.prefs.notifications) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const author = displayUser(message.author)
    try {
      const notification = new Notification(t('notify.title', { name: author }), {
        body: messageSummary(message, t).slice(0, 140),
        tag: 'fishpi-chat',
        renotify: true,
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch {
      // A platform without a notification surface simply skips it.
    }
  }

  /**
   * @param {object} data - Host state payload.
   */
  function applyState(data, { cursor = data.cursor, reset = false } = {}) {
    const was = state.loggedIn
    const nextUserId = data.user?.id === undefined ? '' : String(data.user.id)
    const userChanged = nextUserId !== claimedUserId
    const claimedPacketIds = userChanged
      ? (nextUserId === '' ? [] : readClaimed(nextUserId))
      : state.claimedPacketIds
    claimedUserId = nextUserId
    if (userChanged) {
      redPacketSeq += 1
      medalPending.clear()
    }
    set({
      ...(userChanged ? {
        messages: [],
        hasMore: false,
        loadingMessages: false,
        loadingOlder: false,
        recalling: false,
        unread: 0,
        topic: '',
        online: 0,
        onlineUsers: [],
        redPacketId: null,
        redPacketGesture: null,
        redPacket: null,
        redPacketError: null,
        redPacketClaiming: false,
        redPacketClaim: null,
        userInfoName: null,
        userInfo: null,
        userInfoMedals: [],
        userInfoLoading: false,
        userInfoError: null,
        medalIcons: {},
      } : {}),
      loaded: true,
      loggedIn: data.loggedIn === true,
      user: data.user ?? null,
      connection: data.connection ?? state.connection,
      cursor: reset ? Number(cursor) || 0 : Math.max(state.cursor, Number(cursor) || 0),
      siteUrl: data.siteUrl || state.siteUrl,
      error: data.error === undefined ? state.error : data.error,
      prefs: data.prefs ?? state.prefs,
      claimedPacketIds,
    })
    if (data.loggedIn && (!was || userChanged || reset)) void syncAll()
  }

  /** @param {object} event - one Host event envelope. */
  function applyEvent(event) {
    if (event === null || typeof event !== 'object') return
    const data = event.data ?? {}
    switch (event.type) {
      case 'state': applyState(data, { cursor: event.seq }); return
      case 'connection': {
        set({ connection: typeof data.state === 'string' ? data.state : state.connection })
        if (data.state === 'connected') void syncAll()
        return
      }
      case 'sync': {
        void syncAll()
        return
      }
      case 'message.created': {
        const message = normalizeMessage(data.message)
        if (message !== undefined) receive(message, true)
        return
      }
      case 'message.updated': {
        const message = normalizeMessage(data.message)
        if (message !== undefined) receive(message, false)
        return
      }
      case 'message.deleted': {
        const id = data.messageId === undefined ? '' : String(data.messageId)
        if (id !== '') set({ messages: state.messages.filter(message => message.id !== id) })
        return
      }
      case 'topic': {
        set({ topic: typeof data.text === 'string' ? data.text.slice(0, MAX_TOPIC) : '' })
        return
      }
      case 'presence': {
        const id = `presence-${data.id === undefined || data.id === '' ? Date.now() : data.id}`
        if (state.messages.some(message => message.id === id)) return
        const actor = data.actor ?? {}
        const name = displayUser(actor)
        const text = typeof data.text === 'string' && data.text !== ''
          ? data.text
          : (data.kind === 'leave' ? t('system.leave', { name }) : t('system.join', { name }))
        set({
          messages: trim([...state.messages, {
            id,
            type: 'system',
            createdAt: Number(data.createdAt) || Date.now(),
            text,
            author: {},
          }]),
        })
        return
      }
      default: return
    }
  }

  /** Reload the latest message window, topic, and online count. */
  async function syncAll() {
    if (disposed || !state.loggedIn) return
    if (syncAll.running) {
      syncAll.queued = true
      return
    }
    syncAll.running = true
    try {
      await Promise.all([loadLatest(), loadTopic(), loadOnline()])
    } finally {
      syncAll.running = false
      if (syncAll.queued) {
        syncAll.queued = false
        void syncAll()
      }
    }
  }
  syncAll.running = false
  syncAll.queued = false

  /**
   * Load the newest window. With an existing window the result is merged,
   * so a reconnect does not discard pages loaded with “Load earlier”.
   * @param {{ replace?: boolean }} [options] - true resets the window.
   */
  async function loadLatest(options = {}) {
    if (disposed || !state.loggedIn) return
    const replace = options.replace === true || state.messages.length === 0
    set({ loadingMessages: state.messages.length === 0 })
    try {
      const data = await call('messages', { size: WINDOW_SIZE }, { signal: controller.signal })
      const list = Array.isArray(data.list) ? data.list.map(normalizeMessage).filter(Boolean) : []
      const next = replace ? list : list.reduce((messages, message) => mergeOne(messages, message), state.messages)
      set({
        messages: trim(next),
        hasMore: replace ? data.hasMore === true : state.hasMore || data.hasMore === true,
        loadingMessages: false,
      })
    } catch (error) {
      if (!disposed) set({ loadingMessages: false, error: { code: error.code ?? 'generic', message: error.message } })
    }
  }

  /** Load the page before the oldest loaded message. */
  async function loadOlder() {
    const first = state.messages.find(message => message.type !== 'system')
    if (first === undefined || !state.hasMore || state.loadingOlder) return 0
    set({ loadingOlder: true })
    try {
      const data = await call('messages', { size: WINDOW_SIZE, before: first.id }, { signal: controller.signal })
      const older = Array.isArray(data.list) ? data.list.map(normalizeMessage).filter(Boolean) : []
      const known = new Set(state.messages.map(message => message.id))
      const fresh = older.filter(message => !known.has(message.id))
      const next = [...fresh, ...state.messages]
      next.sort((left, right) => (left.createdAt - right.createdAt) || (Number(left.id) - Number(right.id)))
      set({ messages: next, hasMore: data.hasMore === true, loadingOlder: false })
      return fresh.length
    } catch (error) {
      if (!disposed) set({ loadingOlder: false, error: { code: error.code ?? 'generic', message: error.message } })
      return 0
    }
  }

  /** Refresh the current topic. */
  async function loadTopic() {
    try {
      const data = await call('topic', {}, { signal: controller.signal })
      if (!disposed) set({ topic: typeof data.text === 'string' ? data.text.slice(0, MAX_TOPIC) : '' })
    } catch {
      // A topic is secondary; the next sync retries it.
    }
  }

  /** Refresh the visible online count. */
  async function loadOnline() {
    try {
      const data = await call('online', {}, { signal: controller.signal })
      if (!disposed) {
        set({
          online: Number(data.total) || 0,
          onlineUsers: Array.isArray(data.list)
            ? data.list.filter(user => user !== null && typeof user === 'object').slice(0, 50)
            : [],
        })
      }
    } catch {
      // The count is secondary; the next sync retries it.
    }
  }

  /**
   * @param {{ nameOrEmail: string, password: string, mfaCode?: string, remember: boolean }} input - login form.
   * @returns {Promise<{ok: boolean, code?: string, message?: string, mfaRequired?: boolean}>}
   */
  async function login(input) {
    set({ loggingIn: true, loginError: null })
    try {
      const data = await call('login', input, { signal: controller.signal })
      applyState(data)
      set({ loggingIn: false, loginError: null, mfaRequired: false })
      return { ok: true }
    } catch (error) {
      const failure = { ok: false, code: error.code, message: error.message }
      set({ loggingIn: false, loginError: failure, mfaRequired: error.code === 'mfa_required' })
      return failure
    }
  }

  async function logout() {
    try {
      applyState(await call('logout', {}, { signal: controller.signal }))
    } catch (error) {
      set({ error: { code: error.code ?? 'generic', message: error.message } })
    }
  }

  /**
   * Resolve medal icons for message authors and merge them into the cache.
   * @param {object[]} messages - current message window.
   */
  async function loadMedalIcons(messages) {
    if (disposed || !state.loggedIn) return
    const names = [...new Set(messages
      .filter(message => message.author?.userName && Array.isArray(message.medals) && message.medals.length > 0)
      .map(message => message.author.userName))]
    const missing = names.filter(name => !(name in state.medalIcons) && !medalPending.has(name))
    if (missing.length === 0) return
    for (const name of missing) medalPending.add(name)
    try {
      for (let index = 0; index < missing.length; index += 30) {
        const batch = missing.slice(index, index + 30)
        const data = await call('medals', { names: batch }, { signal: controller.signal })
        const medalIcons = { ...state.medalIcons }
        for (const name of batch) medalIcons[name] = Array.isArray(data.medals?.[name]) ? data.medals[name] : []
        set({ medalIcons })
      }
    } catch {
      const medalIcons = { ...state.medalIcons }
      for (const name of missing) medalIcons[name] ??= []
      set({ medalIcons })
    } finally {
      for (const name of missing) medalPending.delete(name)
    }
  }

  /**
   * Open one user's public profile and medal icons.
   * @param {string} userName - public username.
   */
  async function openUserInfo(userName) {
    const name = typeof userName === 'string' ? userName.trim() : ''
    if (name === '' || !/^[A-Za-z0-9_-]+$/u.test(name)) return
    set({
      userInfoName: name,
      userInfo: null,
      userInfoMedals: [],
      userInfoLoading: true,
      userInfoError: null,
    })
    try {
      const data = await call('user', { name }, { signal: controller.signal })
      if (state.userInfoName === name) {
        set({
          userInfo: data.profile ?? null,
          userInfoMedals: Array.isArray(data.medals) ? data.medals : [],
          userInfoLoading: false,
        })
      }
    } catch (error) {
      if (state.userInfoName === name) {
        set({
          userInfoLoading: false,
          userInfoError: { code: error.code ?? 'generic', message: error.message },
        })
      }
    }
  }

  /** Close the user profile dialog. */
  function closeUserInfo() {
    set({
      userInfoName: null,
      userInfo: null,
      userInfoMedals: [],
      userInfoLoading: false,
      userInfoError: null,
    })
  }

  /**
   * Search usernames for an `@` mention candidate list.
   * @param {string} prefix - text typed after `@`.
   * @returns {Promise<object[]>} matching users.
   */
  async function suggestUsers(prefix) {
    if (!state.loggedIn || prefix === '') return []
    try {
      const data = await call('users', { prefix }, { signal: controller.signal })
      return Array.isArray(data.list) ? data.list : []
    } catch {
      return []
    }
  }

  /**
   * Upload one or more images through the Host's authenticated upload route.
   * @param {FileList|File[]} files - images selected or pasted by the user.
   * @returns {Promise<{ok: boolean, files?: {name: string, url: string}[]}>}
   */
  async function uploadImages(files) {
    const images = [...files].filter(file => file !== null
      && typeof file === 'object'
      && typeof file.type === 'string'
      && file.type.startsWith('image/'))
    if (images.length === 0 || state.uploadingImages) return { ok: false }
    const batchId = uuid()
    set({ uploadingImages: true, error: null })
    try {
      if (images.length > MAX_UPLOAD_FILES || images.some(file => file.size === 0 || file.size > MAX_IMAGE_BYTES)
        || images.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_BYTES) {
        throw Object.assign(new Error(t('upload.limits')), { code: 'invalid_input' })
      }
      for (const [index, file] of images.entries()) {
        const name = (file.name || 'image.png').slice(0, 255)
        for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
          const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer())
          let binary = ''
          for (let start = 0; start < bytes.length; start += 8192) {
            binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
          }
          await call('upload/chunk', { batchId, index, offset, name, mime: file.type, data: btoa(binary) }, {
            signal: controller.signal,
          })
        }
      }
      const data = await call('upload/finish', { batchId }, { signal: controller.signal, timeout: 110_000 })
      const uploaded = Array.isArray(data.files)
        ? data.files.filter(file => file !== null && typeof file.url === 'string' && file.url !== '')
        : []
      set({ uploadingImages: false })
      return { ok: true, files: uploaded }
    } catch (error) {
      void call('upload/cancel', { batchId }, { timeout: 5_000 }).catch(() => {})
      set({
        uploadingImages: false,
        error: { code: error.code ?? 'generic', message: error.message },
      })
      return { ok: false }
    }
  }

  /**
   * Recall one of the current account's messages.
   * @param {string} id - message id.
   * @returns {Promise<{ok: boolean}>} whether the Host withdrew the message.
   */
  async function recall(id) {
    if (state.recalling) return { ok: false }
    const clean = String(id)
    if (!/^\d+$/u.test(clean)) return { ok: false }
    if (recallKey.id !== clean) recallKey = { id: clean, requestId: uuid() }
    set({ recalling: true, error: null })
    try {
      await call('recall', { id: clean, requestId: recallKey.requestId }, { signal: controller.signal })
      recallKey = { id: '', requestId: '' }
      set({
        recalling: false,
        messages: state.messages.filter(message => message.id !== clean),
      })
      return { ok: true }
    } catch (error) {
      const code = error.code ?? 'generic'
      if (code === 'http_404' || code === 'not_found') {
        // The message was already withdrawn (for example by another
        // client) but is still in this local window. Drop it instead of
        // surfacing a misleading failure.
        recallKey = { id: '', requestId: '' }
        set({
          recalling: false,
          messages: state.messages.filter(message => message.id !== clean),
          error: null,
        })
        return { ok: true, removed: true }
      }
      set({
        recalling: false,
        error: { code, message: error.message },
      })
      return { ok: false }
    }
  }

  /**
   * @param {string} content - composer text.
   * @returns {Promise<{ok: boolean}>}
   */
  async function send(content) {
    if (!state.loggedIn || state.sending) return { ok: false }
    set({ sending: true, error: null })
    try {
      const data = await call('send', { content, requestId: uuid() }, { signal: controller.signal })
      if (data.message !== null && data.message !== undefined) {
        const message = normalizeMessage(data.message)
        if (message !== undefined) set({ messages: trim(mergeOne(state.messages, message)) })
      }
      set({ sending: false })
      return { ok: true }
    } catch (error) {
      set({ sending: false, error: { code: error.code ?? 'generic', message: error.message } })
      return { ok: false }
    }
  }

  function updatePreferences(patch) {
    preferencesQueue = preferencesQueue.then(async () => {
      try {
        const data = await call('preferences', patch, { signal: controller.signal })
        set({ prefs: data.prefs })
      } catch (error) {
        set({ error: { code: error.code ?? 'generic', message: error.message } })
      }
    })
  }

  /**
   * @param {boolean} visible - whether a chat tab is on screen.
   */
  function setChatVisible(visible) {
    if (visible && state.unread > 0) set({ chatVisible: true, unread: 0 })
    else set({ chatVisible: visible })
  }

  /** Clear the unread count when the window and the chat tab are both visible. */
  function clearUnreadIfVisible() {
    if (state.chatVisible && !document.hidden && document.hasFocus() && state.unread > 0) set({ unread: 0 })
  }

  /** Clear the inline failure banner. */
  function clearError() {
    set({ error: null })
  }

  /**
   * Open one red packet's detail and claim records.
   * @param {string} id - message id.
   * @param {number|null} [gesture] - a gesture picked on the card, preselected in the dialog.
   */
  async function openRedPacket(id, gesture = null) {
    const clean = String(id)
    const seq = ++redPacketSeq
    set({
      redPacketId: clean,
      redPacketGesture: Number.isInteger(gesture) ? gesture : null,
      redPacket: null,
      redPacketError: null,
      redPacketLoading: true,
      redPacketClaim: null,
    })
    try {
      const data = await call('red-packet', { id: clean }, { signal: controller.signal })
      if (state.redPacketId === clean && seq === redPacketSeq) {
        set({ redPacket: data.detail ?? null, redPacketLoading: false })
      }
    } catch (error) {
      if (state.redPacketId === clean && seq === redPacketSeq) {
        set({
          redPacketLoading: false,
          redPacketError: { code: error.code ?? 'generic', message: error.message },
        })
      }
    }
  }

  /** Close the red-packet dialog. */
  function closeRedPacket() {
    set({
      redPacketId: null,
      redPacketGesture: null,
      redPacket: null,
      redPacketError: null,
      redPacketLoading: false,
      redPacketClaiming: false,
      redPacketClaim: null,
    })
  }

  /**
   * Claim the open red packet after the user explicitly accepts any risk.
   * @param {{ gesture?: number, riskAccepted?: boolean }} options - RPS gesture and risk acknowledgement.
   * @returns {Promise<{ok: boolean}>}
   */
  async function claimRedPacket(options = {}, packetId = state.redPacketId) {
    const id = packetId === null || packetId === undefined ? null : String(packetId)
    if (id === null) return { ok: false }
    const dialogOpen = state.redPacketId === id
    set(dialogOpen
      ? { redPacketClaiming: true, redPacketError: null }
      : { redPacketClaiming: true })
    try {
      const data = await call('red-packet/claim', {
        id,
        requestId: uuid(),
        gesture: Number.isInteger(options.gesture) ? options.gesture : undefined,
        riskAccepted: options.riskAccepted === true,
      }, { signal: controller.signal })
      const claimedPacketIds = [...new Set([...state.claimedPacketIds, id])]
      writeClaimed(claimedUserId, claimedPacketIds)
      if (state.redPacketId === id) {
        redPacketSeq += 1
        set({
          redPacketClaiming: false,
          redPacketClaim: data.claim ?? null,
          redPacket: data.detail ?? state.redPacket,
          redPacketLoading: false,
          claimedPacketIds,
        })
      } else {
        set({ redPacketClaiming: false, claimedPacketIds })
      }
      return { ok: true, claim: data.claim ?? null }
    } catch (error) {
      if (state.redPacketId === id) {
        redPacketSeq += 1
        set({
          redPacketClaiming: false,
          redPacketLoading: false,
          redPacketError: { code: error.code ?? 'generic', message: error.message },
        })
      } else {
        set({
          redPacketClaiming: false,
          error: { code: error.code ?? 'generic', message: error.message },
        })
      }
      return { ok: false }
    }
  }

  /** Read the initial state and start the long-poll event loop. */
  async function init(signal) {
    if (started) return
    started = true
    controller = new AbortController()
    signal.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const data = await call('state', {}, { signal: controller.signal })
      applyState(data)
    } catch (error) {
      if (!disposed) set({ loaded: true, error: { code: error.code ?? 'generic', message: error.message } })
    }
    void eventLoop(controller.signal)
  }

  /**
   * @param {AbortSignal} signal - module lifetime.
   */
  async function eventLoop(signal) {
    let failures = 0
    while (!disposed && !signal.aborted) {
      try {
        if (failures > 0 || !state.loaded) {
          applyState(await call('state', {}, { signal }), { reset: true })
        }
        const data = await call('events', { since: state.cursor }, { signal })
        failures = 0
        if (data.reset === true) {
          applyState(await call('state', {}, { signal }), { reset: true })
          continue
        }
        for (const event of data.events ?? []) {
          if (event.seq > state.cursor) applyEvent(event)
        }
        if (Number.isFinite(Number(data.cursor))) {
          set({ cursor: Math.max(state.cursor, Number(data.cursor)) })
        }
      } catch (error) {
        if (disposed || signal.aborted) return
        failures += 1
        await sleep(Math.min(10_000, 1_000 * 2 ** Math.min(failures, 4)), signal)
      }
    }
  }

  /** Stop all requests and stop publishing. */
  function dispose() {
    disposed = true
    controller.abort()
    listeners.clear()
  }

  Object.assign(store, {
    init,
    dispose,
    login,
    logout,
    send,
    recall,
    suggestUsers,
    openUserInfo,
    closeUserInfo,
    loadMedalIcons,
    uploadImages,
    loadOlder,
    loadTopic,
    loadOnline,
    syncAll,
    updatePreferences,
    setChatVisible,
    clearUnreadIfVisible,
    clearError,
    openRedPacket,
    closeRedPacket,
    claimRedPacket,
  })
  return store
}

const LOGO_ASSETS = new Map((LOGO_ANIMATION.assets ?? []).map(asset => [asset.id, asset]))
const LOGO_LAYERS = [...(LOGO_ANIMATION.layers ?? [])].reverse()
const LOGO_WIDTH = Number(LOGO_ANIMATION.w) || 800
const LOGO_HEIGHT = Number(LOGO_ANIMATION.h) || 800
const LOGO_FPS = Number(LOGO_ANIMATION.fr) || 25
const LOGO_FRAMES = Number(LOGO_ANIMATION.op) || 75
/** The site starts this composition at frame 27, where the mark is visible. */
const LOGO_START = 27
const LOGO_SPAN = Math.max(1, LOGO_FRAMES - LOGO_START)

/**
 * Evaluate one Lottie property at a frame. The composition only animates
 * image-layer transforms, so linear interpolation between keyframes is
 * enough to reproduce it without a full Lottie player.
 * @param {object|undefined} property - Lottie property.
 * @param {number} frame - frame in `0..op`.
 * @returns {any} the raw value at that frame.
 */
function lottieValue(property, frame) {
  if (property === undefined || property === null) return undefined
  if (property.a !== 1 || !Array.isArray(property.k)) return property.k
  const keys = property.k
  if (keys.length === 0) return undefined
  if (frame <= keys[0].t) return keys[0].s
  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index]
    const right = keys[index + 1]
    if (frame >= left.t && frame < right.t) {
      const end = left.e ?? right.s
      const ratio = (frame - left.t) / Math.max(1, right.t - left.t)
      if (Array.isArray(left.s) && Array.isArray(end)) {
        return left.s.map((value, item) => value + (end[item] - value) * ratio)
      }
      return left.s + (end - left.s) * ratio
    }
  }
  const last = keys[keys.length - 1]
  return last.e ?? last.s
}

/**
 * The FishPi home-page `#logo-animate` composition, replayed as three
 * positioned image layers. It animates only while mounted, and holds the
 * site's frame 27 for reduced motion.
 * @param {{size?: number}} props - square edge in pixels.
 */
function AnimatedFishPiLogo({ size = 18 }) {
  const layerRefs = useRef([])

  useEffect(() => {
    const images = layerRefs.current
    const unit = size / LOGO_WIDTH
    const apply = frame => {
      LOGO_LAYERS.forEach((layer, index) => {
        const image = images[index]
        if (image === null || image === undefined) return
        const visible = frame >= (layer.ip ?? 0) && frame < (layer.op ?? LOGO_FRAMES)
        const asset = LOGO_ASSETS.get(layer.refId)
        if (!visible || asset === undefined) {
          image.style.opacity = '0'
          return
        }
        const anchor = lottieValue(layer.ks?.a, frame) ?? [0, 0]
        const position = lottieValue(layer.ks?.p, frame) ?? [0, 0]
        const scale = lottieValue(layer.ks?.s, frame) ?? [100, 100]
        const rotation = Number(lottieValue(layer.ks?.r, frame)) || 0
        const opacity = Number(lottieValue(layer.ks?.o, frame)) || 0
        const scaleX = (Number(scale[0]) || 100) / 100 * unit
        const scaleY = (Number(scale[1]) || 100) / 100 * unit
        const anchorX = (Number(anchor[0]) || 0) * scaleX
        const anchorY = (Number(anchor[1]) || 0) * scaleY
        image.style.width = `${asset.w * scaleX}px`
        image.style.height = `${asset.h * scaleY}px`
        image.style.left = `${(Number(position[0]) || 0) * unit - anchorX}px`
        image.style.top = `${(Number(position[1]) || 0) * unit - anchorY}px`
        image.style.transformOrigin = `${anchorX}px ${anchorY}px`
        image.style.transform = `rotate(${rotation}deg)`
        image.style.opacity = String(Math.max(0, Math.min(1, opacity / 100)))
      })
    }

    const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : undefined
    if (media?.matches === true) {
      apply(LOGO_START)
      return undefined
    }
    let frameHandle
    let started
    const tick = now => {
      if (started === undefined) started = now
      apply(LOGO_START + ((now - started) / 1000 * LOGO_FPS) % LOGO_SPAN)
      frameHandle = requestAnimationFrame(tick)
    }
    frameHandle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameHandle)
  }, [size])

  return h('span', {
    'aria-hidden': 'true',
    style: {
      position: 'relative',
      display: 'inline-block',
      flex: 'none',
      width: size,
      height: size,
      pointerEvents: 'none',
      verticalAlign: 'middle',
    },
  }, LOGO_LAYERS.map((layer, index) => {
    const asset = LOGO_ASSETS.get(layer.refId)
    if (asset === undefined) return null
    return h('img', {
      key: `${layer.ind ?? index}`,
      src: asset.p,
      alt: '',
      draggable: false,
      ref: element => { layerRefs.current[index] = element },
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        maxWidth: 'none',
        maxHeight: 'none',
        pointerEvents: 'none',
        userSelect: 'none',
        opacity: 0,
      },
    })
  }))
}

/** @param {object} props - `{size}` from the slot or a direct call. */
/**
 * @param {{url: string, name: string, size?: number}} props - avatar source and fallback initial.
 */
function Avatar({ url, name, size = 28 }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [url])
  if (url === '' || failed) {
    return h('span', {
      className: 'fc-avatar fc-avatar-fallback',
      style: { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)) },
      'aria-hidden': 'true',
    }, (name || '?').slice(0, 1).toUpperCase())
  }
  return h('img', {
    className: 'fc-avatar',
    src: url,
    width: size,
    height: size,
    alt: '',
    loading: 'lazy',
    referrerPolicy: 'no-referrer',
    onError: () => setFailed(true),
  })
}

/** @param {{state: string, t: Function}} props - transport state and copy. */
function StatusDot({ state, t }) {
  const label = state === 'connected' ? t('status.connected') : state === 'connecting' ? t('status.connecting') : t('status.disconnected')
  return h('span', { className: `fc-status fc-status-${state}`, title: label, 'aria-label': label })
}

/**
 * One red-packet card: type, progress, optional explicit confirmation, and
 * a direct claim. A checked confirmation makes a click claim; without it
 * the card opens the detail dialog.
 * @param {{message: object, card: object, t: Function}} props - message, card payload, copy.
 */
function RedPacketCard({ message, card, t }) {
  const store = sharedStore
  const state = useStore()
  const [confirmed, setConfirmed] = useState(false)
  const id = String(message.id)
  const type = typeof card.type === 'string' ? card.type : ''
  const typeLabel = redPacketTypeLabel(t, type)
  const isRps = type === 'rockPaperScissors'
  const risky = type === 'heartbeat' || isRps
  const count = Number(card.count) || 0
  const got = Number(card.got) || 0
  const finished = count > 0 && got >= count
  const claimed = state.claimedPacketIds.includes(id)
  const own = message.author?.id !== undefined
    && String(message.author.id) === (state.user?.id ?? '')
  const ownBlocked = own && type !== 'heartbeat'
  const blocked = claimed || finished || ownBlocked
  const busy = state.redPacketClaiming
  const progress = t('card.redPacketMeta', {
    money: card.money ?? '-',
    got: card.got ?? 0,
    count: card.count ?? '-',
  })

  const claim = async gesture => {
    if (blocked || busy) return
    if (isRps) {
      if (!Number.isInteger(gesture)) {
        void store.openRedPacket(id)
        return
      }
    } else if (!confirmed) {
      void store.openRedPacket(id)
      return
    }
    // Open the result dialog immediately; it shows the claim outcome or
    // failure as soon as the request settles.
    void store.openRedPacket(id, Number.isInteger(gesture) ? gesture : null)
    await store.claimRedPacket({
      riskAccepted: risky,
      gesture: Number.isInteger(gesture) ? gesture : undefined,
    }, id)
  }

  const onCardClick = () => {
    if (blocked) {
      void store.openRedPacket(id)
      return
    }
    void claim(null)
  }

  return h('div', {
    className: `fc-card fc-card-redpacket fc-card-button${blocked ? ' fc-card-blocked' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-label': `${typeLabel}: ${progress}`,
    onClick: onCardClick,
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onCardClick()
      }
    },
  },
    h('div', { className: 'fc-card-title' }, typeLabel),
    typeof card.message === 'string' && card.message !== ''
      ? h('div', { className: 'fc-card-body' }, card.message)
      : null,
    h('div', { className: 'fc-card-meta' }, progress),
    blocked
      ? h('div', { className: 'fc-card-state' },
          claimed
            ? t('redPacket.cardClaimed')
            : ownBlocked
              ? t('redPacket.own')
              : t('redPacket.cardFinished'))
      : h('div', { className: 'fc-card-controls' },
          isRps
            ? h('div', { className: 'fc-gesture-row', role: 'group', 'aria-label': t('redPacket.gesture') },
                [[0, 'redPacket.shortRock', 'redPacket.rock'], [1, 'redPacket.shortScissors', 'redPacket.scissors'], [2, 'redPacket.shortPaper', 'redPacket.paper']].map(([value, shortKey, fullKey]) =>
                  h('button', {
                    key: value,
                    type: 'button',
                    className: 'fc-gesture-button',
                    title: t(fullKey),
                    'aria-label': t(fullKey),
                    disabled: busy,
                    onClick: event => {
                      event.stopPropagation()
                      void claim(value)
                    },
                  }, t(shortKey)),
                ),
              )
            : h('label', { className: 'fc-card-check', onClick: event => event.stopPropagation() },
                h('input', {
                  type: 'checkbox',
                  checked: confirmed,
                  disabled: busy,
                  onChange: event => setConfirmed(event.target.checked),
                }),
                h('span', null, risky ? t('redPacket.confirmRisk') : t('redPacket.confirm')),
              ),
        ),
  )
}

/**
 * @param {{message: object, mode: 'rich'|'plain', t: Function}} props - one message body.
 */
function MessageContent({ message, mode, t, siteUrl, previewable }) {
  if (message.type === 'unavailable') {
    return h('div', { className: 'fc-unavailable' }, t('card.unavailable'))
  }
  if (message.type === 'redPacket') {
    const card = message.card?.redPacket ?? message.card ?? {}
    return h(RedPacketCard, { message, card, t })
  }
  if (mode === 'plain') {
    return h('div', { className: 'fc-plain' }, message.type === 'text'
      ? plainMessage(message, t)
      : messageSummary(message, t))
  }
  if (message.type === 'music') {
    const card = message.card?.music ?? message.card ?? {}
    return h('div', { className: 'fc-card fc-card-music' },
      h('div', { className: 'fc-card-title' }, t('card.music')),
      typeof card.title === 'string' && card.title !== '' ? h('div', { className: 'fc-card-body' }, card.title) : null,
      typeof card.from === 'string' && card.from !== '' ? h('div', { className: 'fc-card-meta' }, card.from) : null,
    )
  }
  if (message.type === 'weather') {
    const card = message.card?.weather ?? message.card ?? {}
    const first = value => typeof value === 'string' ? value.split(',')[0] : ''
    const description = first(card.st)
    const low = first(card.min)
    const high = first(card.max)
    const range = low !== '' && high !== '' ? `${low}~${high}` : ''
    return h('div', { className: 'fc-card fc-card-weather' },
      h('div', { className: 'fc-card-title' }, t('card.weather')),
      h('div', { className: 'fc-card-body' }, [first(card.date), description].filter(Boolean).join(' ')),
      h('div', { className: 'fc-card-meta' }, [range, typeof card.t === 'string' ? card.t : ''].filter(Boolean).join(' · ')),
    )
  }
  if (message.contentHtml !== '') {
    return h('div', {
      className: 'fc-html',
      dangerouslySetInnerHTML: { __html: prepareHtml(message.contentHtml, siteUrl, previewable ? t('image.preview') : '') },
    })
  }
  return h('div', { className: 'fc-plain' }, message.content)
}

/**
 * A run of identical messages, rendered as whole cards where each card
 * overlaps the previous one. The front (latest) card keeps the body and
 * actions; the earlier cards keep their avatar/name header visible.
 * @param {{messages: object[], mode: string, t: Function, siteUrl: string, actions: object|null}} props - the folded run.
 */
function MessageStack({ messages, mode, t, siteUrl, actions, medalIcons }) {
  const offset = 33
  return h('div', { className: 'fc-msg-stack-row' },
    h('div', {
      className: 'fc-msg-stack',
      style: { paddingTop: `${(messages.length - 1) * offset}px` },
    },
      messages.map((message, index) => {
        const front = index === messages.length - 1
        return h('div', {
          key: message.id,
          className: `fc-stack-card${front ? ' fc-stack-card-front' : ''}`,
          style: front
            ? { zIndex: index + 1 }
            : { top: `${index * offset}px`, zIndex: index + 1 },
        },
          h(MessageRow, {
            message,
            own: false,
            grouped: false,
            mode,
            t,
            siteUrl,
            medalIcons: medalIcons[message.author?.userName ?? ''] ?? [],
            actions: front ? actions : null,
            previewable: front,
          }),
        )
      }),
    ),
  )
}

/**
 * @param {{message: object, own: boolean, grouped: boolean, mode: string, t: Function}} props - one row.
 */
function MessageRow({ message, own, grouped, mode, t, siteUrl, medalIcons = [], actions = null, previewable = true }) {
  if (message.type === 'system') {
    return h('div', { className: 'fc-system' }, message.text)
  }
  const author = message.author ?? {}
  const name = displayUser(author)
  const avatarName = author.userNickname || author.userName || ''
  const medals = Array.isArray(message.medals) ? message.medals : []
  const resolvedMedals = medals
    .map(medal => {
      const icon = Array.isArray(medalIcons)
        ? medalIcons.find(entry => (medal.id !== '' && entry.id === medal.id) || (medal.name !== '' && entry.name === medal.name))
        : undefined
      return icon?.url ? { ...medal, url: icon.url } : null
    })
    .filter(Boolean)
  const avatar = h(Avatar, { url: author.userAvatarURL ?? '', name: avatarName })
  return h('div', { className: `fc-msg-line${grouped ? ' fc-grouped' : ''}` },
    h('div', { className: `fc-msg${own ? ' fc-own' : ''}${grouped ? ' fc-grouped' : ''}` },
      grouped
        ? h('span', { className: 'fc-avatar-spacer' })
        : author.userName !== ''
          ? h('button', {
              type: 'button',
              className: 'fc-avatar-button',
              'aria-label': name,
              onClick: () => { void sharedStore.openUserInfo(author.userName) },
            }, avatar)
          : avatar,
      h('div', { className: 'fc-msg-body' },
        grouped
          ? null
          : h('div', { className: 'fc-msg-head' },
              author.userName !== ''
                ? h('button', {
                    type: 'button',
                    className: 'fc-msg-name fc-user-link',
                    onClick: () => { void sharedStore.openUserInfo(author.userName) },
                  }, name)
                : h('span', { className: 'fc-msg-name' }, name),
              resolvedMedals.length > 0
                ? h('span', { className: 'fc-msg-medals' },
                    resolvedMedals.map((medal, index) => h('img', {
                      key: medal.id || medal.name || index,
                      className: 'fc-msg-medal',
                      src: medal.url,
                      alt: medal.name,
                      title: [medal.name, medal.description].filter(Boolean).join(' · '),
                      loading: 'lazy',
                      referrerPolicy: 'no-referrer',
                      onError: event => { event.currentTarget.style.display = 'none' },
                    })),
                  )
                : null,
              h('time', { className: 'fc-msg-time', dateTime: new Date(message.createdAt).toISOString() }, clock(message.createdAt)),
            ),
        h('div', { className: 'fc-msg-content-row' },
          h('div', { className: 'fc-msg-content' }, h(MessageContent, { message, mode, t, siteUrl, previewable })),
          actions,
        ),
      ),
    ),
  )
}

/**
 * @param {{t: Function, compact?: boolean}} props - login form.
 */
function LoginForm({ t, compact = false }) {
  const store = sharedStore
  const state = useStore()
  const id = React.useId()
  const [nameOrEmail, setNameOrEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const promptedMfa = state.mfaRequired || error?.mfaRequired === true

  const submit = async () => {
    if (busy || !nameOrEmail || !password) return
    setBusy(true)
    setError(null)
    const result = await store.login({ nameOrEmail, password, mfaCode, remember })
    setBusy(false)
    if (result.ok) {
      setPassword('')
      return
    }
    setError(result)
  }

  return h('form', {
    className: `fc-login${compact ? ' fc-login-compact' : ''}`,
    onSubmit: event => event.preventDefault(),
    onKeyDown: event => {
      if (event.key === 'Enter' && event.target.matches('.fc-input') && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void submit()
      }
    },
  },
    h('div', { className: 'fc-field' },
      h('label', { className: 'fc-label', htmlFor: `${id}-account` }, t('login.account')),
      h('input', {
        id: `${id}-account`,
        className: 'fc-input',
        value: nameOrEmail,
        autoComplete: 'username',
        onChange: event => setNameOrEmail(event.target.value),
      }),
    ),
    h('div', { className: 'fc-field' },
      h('label', { className: 'fc-label', htmlFor: `${id}-password` }, t('login.password')),
      h('input', {
        id: `${id}-password`,
        className: 'fc-input',
        type: 'password',
        value: password,
        autoComplete: 'current-password',
        onChange: event => setPassword(event.target.value),
      }),
    ),
    h('div', { className: 'fc-field' },
      h('label', { className: 'fc-label', htmlFor: `${id}-mfa` }, t('login.mfa')),
      h('input', {
        id: `${id}-mfa`,
        className: 'fc-input',
        value: mfaCode,
        inputMode: 'numeric',
        autoComplete: 'one-time-code',
        placeholder: t('login.mfa'),
        onChange: event => setMfaCode(event.target.value),
      }),
      promptedMfa ? h('p', { className: 'fc-hint' }, t('login.needMfa')) : null,
    ),
    h('label', { className: 'fc-check' },
      h('input', {
        type: 'checkbox',
        checked: remember,
        onChange: event => setRemember(event.target.checked),
      }),
      h('span', null, t('login.remember')),
    ),
    error === null
      ? null
      : h('p', { className: 'fc-error', role: 'alert' }, localizedError(error.code, error.message, t)),
    h('div', { className: 'fc-login-actions' },
      h('button', { className: 'fc-button fc-button-primary', type: 'button', onClick: submit, disabled: busy || nameOrEmail === '' || password === '' },
        busy ? t('login.busy') : t('login.submit'),
      ),
      h('a', {
        className: 'fc-button fc-register',
        href: REGISTER_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, t('login.register')),
    ),
    compact ? null : h('p', { className: 'fc-hint' }, t('login.hint')),
  )
}

/**
 * @param {{t: Function}} props - account card.
 */
function AccountCard({ t }) {
  const store = sharedStore
  const state = useStore()
  const [busy, setBusy] = useState(false)
  if (!state.loggedIn) {
    return h('div', { className: 'fc-panel' },
      h('p', { className: 'fc-hint' }, t('login.hint')),
      h(LoginForm, { t, compact: true }),
    )
  }
  const name = displayUser(state.user)
  const avatarName = state.user?.userNickname || state.user?.userName || ''
  return h('div', { className: 'fc-panel fc-account' },
    h(Avatar, { url: state.user?.userAvatarURL ?? '', name: avatarName, size: 36 }),
    h('div', { className: 'fc-account-body' },
      h('div', { className: 'fc-account-name' }, name),
    ),
    h('button', {
      className: 'fc-button',
      type: 'button',
      disabled: busy,
      onClick: async () => {
        setBusy(true)
        await store.logout()
        setBusy(false)
      },
    }, t('logout')),
  )
}

function SettingsSection({ t, onBack }) {
  const store = sharedStore
  const state = useStore()
  const [notificationError, setNotificationError] = useState(false)
  const supported = typeof Notification !== 'undefined'
  const toggleNotifications = async () => {
    setNotificationError(false)
    if (state.prefs.notifications) {
      store.updatePreferences({ notifications: false })
      return
    }
    if (!supported) {
      setNotificationError(true)
      return
    }
    try {
      let permission = Notification.permission
      if (permission === 'default') permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setNotificationError(true)
        store.updatePreferences({ notifications: false })
        return
      }
      store.updatePreferences({ notifications: true })
    } catch {
      setNotificationError(true)
      store.updatePreferences({ notifications: false })
    }
  }

  return h('div', { className: 'fc-settings' },
    h('header', { className: 'fc-settings-header' },
      h('button', { className: 'fc-icon-button', type: 'button', onClick: onBack, 'aria-label': t('settings.back'), title: t('settings.back') }, '←'),
      h('h1', null, t('settings.title')),
    ),
    state.error === null
      ? null
      : h('div', { className: 'fc-banner', role: 'alert' },
          h('span', null, localizedError(state.error.code, state.error.message, t)),
          h('button', {
            type: 'button',
            className: 'fc-icon-button',
            'aria-label': t('error.dismiss'),
            title: t('error.dismiss'),
            onClick: () => store.clearError(),
          }, '×'),
        ),
    h('section', { className: 'fc-section' },
      h('h2', { className: 'fc-section-title' }, t('settings.account')),
      h(AccountCard, { t }),
    ),
    h('section', { className: 'fc-section' },
      h('h2', { className: 'fc-section-title' }, t('settings.display')),
      h('p', { className: 'fc-hint' }, t('settings.display.hint')),
      h('div', { className: 'fc-segmented', role: 'group', 'aria-label': t('settings.display') },
        h('button', {
          type: 'button',
          className: `fc-segment${state.prefs.mode === 'rich' ? ' fc-segment-active' : ''}`,
          'aria-pressed': state.prefs.mode === 'rich',
          onClick: () => store.updatePreferences({ mode: 'rich' }),
        }, t('settings.display.rich')),
        h('button', {
          type: 'button',
          className: `fc-segment${state.prefs.mode === 'plain' ? ' fc-segment-active' : ''}`,
          'aria-pressed': state.prefs.mode === 'plain',
          onClick: () => store.updatePreferences({ mode: 'plain' }),
        }, t('settings.display.plain')),
      ),
    ),
    h('section', { className: 'fc-section' },
      h('div', { className: 'fc-row' },
        h('div', { className: 'fc-row-body' },
          h('div', { className: 'fc-row-title' }, t('settings.notifications')),
          h('div', { className: 'fc-hint' }, t('settings.notifications.hint')),
        ),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': state.prefs.notifications,
          'aria-label': t('settings.notifications'),
          className: `fc-switch${state.prefs.notifications ? ' fc-switch-on' : ''}`,
          onClick: () => { void toggleNotifications() },
        }, h('span', { className: 'fc-switch-thumb' })),
      ),
      notificationError
        ? h('p', { className: 'fc-error', role: 'alert' }, supported ? t('settings.notifications.denied') : t('settings.notifications.unsupported'))
        : null,
    ),
    h('p', { className: 'fc-hint' }, t('settings.version', { version })),
  )
}

/**
 * A visible fallback for a render failure in the tab body, so a crash is
 * never an empty pane and the message can be reported without DevTools.
 */
class ChatBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[fishpi-chat] chat panel crashed', error, info)
  }

  render() {
    if (this.state.error !== null) {
      const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
      const title = typeof this.props.t === 'function' ? this.props.t('error.crash') : 'FishPi chat error'
      return h('div', { className: 'fc-crash' }, `${title}: ${message}`)
    }
    return this.props.children
  }
}

/**
 * @param {Function} t - bound translate.
 * @param {string} type - red-packet type id.
 * @returns {string} the localized type label.
 */
function redPacketTypeLabel(t, type) {
  const key = `redPacket.type.${type}`
  const label = t(key)
  return label === key ? t('redPacket.title') : label
}

/**
 * @param {unknown} value - millisecond timestamp or a preformatted legacy string.
 * @returns {string} display text.
 */
function claimTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return new Date(value).toLocaleString()
    } catch {
      return ''
    }
  }
  return typeof value === 'string' ? value : ''
}

/**
 * @param {object} detail - red-packet detail from the Host.
 * @returns {Array<{user: object, amount: number, time: unknown, gesture?: number, outcome?: string}>}
 */
function redPacketClaims(detail) {
  if (Array.isArray(detail?.claims)) {
    return detail.claims.map(entry => ({
      user: entry?.user ?? {},
      amount: Number(entry?.amount) || 0,
      time: entry?.claimedAt,
      gesture: entry?.gesture,
      outcome: entry?.outcome,
    }))
  }
  if (Array.isArray(detail?.who)) {
    return detail.who.map(entry => ({
      user: { userName: entry?.userName ?? '', userAvatarURL: entry?.avatar ?? '' },
      amount: Number(entry?.userMoney) || 0,
      time: entry?.time,
    }))
  }
  return []
}

/** Public user profile, with medal icons only. */
function UserInfoDialog({ t }) {
  const store = sharedStore
  const state = useStore()
  const name = state.userInfoName
  const profile = state.userInfo

  useEffect(() => {
    if (name === null) return undefined
    const onKey = event => {
      if (event.key === 'Escape') store.closeUserInfo()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [name, store])

  if (name === null) return null

  const error = state.userInfoError
  const medals = Array.isArray(state.userInfoMedals) ? state.userInfoMedals : []
  const identity = profile === null
    ? []
    : [
        profile.userNo === '' ? '' : t('user.number', { number: profile.userNo }),
        profile.userCity === '' ? '' : t('user.location', { city: profile.userCity }),
      ].filter(Boolean)
  const stats = profile === null
    ? []
    : [
        profile.userPoint === undefined ? '' : t('user.points', { points: profile.userPoint }),
        profile.onlineMinute === undefined ? '' : t('user.online', { minutes: profile.onlineMinute }),
      ].filter(Boolean)
  const memberUrl = profile === null
    ? ''
    : `${state.siteUrl.replace(/\/+$/u, '')}/member/${encodeURIComponent(profile.userName || name)}`

  return h('div', {
    className: 'fc-modal-mask',
    role: 'presentation',
    onClick: () => store.closeUserInfo(),
  },
    h('div', {
      className: 'fc-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('user.title'),
      onClick: event => event.stopPropagation(),
    },
      h('div', { className: 'fc-modal-head' },
        h('div', { className: 'fc-modal-title' }, t('user.title')),
        h('button', {
          type: 'button',
          className: 'fc-icon-button',
          'aria-label': t('user.close'),
          title: t('user.close'),
          onClick: () => store.closeUserInfo(),
        }, '×'),
      ),
      state.userInfoLoading && profile === null
        ? h('p', { className: 'fc-hint' }, t('loading'))
        : null,
      error === null
        ? null
        : h('div', { className: 'fc-banner', role: 'alert' },
            h('span', null, localizedError(error.code, error.message, t)),
            h('button', {
              type: 'button',
              className: 'fc-icon-button',
              'aria-label': t('redPacket.retry'),
              title: t('redPacket.retry'),
              onClick: () => { void store.openUserInfo(name) },
            }, '⟳'),
          ),
      profile === null
        ? null
        : h('div', { className: 'fc-user-body' },
            h('div', { className: 'fc-user-head' },
              h(Avatar, {
                url: profile.userAvatarURL ?? '',
                name: profile.userNickname || profile.userName || '',
                size: 56,
              }),
              h('div', { className: 'fc-user-heading' },
                h('div', { className: 'fc-user-name-line' },
                  h('div', { className: 'fc-user-name' }, displayUser(profile)),
                  h('a', {
                    className: 'fc-user-home-link',
                    href: memberUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, t('user.home')),
                ),
                profile.userRole !== ''
                  ? h('div', { className: 'fc-user-role' }, profile.userRole)
                  : null,
                identity.length > 0
                  ? h('div', { className: 'fc-user-meta' }, identity.join(' · '))
                  : null,
                stats.length > 0
                  ? h('div', { className: 'fc-user-meta' }, stats.join(' · '))
                  : null,
              ),
            ),
            profile.userIntro !== ''
              ? h('div', { className: 'fc-user-intro' }, profile.userIntro)
              : null,
            profile.userURL !== ''
              ? h('div', { className: 'fc-user-links' },
                  h('a', {
                    className: 'fc-user-profile-link',
                    href: profile.userURL,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, t('user.profileLink')),
                )
              : null,
            medals.length > 0
              ? h('div', { className: 'fc-user-medals-section' },
                  h('div', { className: 'fc-modal-section-title' }, t('user.medals')),
                  h('div', { className: 'fc-user-medals' },
                    medals.map(medal => h('div', { className: 'fc-medal-row', key: medal.id || medal.name || medal.url },
                      h('img', {
                        className: 'fc-medal-icon',
                        src: medal.url,
                        alt: medal.name,
                        title: [medal.name, medal.description].filter(Boolean).join(' · '),
                        loading: 'lazy',
                        referrerPolicy: 'no-referrer',
                        onError: event => { event.currentTarget.style.display = 'none' },
                      }),
                      h('div', { className: 'fc-medal-text' },
                        h('div', { className: 'fc-medal-name' }, medal.name),
                        medal.description !== ''
                          ? h('div', { className: 'fc-medal-meta' }, medal.description)
                          : null,
                      ),
                    )),
                  ),
                )
              : null,
          ),
    ),
  )
}

/** Red-packet detail and claim dialog. */
function RedPacketDialog({ t }) {
  const store = sharedStore
  const state = useStore()
  const id = state.redPacketId
  const [riskAccepted, setRiskAccepted] = useState(false)
  const [gesture, setGesture] = useState(null)

  useEffect(() => {
    setRiskAccepted(false)
    const initial = sharedStore.getSnapshot().redPacketGesture
    setGesture(Number.isInteger(initial) ? initial : null)
  }, [id])

  useEffect(() => {
    if (id === null) return undefined
    const onKey = event => {
      if (event.key === 'Escape') store.closeRedPacket()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [id, store])

  if (id === null) return null

  const detail = state.redPacket
  const error = state.redPacketError
  const claim = state.redPacketClaim
  const myClaim = detail?.currentUserClaim ?? claim
  const type = typeof detail?.type === 'string' ? detail.type : ''
  const isRps = type === 'rockPaperScissors'
  const risky = type === 'heartbeat' || isRps
  const needsRiskCheck = type === 'heartbeat'
  const count = Number(detail?.count) || 0
  const got = Number(detail?.got) || 0
  const finished = detail !== null && count > 0 && got >= count
  const claims = detail === null ? [] : redPacketClaims(detail)
  const own = detail?.sender?.id !== undefined
    && String(detail.sender.id) === (state.user?.id ?? '')
  const canClaim = detail !== null
    && detail.legacy !== true
    && !finished
    && myClaim === null
    && !state.redPacketClaiming
    && !(own && type !== 'heartbeat')
    && (!needsRiskCheck || riskAccepted)
    && (!isRps || gesture !== null)

  const amountText = value => {
    const amount = Number(value) || 0
    return amount > 0 ? `+${amount}` : String(amount)
  }

  const submit = async () => {
    if (!canClaim) return
    await store.claimRedPacket({
      riskAccepted: isRps ? true : riskAccepted,
      gesture: isRps && gesture !== null ? gesture : undefined,
    })
  }

  const close = h('button', {
    type: 'button',
    className: 'fc-icon-button',
    'aria-label': t('redPacket.close'),
    title: t('redPacket.close'),
    onClick: () => store.closeRedPacket(),
  }, '×')

  const dialogTitle = detail === null ? t('redPacket.title') : redPacketTypeLabel(t, detail.type)
  const header = h('div', { className: 'fc-modal-head' },
    h('div', { className: 'fc-modal-title' }, dialogTitle),
    close,
  )

  const claimRows = claims.length === 0
    ? h('p', { className: 'fc-hint' }, t('redPacket.noClaims'))
    : h('div', { className: 'fc-claims' }, claims.map((entry, index) => {
        const name = displayUser(entry.user)
        const avatarName = entry.user?.userNickname || entry.user?.userName || ''
        return h('div', { className: 'fc-claim-row', key: `${index}-${name}` },
          entry.user?.userName
            ? h('button', {
                type: 'button',
                className: 'fc-avatar-button',
                'aria-label': name,
                onClick: () => { void sharedStore.openUserInfo(entry.user.userName) },
              }, h(Avatar, { url: entry.user?.userAvatarURL ?? '', name: avatarName, size: 22 }))
            : h(Avatar, { url: entry.user?.userAvatarURL ?? '', name: avatarName, size: 22 }),
          entry.user?.userName
            ? h('button', {
                type: 'button',
                className: 'fc-claim-name fc-user-link',
                onClick: () => { void sharedStore.openUserInfo(entry.user.userName) },
              }, name)
            : h('span', { className: 'fc-claim-name' }, name),
          entry.outcome === undefined ? null : h('span', { className: 'fc-claim-outcome' }, t(`redPacket.outcome.${entry.outcome}`)),
          h('span', { className: `fc-claim-amount${entry.amount < 0 ? ' fc-claim-negative' : ''}` }, amountText(entry.amount)),
          h('span', { className: 'fc-claim-time' }, claimTime(entry.time)),
        )
      }))

  let footer = null
  if (detail !== null && detail.legacy === true) {
    footer = h('p', { className: 'fc-hint' }, t('redPacket.legacy'))
  } else if (myClaim !== null && myClaim !== undefined) {
    // The claims list already carries this account's amount; keep the
    // detail neutral instead of repeating a personal ledger line.
    footer = null
  } else if (finished) {
    footer = h('p', { className: 'fc-hint' }, t('redPacket.finished'))
  } else if (own && type !== 'heartbeat') {
    footer = h('p', { className: 'fc-hint' }, t('redPacket.own'))
  } else if (detail !== null) {
    footer = h('div', { className: 'fc-claim-actions' },
      risky
        ? h('p', { className: 'fc-modal-warning' }, isRps ? t('redPacket.riskRps') : t('redPacket.riskHeartbeat'))
        : null,
      needsRiskCheck
        ? h('label', { className: 'fc-check' },
            h('input', {
              type: 'checkbox',
              checked: riskAccepted,
              onChange: event => setRiskAccepted(event.target.checked),
            }),
            h('span', null, t('redPacket.riskAccept')),
          )
        : null,
      isRps
        ? h('div', { className: 'fc-gestures', role: 'group', 'aria-label': t('redPacket.gesture') },
            [[0, 'redPacket.shortRock', 'redPacket.rock'], [1, 'redPacket.shortScissors', 'redPacket.scissors'], [2, 'redPacket.shortPaper', 'redPacket.paper']].map(([value, shortKey, fullKey]) =>
              h('button', {
                key: value,
                type: 'button',
                className: `fc-segment${gesture === value ? ' fc-segment-active' : ''}`,
                'aria-pressed': gesture === value,
                title: t(fullKey),
                'aria-label': t(fullKey),
                onClick: () => setGesture(value),
              }, t(shortKey)),
            ),
          )
        : null,
      h('button', {
        type: 'button',
        className: 'fc-button fc-button-primary',
        disabled: !canClaim,
        onClick: () => { void submit() },
      }, state.redPacketClaiming ? t('redPacket.claiming') : t('redPacket.claim')),
    )
  }

  return h('div', {
    className: 'fc-modal-mask',
    role: 'presentation',
    onClick: () => store.closeRedPacket(),
  },
    h('div', {
      className: 'fc-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': dialogTitle,
      onClick: event => event.stopPropagation(),
    },
      header,
      state.redPacketLoading && detail === null
        ? h('p', { className: 'fc-hint' }, t('loading'))
        : null,
      error === null
        ? null
        : h('div', { className: 'fc-banner', role: 'alert' },
            h('span', null, localizedError(error.code, error.message, t)),
            h('button', {
              type: 'button',
              className: 'fc-icon-button',
              'aria-label': t('redPacket.retry'),
              title: t('redPacket.retry'),
              onClick: () => { void store.openRedPacket(id) },
            }, '⟳'),
          ),
      detail === null
        ? null
        : h('div', { className: 'fc-modal-body' },
            h('div', { className: 'fc-card-meta' },
              redPacketTypeLabel(t, type),
              detail.sender !== null && detail.sender !== undefined
                ? ' · '
                : '',
              detail.sender?.userName
                ? h('button', {
                    type: 'button',
                    className: 'fc-user-link',
                    onClick: () => { void sharedStore.openUserInfo(detail.sender.userName) },
                  }, t('redPacket.from', { name: displayUser(detail.sender) }))
                : detail.sender !== null && detail.sender !== undefined
                  ? t('redPacket.from', { name: displayUser(detail.sender) })
                  : null,
            ),
            typeof detail.message === 'string' && detail.message !== ''
              ? h('div', { className: 'fc-modal-message' }, detail.message)
              : null,
            h('div', { className: 'fc-redpacket-progress' },
              h('span', { style: { width: count > 0 ? `${Math.min(100, got / count * 100)}%` : '0%' } }),
            ),
            h('div', { className: 'fc-card-meta' }, [
              t('redPacket.progress', { got, count }),
              detail.poolPoints === undefined ? '' : t('redPacket.pool', { points: detail.poolPoints }),
            ].filter(Boolean).join(' · ')),
            h('div', { className: 'fc-modal-section-title' }, t('redPacket.claims')),
            claimRows,
          ),
      footer,
    ),
  )
}

function ChatPanel({ visible, t, onSettings }) {
  const store = sharedStore
  const state = useStore()
  const mode = state.prefs.mode
  const [draft, setDraft] = useState('')
  const [quotes, setQuotes] = useState([])
  const [atBottom, setAtBottom] = useState(true)
  const [mention, setMention] = useState({ open: false, items: [], index: 0, start: 0, end: 0, query: '' })
  const mentionTimerRef = useRef()
  const mentionSeqRef = useRef(0)
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const stickRef = useRef(true)
  const restoreRef = useRef(null)
  const recallTimerRef = useRef()
  const [recallingId, setRecallingId] = useState('')
  const [imagePreview, setImagePreview] = useState(null)

  const openImagePreview = async event => {
    const gallery = imagePreviewFromEvent(event)
    if (gallery === null) return
    if (!await bridge.openGallery(gallery, t('image.preview')) && gallery.trigger.isConnected) setImagePreview(gallery)
  }

  useEffect(() => {
    if (!visible || !state.loggedIn || mode !== 'rich') setImagePreview(null)
  }, [visible, state.loggedIn, mode])

  useEffect(() => {
    store.setChatVisible(visible)
    return () => { store.setChatVisible(false) }
  }, [visible])

  useEffect(() => () => { clearTimeout(recallTimerRef.current) }, [])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    if (restoreRef.current !== null) {
      const { height, top } = restoreRef.current
      restoreRef.current = null
      element.scrollTop = top + (element.scrollHeight - height)
      return
    }
    if (stickRef.current) element.scrollTop = element.scrollHeight
  }, [state.messages])

  useEffect(() => {
    void store.loadMedalIcons(state.messages)
  }, [state.messages])

  useEffect(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (element === null) return
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    stickRef.current = near
    setAtBottom(near)
  }, [])

  const loadOlder = async () => {
    const element = scrollRef.current
    if (element !== null) restoreRef.current = { height: element.scrollHeight, top: element.scrollTop }
    const added = await store.loadOlder()
    if (added === 0) restoreRef.current = null
  }

  const content = [draft.trim(), ...quotes.map(quote => quote.markdown)].filter(Boolean).join('\n\n')

  const doSend = async () => {
    if (content === '' || state.sending) return
    stickRef.current = true
    const result = await store.send(content)
    if (result.ok) {
      setDraft(current => current === draft ? '' : current)
      setQuotes(current => current.filter(quote => !quotes.includes(quote)))
    }
  }

  const onKeyDown = event => {
    if (event.isComposing === true || event.nativeEvent?.isComposing === true) return
    if (mention.open) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMention()
        return
      }
      if (mention.items.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const direction = event.key === 'ArrowDown' ? 1 : -1
          setMention(current => ({
            ...current,
            index: (current.index + direction + current.items.length) % current.items.length,
          }))
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          selectMention(mention.items[mention.index] ?? mention.items[0])
          return
        }
      }
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing === true || event.nativeEvent?.isComposing === true) return
    event.preventDefault()
    void doSend()
  }

  const appendFiles = async files => {
    const images = [...files].filter(file => file !== null
      && typeof file === 'object'
      && typeof file.type === 'string'
      && file.type.startsWith('image/'))
    if (images.length === 0 || state.uploadingImages) return
    const result = await store.uploadImages(images)
    if (!result.ok || !Array.isArray(result.files) || result.files.length === 0) return
    const markdown = result.files
      .map(file => `![image](${file.url})`)
      .join('\n')
    setDraft(current => {
      const existing = current.replace(/\s+$/u, '')
      return existing === '' ? markdown : `${existing}\n${markdown}`
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const onPaste = event => {
    const files = [...(event.clipboardData?.files ?? [])]
      .filter(file => file.type.startsWith('image/'))
    if (files.length === 0) {
      for (const item of event.clipboardData?.items ?? []) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (file !== null) files.push(file)
      }
    }
    if (files.length === 0) return
    event.preventDefault()
    void appendFiles(files)
  }

  const closeMention = () => {
    clearTimeout(mentionTimerRef.current)
    setMention(current => current.open || current.items.length > 0
      ? { open: false, items: [], index: 0, start: 0, end: 0, query: '' }
      : current)
  }

  const updateMention = (value, cursor) => {
    const before = value.slice(0, cursor)
    const match = /(^|[^\w-])@([A-Za-z0-9_-]{0,64})$/u.exec(before)
    if (match === null) {
      closeMention()
      return
    }
    const query = match[2]
    const start = cursor - query.length - 1
    if (query === '') {
      clearTimeout(mentionTimerRef.current)
      mentionSeqRef.current += 1
      setMention({
        open: true,
        items: state.onlineUsers.slice(0, 8),
        index: 0,
        start,
        end: cursor,
        query,
      })
      return
    }
    const lowered = query.toLowerCase()
    const localMatches = state.onlineUsers.filter(user => (
      typeof user.userName === 'string' && user.userName.toLowerCase().includes(lowered)
    ) || (
      typeof user.userNickname === 'string' && user.userNickname.toLowerCase().includes(lowered)
    )).slice(0, 8)
    setMention(current => ({
      open: true,
      items: current.query === query ? current.items : localMatches,
      index: 0,
      start,
      end: cursor,
      query,
    }))
    clearTimeout(mentionTimerRef.current)
    const seq = ++mentionSeqRef.current
    mentionTimerRef.current = setTimeout(async () => {
      const items = await store.suggestUsers(query)
      if (seq !== mentionSeqRef.current) return
      const seen = new Set()
      const merged = [...localMatches, ...items].filter(user => {
        const key = `${user.id ?? ''}:${(user.userName ?? '').toLowerCase()}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 8)
      setMention(current => current.open && current.query === query
        ? { ...current, items: merged, index: 0 }
        : current)
    }, 180)
  }

  const selectMention = user => {
    const userName = typeof user?.userName === 'string' ? user.userName : ''
    if (userName === '') {
      closeMention()
      return
    }
    const inserted = `@${userName} `
    const next = draft.slice(0, mention.start) + inserted + draft.slice(mention.end)
    setDraft(next)
    closeMention()
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (element === null) return
      element.focus()
      const position = mention.start + inserted.length
      element.setSelectionRange(position, position)
    })
  }

  const insertDraft = text => {
    const element = textareaRef.current
    const start = element?.selectionStart ?? draft.length
    const end = element?.selectionEnd ?? draft.length
    const next = draft.slice(0, start) + text + draft.slice(end)
    setDraft(next)
    requestAnimationFrame(() => {
      const target = textareaRef.current
      if (target === null) return
      target.focus()
      const position = start + text.length
      target.setSelectionRange(position, position)
      updateMention(next, position)
    })
  }

  /** @param {object} message - one normalized message. @returns {string} source text for a quote. */
  const quoteSource = message => {
    let source = ''
    if (message.type === 'text') {
      source = typeof message.content === 'string' ? message.content : ''
      if (source.trim() === '' && typeof message.contentHtml === 'string') source = plainFromHtml(message.contentHtml)
    }
    if (source.trim() === '') source = messageSummary(message, t)
    source = source.replace(/\r\n/gu, '\n').trimEnd()
    return source.length > 1000 ? `${source.slice(0, 1000)}…` : source
  }

  /** @param {object} message - one normalized message. */
  const quoteMessage = message => {
    const source = quoteSource(message)
    if (source === '') return
    const author = message.author?.userName ?? ''
    const site = state.siteUrl.replace(/\/+$/u, '')
    const link = `${site}/cr#chatroom${message.id}`
    const attribution = author !== ''
      ? `##### 引用 @${author} [↩](${link} "跳转至原消息")`
      : `##### 引用 [↩](${link} "跳转至原消息")`
    const quoted = source.split('\n').map(line => `> ${line}`).join('\n')
    setQuotes(current => [...current, { markdown: `${attribution}  \n${quoted}`, summary: messageSummary(message, t) }])
    closeMention()
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (element === null) return
      element.focus()
      const position = element.value.length
      element.setSelectionRange(position, position)
    })
  }

  /** @param {object} message - one normalized message. */
  const mentionAuthor = message => {
    const userName = message.author?.userName ?? ''
    if (userName !== '') insertDraft(`@${userName} `)
  }

  /** @param {object} message - one normalized text message. */
  const repeatMessage = message => {
    if (state.sending) return
    const content = typeof message.content === 'string' ? message.content : ''
    if (message.type !== 'text' || content.trim() === '') return
    void store.send(content)
  }

  /** @param {object} message - one normalized message. */
  const requestRecall = message => {
    if (state.recalling) return
    if (recallingId !== message.id) {
      clearTimeout(recallTimerRef.current)
      setRecallingId(message.id)
      recallTimerRef.current = window.setTimeout(() => setRecallingId(''), 4000)
      return
    }
    clearTimeout(recallTimerRef.current)
    recallTimerRef.current = undefined
    setRecallingId('')
    void store.recall(message.id)
  }

  /** @param {object} message - one normalized message. @returns {object|null} its hover actions. */
  const messageActions = message => {
    if (message.type === 'system') return null
    const author = message.author ?? {}
    const own = author.id !== undefined && author.id !== '' && author.id === state.user?.id
    const canQuote = quoteSource(message) !== ''
    const canModerate = state.user?.capabilities?.chatRevokeOthers === true
    const canRecall = (own || canModerate)
      && message.type !== 'redPacket'
      && /^\d+$/u.test(message.id)
    const canMention = typeof author.userName === 'string' && author.userName !== '' && !own
    const canRepeat = message.type === 'text' && typeof message.content === 'string' && message.content.trim() !== ''
    if (!canQuote && !canRecall && !canMention && !canRepeat) return null
    const pending = recallingId === message.id
    return h('div', { className: 'fc-msg-actions', role: 'toolbar', 'aria-label': t('message.actions') },
      canQuote
        ? h('button', {
            type: 'button',
            className: 'fc-msg-action',
            title: t('message.quote'),
            'aria-label': t('message.quote'),
            onClick: () => quoteMessage(message),
          }, t('message.quoteShort'))
        : null,
      canRecall
        ? h('button', {
            type: 'button',
            className: `fc-msg-action fc-msg-action-danger${pending ? ' fc-msg-action-pending' : ''}`,
            disabled: state.recalling,
            title: pending
              ? t('message.recallConfirm')
              : (own ? t('message.recall') : t('message.recallModerate')),
            'aria-label': pending
              ? t('message.recallConfirm')
              : (own ? t('message.recall') : t('message.recallModerate')),
            onClick: () => requestRecall(message),
          }, pending ? t('message.recallConfirmShort') : t('message.recallShort'))
        : null,
      canMention
        ? h('button', {
            type: 'button',
            className: 'fc-msg-action',
            title: t('message.mention'),
            'aria-label': t('message.mention'),
            onClick: () => mentionAuthor(message),
          }, t('message.mentionShort'))
        : null,
      canRepeat
        ? h('button', {
            type: 'button',
            className: 'fc-msg-action',
            title: t('message.repeat'),
            'aria-label': t('message.repeat'),
            onClick: () => repeatMessage(message),
          }, t('message.repeatShort'))
        : null,
    )
  }

  const retry = async () => {
    store.clearError()
    await store.syncAll()
  }

  const header = h('div', { className: 'fc-header' },
    h('div', { className: 'fc-header-main' },
      h(AnimatedFishPiLogo, { size: 19 }),
      h('span', { className: 'fc-title' }, t('tabTitle')),
      h(StatusDot, { state: state.connection, t }),
      state.connection === 'connected'
        ? null
        : h('span', { className: 'fc-status-text' }, state.connection === 'connecting' ? t('status.connecting') : t('status.disconnected')),
      state.loggedIn && state.user?.userName
        ? h('button', {
            type: 'button',
            className: 'fc-meta fc-user-link',
            onClick: () => { void store.openUserInfo(state.user.userName) },
          }, displayUser(state.user))
        : state.loggedIn
          ? h('span', { className: 'fc-meta' }, displayUser(state.user))
          : null,
    ),
    h('div', { className: 'fc-header-actions' },
      state.unread > 0
        ? h('span', { className: 'fc-unread', title: t('unread', { count: state.unread }) }, state.unread)
        : null,
      state.loggedIn ? h('span', { className: 'fc-meta' }, t('online', { count: state.online })) : null,
      h('button', {
        type: 'button',
        className: 'fc-icon-button',
        title: t('settings.open'),
        'aria-label': t('settings.open'),
        onClick: onSettings,
      }, '⚙'),
      state.loggedIn
        ? h('button', {
            type: 'button',
            className: 'fc-icon-button',
            title: t('refresh'),
            'aria-label': t('refresh'),
            onClick: () => { void retry() },
          }, h('span', { 'aria-hidden': 'true' }, '⟳'))
        : null,
    ),
    state.topic !== ''
      ? h('div', { className: 'fc-topic', title: state.topic }, `${t('topic')}: ${state.topic}`)
      : null,
  )

  const errorBanner = state.error === null
    ? null
    : h('div', { className: 'fc-banner', role: 'alert' },
        h('span', null, localizedError(state.error.code, state.error.message, t)),
        h('button', {
          type: 'button',
          className: 'fc-icon-button',
          'aria-label': t('error.dismiss'),
          title: t('error.dismiss'),
          onClick: () => store.clearError(),
        }, '×'),
      )

  if (!state.loaded) {
    return h('div', { className: 'fc-root' },
      header, h('div', { className: 'fc-empty' }, t('loading')),
      h(RedPacketDialog, { t }), h(UserInfoDialog, { t }))
  }

  if (!state.loggedIn) {
    return h('div', { className: 'fc-root' },
        header,
      errorBanner,
      h('div', { className: 'fc-login-wrap' },
        h('div', { className: 'fc-login-title' }, t('login.title')),
        h(LoginForm, { t, compact: true }),
      ),
      h(RedPacketDialog, { t }),
      h(UserInfoDialog, { t }),
    )
  }

  // Fold a run of identical text messages into a stack of whole message
  // cards: each card keeps its own avatar/name header and body, and every
  // later card overlaps the previous one. The stack lives only in this
  // render; nothing is persisted or sent.
  const runs = []
  let last = null
  for (const message of state.messages) {
    const repeat = message.type === 'text'
      && typeof message.content === 'string'
      && message.content.trim() !== ''
      && last !== null
      && last.type === 'text'
      && typeof last.content === 'string'
      && last.content === message.content
      && dayKey(last.createdAt) === dayKey(message.createdAt)
    if (repeat && runs.length > 0) runs[runs.length - 1].push(message)
    else runs.push([message])
    last = message
  }
  const display = runs.map(run => ({
    message: run[0],
    stack: { count: run.length, messages: run },
  }))

  let previous = null
  const rows = []
  for (const entry of display) {
    const message = entry.message
    const authorId = message.author?.id ?? ''
    const authorName = message.author?.userName ?? ''
    const dateChanged = previous === null || dayKey(message.createdAt) !== dayKey(previous.message.createdAt)
    if (dateChanged) rows.push(h('div', { className: 'fc-day', key: `day-${message.id}` }, dayLabel(message.createdAt, t)))
    const stacked = entry.stack.messages.length > 1
    const front = entry.stack.messages[entry.stack.messages.length - 1] ?? message
    const grouped = !stacked
      && !dateChanged
      && previous !== null
      && previous.stack.count === 1
      && message.type === 'text'
      && previous.message.type === 'text'
      && authorId !== ''
      && authorId === (previous.message.author?.id ?? '')
      && message.createdAt - previous.message.createdAt < 5 * 60 * 1000
    if (stacked) {
      rows.push(h(MessageStack, {
        key: message.id,
        messages: entry.stack.messages,
        mode,
        t,
        siteUrl: state.siteUrl,
        medalIcons: state.medalIcons,
        actions: messageActions(front),
      }))
    } else {
      rows.push(h(MessageRow, {
        key: message.id,
        message,
        own: authorId !== '' && authorId === state.user?.id,
        grouped,
        mode,
        t,
        siteUrl: state.siteUrl,
        medalIcons: authorName !== '' ? state.medalIcons[authorName] ?? [] : [],
        actions: messageActions(message),
      }))
    }
    previous = entry
  }

  const body = state.loadingMessages && state.messages.length === 0
    ? h('div', { className: 'fc-empty' }, t('loading'))
    : state.messages.length === 0
      ? h('div', { className: 'fc-empty' }, t('empty'))
      : h('div', {
          className: 'fc-list', ref: scrollRef, onScroll, role: 'log', 'aria-label': t('messages'),
          onClick: openImagePreview, onKeyDown: openImagePreview,
        },
          state.hasMore
            ? h('button', {
                type: 'button',
                className: 'fc-load-older',
                disabled: state.loadingOlder,
                onClick: () => { void loadOlder() },
              }, state.loadingOlder ? t('loading') : t('loadOlder'))
            : null,
          rows,
        )

  return h('div', { className: 'fc-root' },
    header,
    errorBanner,
    body,
    state.messages.length > 0 && !atBottom
      ? h('button', {
          type: 'button',
          className: 'fc-jump',
          'aria-label': t('jump'),
          title: t('jump'),
          onClick: () => {
            stickRef.current = true
            setAtBottom(true)
            const element = scrollRef.current
            if (element !== null) element.scrollTop = element.scrollHeight
          },
        }, '↓')
      : null,
    h('div', { className: 'fc-composer' },
      mention.open
        ? h('div', {
            className: 'fc-mention-popover',
            id: 'fc-mention-list',
            role: 'listbox',
            'aria-label': t('mention.title'),
          },
            mention.items.length === 0
              ? h('div', { className: 'fc-mention-empty' }, mention.query === '' ? t('mention.hint') : t('mention.empty'))
              : mention.items.map((user, index) => h('button', {
                  key: `${user.id || user.userName || index}-${index}`,
                  type: 'button',
                  role: 'option',
                  tabIndex: -1,
                  'aria-selected': index === mention.index,
                  className: 'fc-mention-option',
                  onMouseDown: event => event.preventDefault(),
                  onClick: () => selectMention(user),
                },
                  h(Avatar, {
                    url: user.userAvatarURL ?? '',
                    name: user.userNickname || user.userName || '',
                    size: 22,
                  }),
                  h('span', { className: 'fc-mention-name' }, displayUser(user)),
                )),
          )
        : null,
      h('div', { className: 'fc-composer-row' },
        h('button', {
          type: 'button',
          className: 'fc-plus',
          title: t('composer.addImage'),
          'aria-label': t('composer.addImage'),
          disabled: state.uploadingImages,
          onClick: () => fileInputRef.current?.click(),
        }, '+'),
        h('textarea', {
          ref: textareaRef,
          className: 'fc-textarea',
          rows: 1,
          value: draft,
          'aria-label': t('composer.label'),
          'aria-autocomplete': 'list',
          'aria-expanded': mention.open,
          'aria-controls': mention.open ? 'fc-mention-list' : undefined,
          placeholder: t('composer.placeholder'),
          onChange: event => {
            const value = event.target.value
            setDraft(value)
            updateMention(value, event.target.selectionStart ?? value.length)
          },
          onKeyDown,
          onPaste,
          onBlur: () => { window.setTimeout(() => closeMention(), 120) },
          maxLength: 4096,
        }),
        h('button', {
          type: 'button',
          className: 'fc-button fc-button-primary fc-send',
          disabled: content === '' || state.sending || state.uploadingImages,
          onClick: () => { void doSend() },
        }, state.sending ? t('composer.sending') : t('composer.send')),
      ),
      h('input', {
        ref: fileInputRef,
        type: 'file',
        accept: 'image/*',
        multiple: true,
        style: { display: 'none' },
        onChange: event => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length > 0) void appendFiles(files)
        },
      }),
      quotes.length > 0 ? h('div', { className: 'fc-composer-quote' },
        h('span', { title: quotes.at(-1).summary }, `${t('composer.quoteCount', { count: quotes.length })} · ${quotes.at(-1).summary}`),
        h('button', {
          type: 'button',
          className: 'fc-icon-button',
          title: t('composer.removeQuotes'),
          'aria-label': t('composer.removeQuotes'),
          onClick: () => setQuotes([]),
        }, '×'),
      ) : null,
      h('div', { className: 'fc-composer-foot' },
        h('span', { className: `fc-count${content.length > 3800 ? ' fc-count-warn' : ''}` },
          state.uploadingImages
            ? t('composer.uploading')
            : content.length > 0 ? `${content.length}/4096` : ''),
      ),
    ),
    h(RedPacketDialog, { t }),
    h(UserInfoDialog, { t }),
    imagePreview === null ? null : h(ImagePreview, {
      gallery: imagePreview, t, onClose: () => setImagePreview(null),
    }),
  )
}

function useStore() {
  return useSyncExternalStore(sharedStore.subscribe, sharedStore.getSnapshot, sharedStore.getSnapshot)
}

function Chatroom({ t }) {
  const state = useStore()
  const [settings, setSettings] = useState(false)
  return h(ChatBoundary, { t },
    h('div', { className: 'fc-chat-area', hidden: settings, inert: settings },
      h(ChatPanel, {
        key: state.user?.id ?? '',
        visible: !settings,
        t,
        onSettings: () => setSettings(true),
      }),
    ),
    settings ? h(SettingsSection, { t, onBack: () => setSettings(false) }) : null,
  )
}

export function mountChat(container, app, locale) {
  bridge = app
  const t = translator(locale)
  document.documentElement.lang = locale
  const lifetime = new AbortController()
  sharedStore = createStore(t)
  const root = createRoot(container)
  root.render(h(Chatroom, { t }))

  const clearUnread = () => sharedStore.clearUnreadIfVisible()
  const openLink = event => {
    if (event.defaultPrevented) return
    const anchor = event.target.closest?.('a[href]')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href')
    if (!/^https?:\/\//iu.test(href)) return
    let url
    try { url = new URL(href) } catch { return }
    if (url && !url.username && !url.password) {
      void app.openLink({ url: url.href }).catch(() => {})
    }
  }
  document.addEventListener('visibilitychange', clearUnread)
  window.addEventListener('focus', clearUnread)
  container.addEventListener('click', openLink)
  void sharedStore.init(lifetime.signal)

  return () => {
    document.removeEventListener('visibilitychange', clearUnread)
    window.removeEventListener('focus', clearUnread)
    container.removeEventListener('click', openLink)
    lifetime.abort()
    sharedStore.dispose()
    root.unmount()
  }
}
