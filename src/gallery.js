import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { translator } from './copy.js'
import { ImagePreview } from './image-preview.js'
import { localRequest } from './wps-bridge.js'

const t = translator(navigator.language || 'zh-CN')
const container = document.getElementById('app')
const id = new URLSearchParams(location.search).get('id')

try {
  const gallery = await localRequest(`api/gallery?id=${encodeURIComponent(id ?? '')}`)
  if (!Array.isArray(gallery.images)) throw new Error('Image preview has expired')
  createRoot(container).render(h(ImagePreview, { gallery, t, onClose: () => window.close() }))
} catch {
  container.firstElementChild.textContent = t('image.failed')
}
