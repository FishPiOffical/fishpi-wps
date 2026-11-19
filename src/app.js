import { mountChat } from './chat.js'
import { bridge, localRequest } from './wps-bridge.js'
import { translator } from './copy.js'

const container = document.getElementById('app')
const locale = navigator.language || 'zh-CN'
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

try {
  const { version } = await localRequest('health', undefined, { timeout: 5000 })
  if (typeof version !== 'string') throw new Error('Missing bridge version')
  const teardown = mountChat(container, bridge, locale)
  window.addEventListener('pagehide', teardown, { once: true })
} catch {
  container.firstElementChild.textContent = translator(locale)('bridge.failed')
}
