import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

export function registerAddin(xml, url) {
  const doc = new DOMParser({ onError: () => { throw new Error('WPS 加载项配置 XML 无法解析') } })
    .parseFromString(xml, 'application/xml')
  const root = doc.documentElement
  if (root?.nodeName !== 'jsplugins' || doc.doctype) throw new Error('WPS 加载项配置格式无效')

  const name = 'fishpi-wps'
  const matching = Array.from(root.childNodes).filter(node =>
    node.nodeName === 'jspluginonline' && node.getAttribute('name') === name)
  const entry = matching[0] ?? root.appendChild(doc.createElement('jspluginonline'))
  for (const duplicate of matching.slice(1)) root.removeChild(duplicate)
  entry.removeAttribute('debug')
  entry.removeAttribute('enable')
  for (const [key, value] of Object.entries({ name, type: 'wps', url, install: 'null' })) {
    entry.setAttribute(key, value)
  }
  return `${new XMLSerializer().serializeToString(doc)}\n`
}
