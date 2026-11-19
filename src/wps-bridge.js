const base = new URL('./', window.location.href)
const application = () => window.Application ?? window.wps

export async function localRequest(path, data, options = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, options.timeout ?? 30_000)
  try {
    const response = await fetch(new URL(path, base), {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      ...(data === undefined ? {} : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }),
    })
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export const bridge = {
  callServerTool: (request, options) => localRequest('api/chat', request, options),
  async openLink({ url }) {
    const run = application()?.OAAssist
    if (run?.ShellExecute) run.ShellExecute(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  },
  async openGallery(gallery, title) {
    const app = application()
    if (!app?.ShowDialog) return false
    try {
      const start = Math.max(0, gallery.index - 100)
      const images = gallery.images.slice(start, start + 200).map(({ src, alt }) => ({ src, alt: alt.slice(0, 256) }))
      const { id } = await localRequest('api/gallery', { images, index: gallery.index - start })
      if (typeof id !== 'string' || !gallery.trigger.isConnected) return false
      const url = new URL('gallery.html', base)
      url.searchParams.set('id', id)
      const width = Math.max(320, screen.availWidth - 64)
      const height = Math.max(260, screen.availHeight - 80)
      return app.ShowDialog(url.href, title, width, height, true) !== false
    } catch {
      return false
    }
  },
}
