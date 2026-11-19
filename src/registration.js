import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

const name = 'fishpi-wps'

function parseManifest(xml) {
  const doc = new DOMParser({ onError: () => { throw new Error('WPS 加载项配置 XML 无法解析') } })
    .parseFromString(xml, 'application/xml')
  const root = doc.documentElement
  if (root?.nodeName !== 'jsplugins' || doc.doctype) throw new Error('WPS 加载项配置格式无效')
  const matching = Array.from(root.childNodes).filter(node =>
    node.nodeName === 'jspluginonline' && node.getAttribute('name') === name)
  return { doc, root, matching }
}

const serialize = doc => `${new XMLSerializer().serializeToString(doc)}\n`

export function registerAddin(xml, url) {
  const { doc, root, matching } = parseManifest(xml)
  const entry = matching[0] ?? root.appendChild(doc.createElement('jspluginonline'))
  for (const duplicate of matching.slice(1)) root.removeChild(duplicate)
  entry.removeAttribute('debug')
  entry.removeAttribute('enable')
  for (const [key, value] of Object.entries({ name, type: 'wps', url, install: 'null' })) {
    entry.setAttribute(key, value)
  }
  return serialize(doc)
}

export function unregisterAddin(xml) {
  const { doc, root, matching } = parseManifest(xml)
  if (matching.length === 0) return xml
  for (const entry of matching) root.removeChild(entry)
  return serialize(doc)
}
