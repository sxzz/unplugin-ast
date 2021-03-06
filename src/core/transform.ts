import MagicString from 'magic-string'
import generate from '@babel/generator'
import { parseCode, walkAst } from './ast'
import { useNodeRef } from './utils'
import type { Transformer, TransformerParsed } from './types'
import type { SourceMap } from 'rollup'
import type { ExpressionStatement, Node } from '@babel/types'
import type { OptionsResolved } from './options'

async function getTransformersByFile(transformer: Transformer[], id: string) {
  const transformers = (
    await Promise.all(
      transformer.map(async (t): Promise<TransformerParsed | undefined> => {
        if (t.transformInclude && !(await t.transformInclude(id)))
          return undefined
        return {
          transformer: t,
          nodes: [],
        }
      })
    )
  ).filter((t): t is TransformerParsed => !!t)
  return transformers
}

export const transform = async (
  code: string,
  id: string,
  options: Pick<OptionsResolved, 'parserOptions' | 'transformer'>
): Promise<{ code: string; map: SourceMap } | undefined> => {
  const { getNodeRef } = useNodeRef()

  const transformers = await getTransformersByFile(options.transformer, id)
  if (transformers.length === 0) return

  const nodes = parseCode(code, id, options.parserOptions)

  await walkAst(nodes, async (node, parent) => {
    for (const { transformer, nodes } of transformers) {
      if (transformer.onNode) {
        const bool = await transformer.onNode?.(node, parent)
        if (!bool) continue
      }
      nodes.push(getNodeRef(node))
    }
  })

  const s = new MagicString(code)
  for (const { transformer, nodes } of transformers) {
    for (const node of nodes) {
      const value = node.value
      const result = await transformer.transform(value, code, { id })
      if (!result) continue

      let newAST: Node
      if (typeof result === 'string') {
        s.overwrite(value.start!, value.end!, result)
        newAST = (
          parseCode(
            `(${result})`,
            id,
            options.parserOptions
          )[0] as ExpressionStatement
        ).expression
        newAST.start = value.start!
        newAST.end = value.end!
      } else {
        const generated = generate(result)
        s.overwrite(value.start!, value.end!, `(${generated.code})`)
        newAST = result
      }

      node.set(newAST)
    }
  }
  if (!s.hasChanged()) return undefined

  return {
    code: s.toString(),
    get map() {
      return s.generateMap({
        source: id,
        includeContent: true,
      })
    },
  }
}
