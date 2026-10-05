// Генерация TS-типов из shared/schema → src/shared/types.gen.ts.
// Схемы сливаются в один документ (ссылки "project.schema.json#/definitions/X" → "#/definitions/X"),
// как и в backend/app/tools/gen_models.py.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'json-schema-to-typescript'

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = join(here, '..', '..', 'shared', 'schema')
const out = join(here, '..', 'src', 'shared', 'types.gen.ts')
const files = ['project.schema.json', 'api.schema.json']

function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs)
  if (node && typeof node === 'object') {
    const res = {}
    for (const [k, v] of Object.entries(node)) {
      res[k] =
        k === '$ref' && typeof v === 'string' && v.includes('#/definitions/')
          ? '#/definitions/' + v.split('#/definitions/')[1]
          : rewriteRefs(v)
    }
    return res
  }
  return node
}

const definitions = {}
for (const f of files) {
  const doc = JSON.parse(readFileSync(join(schemaDir, f), 'utf8'))
  for (const [k, v] of Object.entries(doc.definitions ?? {})) {
    if (k in definitions) throw new Error(`duplicate definition ${k} in ${f}`)
    // title = имя определения, чтобы json2ts не выдумывал имена для вложенных типов
    definitions[k] = { title: k, ...rewriteRefs(v) }
  }
}

const schema = { title: 'AIEditorSchema', type: 'object', additionalProperties: false, definitions }
let ts = await compile(schema, 'AIEditorSchema', {
  bannerComment:
    '/* Сгенерировано из shared/schema командой `npm run gen:types`. Не редактировать вручную. */',
  unreachableDefinitions: true,
  ignoreMinAndMaxItems: true,
  additionalProperties: false,
  declareExternallyReferenced: true,
  format: true,
  style: { semi: false, singleQuote: true, printWidth: 110, trailingComma: 'all' },
})
// Корневой тип-контейнер и служебные комментарии json2ts не нужны
ts = ts
  .replace(/\r\n/g, '\n')
  .replace(/export interface AIEditorSchema \{\}\n\n?/, '')
  .replace(
    /( \*\n)? \* This interface was referenced by `AIEditorSchema`'s JSON-Schema\n \* via the `definition` "\w+"\.\n/g,
    '',
  )
  .replace(/\/\*\*\n \*\/\n/g, '')
writeFileSync(out, ts)
console.log('written src/shared/types.gen.ts')
