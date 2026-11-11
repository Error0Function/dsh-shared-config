/** YAML edits preserve unrelated rows, comments and JavaScript expressions. */
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'
import type { Document } from 'yaml'

/** Parse a persisted patch list, refusing malformed documents. */
export function patchDocument(raw: string): Document {
  const doc = parseDocument(raw, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (doc.errors[0]) throw doc.errors[0]
  if (!isSeq(doc.contents)) throw new Error('Shared patch must be a YAML sequence')
  doc.contents.flow = false
  return doc
}

/** Replace or remove one entry config without deleting its other metadata. */
export function editPatch(raw: string, id: string, name: string, config: Record<string, unknown> | undefined): string {
  const doc = patchDocument(raw)
  if (!isSeq(doc.contents)) throw new Error('Shared patch must be a YAML sequence')
  const indices = doc.contents.items.flatMap((item, index) => isMap(item) && doc.getIn([index, 'id']) === id && !item.has('insert') ? [index] : [])
  for (const index of indices) {
    const row = doc.contents.items[index]
    if (isMap(row) && row.has('name') && doc.getIn([index, 'name']) !== name) throw new Error(`Shared entry "${id}" belongs to another plugin`)
  }
  if (config === undefined) {
    for (const index of indices.reverse()) {
      const row = doc.contents.items[index]
      if (!isMap(row)) continue
      row.delete('config')
      if (row.items.every(item => item.key instanceof Scalar && ['id', 'name'].includes(String(item.key.value)))) doc.delete(index)
    }
  } else if (indices.length === 0) {
    doc.add(doc.createNode({ id, name, config }))
  } else {
    const index = indices.at(-1)!
    const row = doc.contents.items[index]
    if (isMap(row)) doc.setIn([index, 'config'], config)
  }
  visit(doc, { Map(_key, node) {
    if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
    const value = new Scalar(node.get('__jsExpr'))
    value.tag = 'tag:yaml.org,2002:js'
    return value
  } })
  return String(doc)
}
