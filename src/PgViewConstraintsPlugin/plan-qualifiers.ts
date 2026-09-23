// Which column references the plan's own qualifiers keep from being NULL.
//
// A conjunct `x IS NOT NULL` rejects every row in which `x` is NULL, and so does a
// conjunct `x = …` whose operator is strict — which every `=` is, while `pg_operator`
// says so. Neither is an expression evaluated: the qualifier is read for what it
// rejects, not computed. `README.md`, "Non-nullness", is the contract.
//
// Where a qualifier holds is the whole of the question. It holds of the rows the node
// printing it emits, and of those only, so it is read nowhere it holds of fewer rows
// than the ones a column arrives in: not in the condition of an outer or anti join,
// not in an arm of a disjunction, not in a subplan. And a qualifier that names a
// column of a relation outside the node printing it — a nested loop pushes `b.id =
// a.bank_id` down into the scan of `b` — counts for that column only where every join
// between the two emits its rows together with a row that passed it, which is what
// makes the nested loop read like the hash join that prints the same condition at the
// join itself.
//
// One qualifier is not printed at all, and depends on the plan whether it is: a scan
// through a partial index drops from its `Filter` whatever the index's predicate
// implies. So the predicate of the index a scan names is a qualifier of that scan.

import { CONDITION_FIELDS, JOIN_CONDITION_FIELDS, splitTopLevel, unwrap } from './plan-keys.ts'
import type { KeyReadingContext } from './plan-keys.ts'
import type { ExplainPlanNode } from './plan-origins.ts'

/** What the catalog says about qualifiers the plan does not print. */
export interface QualifierCatalog {
  /** The predicate of a partial index of `schema.relation`, as `pg_get_expr` prints it. */
  partialIndexPredicate(schema: string, relation: string, index: string): string | null
  /** Every `=` operator in the database is strict, so an equality rejects a NULL. */
  strictEquality: boolean
}

type Context = Pick<KeyReadingContext, 'inputs' | 'reference' | 'soleAlias' | 'crossed'>

const SEPARATOR = '\u0001'

/** How `readQualifiedNonNull` names a column reference in the set it returns. */
export function qualifiedReference(alias: string, column: string): string {
  return `${alias}${SEPARATOR}${column}`
}

const element = qualifiedReference

function aliasOf(value: string): string {
  return value.slice(0, value.indexOf(SEPARATOR))
}

// Join types whose own condition holds of every row they emit: an inner join emits
// only matched pairs, and a semi join only rows that found a match.
const ROW_EMITTING_ON_MATCH: ReadonlySet<string> = new Set(['Inner', 'Semi', 'Right Semi'])

// Which child of a join of this type the join emits every row of together with a
// row of that child. A child not listed can be missing from an emitted row.
const ACCOMPANYING_CHILDREN = new Map<string, ReadonlySet<string>>([
  ['Inner', new Set(['Outer', 'Inner'])],
  ['Left', new Set(['Outer'])],
  ['Right', new Set(['Inner'])],
  ['Semi', new Set(['Outer', 'Inner'])],
  ['Right Semi', new Set(['Outer', 'Inner'])],
  ['Anti', new Set(['Outer'])],
  ['Right Anti', new Set(['Inner'])]
])

/** The column references one qualifier rejects a NULL in. */
function rejectedNulls(
  qualifier: string,
  strictEquality: boolean,
  resolve: (operand: string) => string | null
): string[] {
  const found: string[] = []
  for (const conjunct of splitTopLevel(unwrap(qualifier), ' AND ')) {
    const text = unwrap(conjunct)
    if (text.endsWith(' IS NOT NULL')) {
      const operand = resolve(text.slice(0, -' IS NOT NULL'.length))
      if (operand !== null) found.push(operand)
      continue
    }
    if (!strictEquality) continue
    const sides = splitTopLevel(text, ' = ')
    if (sides.length !== 2) continue
    for (const side of sides) {
      const operand = resolve(side)
      if (operand !== null) found.push(operand)
    }
  }
  return found
}

/**
 * Every column reference, `alias` + `column`, that no row reaching the top of the
 * plan carries a NULL in — as far as the plan's qualifiers say, and before any outer
 * join nulls the scan it was read from, which `plan-origins.ts` accounts for itself.
 */
export function readQualifiedNonNull(
  root: ExplainPlanNode,
  context: Context,
  catalog: QualifierCatalog
): Set<string> {
  const resolveWith =
    (soleAlias: string | null) =>
    (operand: string): string | null => {
      const reference = context.reference(unwrap(operand))
      if (!reference || reference.coerced) return null
      const alias = reference.alias ?? soleAlias
      return alias === null ? null : element(alias, reference.column)
    }
  const resolve = resolveWith(context.soleAlias)

  const below = new Map<ExplainPlanNode, Set<string>>()
  const aliasesBelow = (node: ExplainPlanNode): Set<string> => {
    const known = below.get(node)
    if (known) return known
    const aliases = new Set<string>()
    if (node.Alias !== undefined) aliases.add(node.Alias)
    for (const child of context.inputs(node)) {
      for (const alias of aliasesBelow(child)) aliases.add(alias)
    }
    below.set(node, aliases)
    return aliases
  }

  const nonNull = new Set<string>()
  // `path` holds each ancestor with the relationship of the child on the way down.
  const admit = (
    node: ExplainPlanNode,
    references: string[],
    path: { node: ExplainPlanNode; child: string }[]
  ): void => {
    for (const reference of references) {
      const alias = aliasOf(reference)
      if (aliasesBelow(node).has(alias)) {
        nonNull.add(reference)
        continue
      }
      let accompanied = true
      let reached = false
      for (let at = path.length - 1; at >= 0; at--) {
        const step = path[at]
        if (!step) break
        const joinType = step.node['Join Type']
        if (joinType !== undefined) {
          const kept = ACCOMPANYING_CHILDREN.get(joinType)
          if (!kept?.has(step.child)) accompanied = false
        }
        if (aliasesBelow(step.node).has(alias)) {
          reached = true
          break
        }
      }
      if (reached && accompanied) nonNull.add(reference)
    }
  }

  const predicateOf = (scan: ExplainPlanNode, indexName: string): string[] => {
    if (scan.Schema === undefined || scan['Relation Name'] === undefined) return []
    const predicate = catalog.partialIndexPredicate(scan.Schema, scan['Relation Name'], indexName)
    if (predicate === null) return []
    // The predicate names the relation's columns unqualified; they are this scan's.
    return rejectedNulls(
      predicate,
      catalog.strictEquality,
      resolveWith(scan.Alias ?? scan['Relation Name'])
    )
  }

  const bitmapIndexes = (node: ExplainPlanNode): string[] => {
    if (node['Node Type'] === 'BitmapOr') return []
    if (node['Node Type'] === 'Bitmap Index Scan') {
      return node['Index Name'] === undefined ? [] : [node['Index Name']]
    }
    return (node.Plans ?? []).flatMap(bitmapIndexes)
  }

  const visit = (node: ExplainPlanNode, path: { node: ExplainPlanNode; child: string }[]) => {
    const type = node['Node Type']
    if (type === 'BitmapOr') return
    const joinType = node['Join Type']
    for (const field of CONDITION_FIELDS) {
      const condition = node[field]
      if (typeof condition !== 'string') continue
      const ownCondition = (JOIN_CONDITION_FIELDS as readonly string[]).includes(field)
      if (joinType !== undefined && ownCondition && !ROW_EMITTING_ON_MATCH.has(joinType)) continue
      admit(node, rejectedNulls(condition, catalog.strictEquality, resolve), path)
    }
    if (node['Index Name'] !== undefined && node['Relation Name'] !== undefined) {
      admit(node, predicateOf(node, node['Index Name']), path)
    }
    if (type === 'Bitmap Heap Scan') {
      for (const index of (node.Plans ?? []).flatMap(bitmapIndexes)) {
        admit(node, predicateOf(node, index), path)
      }
    }
    for (const child of context.inputs(node)) {
      visit(child, [...path, { node, child: child['Parent Relationship'] ?? 'Outer' }])
    }
  }
  visit(root, [])

  // A view boundary emits its child's rows, filtered at most, so what is known of a
  // crossed view's column is known of the select-list entry it is.
  let grew = true
  while (grew) {
    grew = false
    for (const [alias, crossed] of context.crossed) {
      if (crossed.branches) continue
      for (const [at, entry] of (crossed.selectList.Output ?? []).entries()) {
        const column = crossed.view.columns[at]
        if (column === undefined || !nonNull.has(element(alias, column))) continue
        const inner = resolve(entry)
        if (inner !== null && !nonNull.has(inner)) {
          nonNull.add(inner)
          grew = true
        }
      }
    }
  }
  return nonNull
}
