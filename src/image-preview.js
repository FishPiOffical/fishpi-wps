import { createElement as h, useLayoutEffect, useRef, useState } from 'react'

export function imagePreviewFromEvent(event) {
  if (event.defaultPrevented || (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ')) return null
  const trigger = event.target
  const selector = '.fc-html img[data-fc-preview][src]'
  if (!trigger.matches?.(selector)) return null
  const thumbnails = [...event.currentTarget.querySelectorAll(selector)]
  const index = thumbnails.indexOf(trigger)
  if (index < 0) return null
  event.preventDefault()
  event.stopPropagation()
  return {
    index,
    trigger,
    images: thumbnails.map(image => ({ src: image.src, alt: image.alt })),
  }
}

export function ImagePreview({ gallery, onClose, t }) {
  const { images, trigger } = gallery
  const [index, setIndex] = useState(gallery.index)
  const [failedIndex, setFailedIndex] = useState(null)
  const dialogRef = useRef(null)
  const image = images[index]

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    dialog.showModal()
    return () => {
      dialog.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [trigger])

  const move = offset => {
    const next = index + offset
    if (next >= 0 && next < images.length) {
      setFailedIndex(null)
      setIndex(next)
    }
  }

  const previewButton = (label, symbol, offset) => h('button', {
    type: 'button',
    className: `fc-image-preview-button fc-image-preview-${offset < 0 ? 'prev' : 'next'}`,
    'aria-label': t(label),
    title: t(label),
    'aria-disabled': index + offset < 0 || index + offset >= images.length,
    onClick: () => move(offset),
  }, symbol)

  return h('dialog', {
    ref: dialogRef,
    className: 'fc-image-preview',
    'aria-label': t('image.preview'),
    onCancel: event => {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    },
    onKeyDown: event => {
      if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') onClose()
      else move(event.key === 'ArrowLeft' ? -1 : 1)
    },
  },
    h('div', { className: 'fc-image-preview-layout' },
      h('header', { className: 'fc-image-preview-header' },
        h('span', { role: 'status' }, t('image.position', { current: index + 1, total: images.length })),
        h('button', {
          type: 'button',
          className: 'fc-image-preview-button',
          'aria-label': t('image.close'),
          title: t('image.close'),
          onClick: onClose,
        }, '×'),
      ),
      h('div', { className: 'fc-image-preview-stage' },
        failedIndex === index
          ? h('span', { role: 'status' }, t('image.failed'))
          : h('img', {
              key: index,
              src: image.src,
              alt: image.alt || t('plain.image'),
              referrerPolicy: 'no-referrer',
              onError: () => setFailedIndex(index),
            }),
        images.length > 1 ? previewButton('image.previous', '‹', -1) : null,
        images.length > 1 ? previewButton('image.next', '›', 1) : null,
      ),
    ),
  )
}
