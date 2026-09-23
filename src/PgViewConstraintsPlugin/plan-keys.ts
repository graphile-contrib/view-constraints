// Which sets of a view's columns no two of its rows share, read off the plan.
//
// Keys are worked out the way a relational algebra works them out: bottom-up, each
// node of the plan answering which sets of its own output columns are unique among
// the rows it emits, from what its inputs answered. A relation scan starts from the
// catalog's unique keys; a block of inner joins is keyed by the fewest row sources
// whose rows determine all the others'; a grouping makes its group key one; a
// `UNION ALL` whose branches each write a different text literal into one column
// keeps the branches apart. The table in `README.md`, "Row identity", is the
// contract; this module is its reader.
//
// A key is spelled in the vocabulary the node's parent reads the node's output in —
// `alias.column` for a scan, `alias.column` of a crossed view boundary, a position of a
// union — so it travels up the plan the way the value does, and the select list at the
// top maps it onto the view's own columns.
//
// Whether a join multiplies a side is read from equalities, and the equalities are
// read from the whole of the joined inputs as well as from the joins themselves,
// because which of them a plan prints where is the planner's judgement of cost: a hash
// join keeps `a.x = b.id` at the join, a nested loop pushes it down into the inner
// index scan, and a genetic join order may print it two joins above where the view
// wrote it. Taken together, and transitively, over a whole block of inner joins at
// once, they answer the same under all of them.

import type { ExplainPlanNode, ViewShape } from './plan-origins.ts'

/** A unique key of a base relation, as `pg_index` states it. */
export interface RelationUniqueKey {
  name: string
  isPrimary: boolean
  columns: string[]
}

/** The unique keys of a relation the plan scans, by schema and name. */
export type UniqueKeysOf = (schema: string, relation: string) => readonly RelationUniqueKey[]

/** One base relation's unique key, carried through the plan to the view unchanged. */
export interface CarriedKey {
  schema: string
  relation: string
  /** The plan's name for the scan instance the key belongs to. */
  alias: string
  /** The unique index's name. */
  name: string
  isPrimary: boolean
}

/** A set of the view's columns that no two of its rows share. */
export interface PlanKey {
  /**
   * Positions of the view's columns. For a carried key, in the base key's own column
   * order; otherwise in the view's column order.
   */
  columns: number[]
  /** The base key this is, where it is one base relation's key; `null` otherwise. */
  carried: CarriedKey | null
  /** Positions of `columns` that hold a union's discriminator literal. */
  discriminators: number[]
}

/** What the reader of the plan already knows and this module needs of it. */
export interface KeyReadingContext {
  /** A plan node's input children, as opposed to the InitPlans and SubPlans beside it. */
  inputs(node: ExplainPlanNode): ExplainPlanNode[]
  /**
   * The column one `Output` entry or condition operand is a reference to, as
   * `alias` + `column`, or `null` where it is anything else. A reference under a
   * cast is the column's value in an `Output` entry, where `derive.ts` judges the
   * cast; in a condition it equates nothing.
   */
  reference(entry: string): { alias: string | null; column: string; coerced: boolean } | null
  /** The alias an unqualified name belongs to, where the plan reads exactly one relation. */
  soleAlias: string | null
  /** Node types whose target list is their input's, entry for entry. */
  passThrough: ReadonlySet<string>
  /** `Append`, `Merge Append`. */
  unioning: ReadonlySet<string>
  /** `Subquery Scan` nodes the catalog pins to one view, by alias. */
  crossed: ReadonlyMap<
    string,
    { view: ViewShape; selectList: ExplainPlanNode; branches: ExplainPlanNode[] | null }
  >
  /** Which inputs of a join of this type the join nulls: `Outer`, `Inner`. */
  nulledSides(joinType: string): ReadonlySet<string>
  uniqueKeysOf: UniqueKeysOf
}

/**
 * One key of one node. `elements` is the set, `order` the same elements in the
 * order a carried key spells them.
 */
interface NodeKey {
  elements: string[]
  order: string[]
  carried: CarriedKey | null
  discriminators: string[]
  /**
   * Offered only to pin the node to the other side of a join, never carried above
   * it; see `Scope.underJoin`.
   */
  pinOnly: boolean
}

// The number of keys one node keeps. A join of two sides neither of which is unique
// given the other has a key for every pair of their keys, and a wide plan of such
// joins would otherwise grow them without bound. What is kept is the smallest, in a
// fixed order, so the cut is the same wherever the same keys arrive.
const KEYS_PER_NODE = 64

const SEPARATOR = '\u0001'
const CONSTANT = '\u0002constant'
// An operand that is neither a bare column nor a literal, by its text. It equates
// nothing transitively — two spellings of `random()` are two values — and serves only
// to pin a de-duplicated input whose column it is (see `KeyReader.dedupKey`).
const EXPRESSION = '\u0003'

function element(alias: string, column: string): string {
  return `${alias}${SEPARATOR}${column}`
}

function position(index: number): string {
  return `#${index}`
}

function aliasOf(value: string): string | null {
  const at = value.indexOf(SEPARATOR)
  return at < 0 ? null : value.slice(0, at)
}

// Conditions a node prints that can hold an equality between two of its values.
export const CONDITION_FIELDS = [
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Filter',
  'Index Cond',
  'Recheck Cond',
  'TID Cond'
] as const

// A join's own condition, as opposed to the `Filter` it applies to the rows it has
// already joined.
export const JOIN_CONDITION_FIELDS = ['Hash Cond', 'Merge Cond', 'Join Filter'] as const

// A text literal as EXPLAIN deparses it. Its body is what two branches are told apart
// by: `'x'::character varying(5)` and `'x'::character varying(10)` are one value.
const TEXT_LITERAL = /^('(?:[^']|'')*')::(?:text|character varying(?:\(\d+\))?)$/
// A constant as EXPLAIN deparses one: a quoted literal under its type, a number, a
// boolean.
const LITERAL = /^(?:'(?:[^']|'')*'::[a-z_ ."]+(?:\(\d+(?:,\d+)?\))?|-?\d+(?:\.\d+)?|true|false)$/

/** Whether the whole string is wrapped in one pair of parentheses. */
function wrapped(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) return false
  let depth = 0
  let quoted = false
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (quoted) {
      if (char === "'") quoted = false
      continue
    }
    if (char === "'") quoted = true
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0 && at < text.length - 1) return false
    }
  }
  return depth === 0
}

export function unwrap(text: string): string {
  let current = text.trim()
  while (wrapped(current)) current = current.slice(1, -1).trim()
  return current
}

/** Splits `text` on `separator` wherever it stands outside parentheses and quotes. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let at = 0; at < text.length; at++) {
    const char = text[at]
    if (quoted) {
      if (char === "'") quoted = false
      continue
    }
    if (char === "'") quoted = true
    else if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (depth === 0 && text.startsWith(separator, at)) {
      parts.push(text.slice(start, at))
      start = at + separator.length
      at += separator.length - 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/**
 * The equalities a condition states, conjunct by conjunct. Only `column = column` and
 * `column = literal` equate two values for good: a cast, an expression or a function
 * call on either side is kept as an expression operand, which pins nothing but a
 * de-duplicated input's own column of that text, and a disjunction states nothing
 * about any single row.
 */
export function conditionEqualities(
  condition: string,
  context: Pick<KeyReadingContext, 'reference' | 'soleAlias'>
): [string, string][] {
  const found: [string, string][] = []
  for (const conjunct of splitTopLevel(unwrap(condition), ' AND ')) {
    const sides = splitTopLevel(unwrap(conjunct), ' = ')
    if (sides.length !== 2) continue
    const [left, right] = sides.map((side) => operand(side.trim(), context))
    if (left === null || right === null || left === undefined || right === undefined) continue
    if (left === CONSTANT && right === CONSTANT) continue
    if (left.startsWith(EXPRESSION) && right.startsWith(EXPRESSION)) continue
    found.push([left, right])
  }
  return found
}

function operand(
  text: string,
  context: Pick<KeyReadingContext, 'reference' | 'soleAlias'>
): string | null {
  if (LITERAL.test(text)) return CONSTANT
  const reference = context.reference(text)
  const alias = reference?.alias ?? context.soleAlias
  if (reference && !reference.coerced && alias !== null) return element(alias, reference.column)
  return expression(text)
}

function expression(text: string): string {
  return `${EXPRESSION}${unwrap(text)}`
}

class UnionFind {
  private readonly parent = new Map<string, string>()

  find(value: string): string {
    if (!this.parent.has(value)) this.parent.set(value, value)
    let root = value
    for (;;) {
      const next = this.parent.get(root)
      if (next === undefined || next === root) break
      root = next
    }
    let current = value
    while (current !== root) {
      const next = this.parent.get(current) ?? root
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(left: string, right: string): void {
    const a = this.find(left)
    const b = this.find(right)
    if (a === b) return
    // The smaller name becomes the root, so the structure is the same whatever
    // order the equalities arrive in.
    if (a < b) this.parent.set(b, a)
    else this.parent.set(a, b)
  }

  members(): Map<string, string[]> {
    const classes = new Map<string, string[]>()
    for (const value of this.parent.keys()) {
      const root = this.find(value)
      const members = classes.get(root)
      if (members) members.push(value)
      else classes.set(root, [value])
    }
    return classes
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at])
}

function isSubset(small: readonly string[], large: readonly string[]): boolean {
  return small.every((value) => large.includes(value))
}

// Elements carry control characters as separators, which a locale's collation may
// ignore; the order keys are kept in must not depend on anything but their text.
function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareKeys(left: NodeKey, right: NodeKey): number {
  if (left.elements.length !== right.elements.length) {
    return left.elements.length - right.elements.length
  }
  const byElements = byCodePoint(left.elements.join('\n'), right.elements.join('\n'))
  if (byElements !== 0) return byElements
  // Between two statements of one set, the one that may be carried is kept, and the
  // carried one of those: each says more.
  if (left.pinOnly !== right.pinOnly) return left.pinOnly ? 1 : -1
  if ((left.carried === null) !== (right.carried === null)) return left.carried ? -1 : 1
  const name = (key: NodeKey): string =>
    key.carried ? `${key.carried.isPrimary ? 0 : 1}${key.carried.name}` : ''
  return byCodePoint(name(left), name(right))
}

/**
 * The keys worth keeping: no set that contains another set already kept, since a
 * superset of a key is a key and says less, and no more than `KEYS_PER_NODE`.
 */
function minimal(keys: NodeKey[]): NodeKey[] {
  const sorted = [...keys].sort(compareKeys)
  const kept: NodeKey[] = []
  for (const key of sorted) {
    // A key that may only pin says nothing about whether a superset may be carried.
    const covered = kept.some(
      (seen) => (!seen.pinOnly || key.pinOnly) && isSubset(seen.elements, key.elements)
    )
    if (covered) continue
    kept.push(key)
    if (kept.length >= KEYS_PER_NODE) break
  }
  return kept
}

function makeKey(
  elements: string[],
  options: {
    carried?: CarriedKey | null
    order?: string[]
    discriminators?: string[]
    pinOnly?: boolean
  } = {}
): NodeKey {
  return {
    elements: [...new Set(elements)].sort(),
    order: options.order ?? elements,
    carried: options.carried ?? null,
    discriminators: [...new Set(options.discriminators ?? [])].sort(),
    pinOnly: options.pinOnly ?? false
  }
}

/** Renames every element of a key; `null` where one of them has no new name. */
function renamed(key: NodeKey, rename: (value: string) => string | null): NodeKey | null {
  const map = new Map<string, string>()
  for (const value of new Set([...key.elements, ...key.order, ...key.discriminators])) {
    const next = rename(value)
    if (next === null) return null
    map.set(value, next)
  }
  const to = (value: string): string => map.get(value) ?? value
  return makeKey(key.elements.map(to), {
    carried: key.carried,
    order: key.order.map(to),
    discriminators: key.discriminators.map(to),
    pinOnly: key.pinOnly
  })
}

const GATHER_NODE_TYPES: ReadonlySet<string> = new Set(['Gather', 'Gather Merge'])

/**
 * Whether a `Gather` stands between `top` and the node carrying a select list under
 * it, which the readers of values step over as a node that hands its input on. For
 * keys it is not only that: below it, a worker sees a share of the rows.
 */
function gatherAbove(
  top: ExplainPlanNode,
  selectList: ExplainPlanNode,
  context: KeyReadingContext
): boolean {
  let node: ExplainPlanNode | undefined = top
  for (let step = 0; step < 16 && node && node !== selectList; step++) {
    if (GATHER_NODE_TYPES.has(node['Node Type'])) return true
    const inputs = context.inputs(node)
    node = inputs.length === 1 ? inputs[0] : undefined
  }
  return false
}

// What stands between a join and the rows it joins without being a row source of its
// own: the join's own machinery, a gating `Result`, and a `Gather` — below which a
// worker sees a share of the rows.
const JOIN_INPUT_NODE_TYPES: ReadonlySet<string> = new Set([
  'Hash',
  'Materialize',
  'Memoize',
  'Sort',
  'Incremental Sort',
  'Result',
  'Gather',
  'Gather Merge'
])

// Nodes whose output rows are not their input's rows: a group stands for many of them.
// What holds of an input row — an equality, a column — says nothing of the group, so
// neither is read through one.
const COLLAPSING_NODE_TYPES: ReadonlySet<string> = new Set(['Aggregate', 'Group', 'Unique'])

// The input of a join of this type whose rows it does not emit.
const UNEMITTED_SIDE = new Map<string, string>([
  ['Semi', 'Inner'],
  ['Anti', 'Inner'],
  ['Right Semi', 'Outer'],
  ['Right Anti', 'Outer']
])

// How many relations a key assembled across an inner join may be made of. Covers are
// looked for smallest first, and a view whose rows are told apart only by more
// relations than this is left without a derived key.
const RELATIONS_PER_KEY = 4

/** The equalities a block reads: classes of columns, and what each expression equals. */
interface Equalities {
  classes: UnionFind
  members: Map<string, string[]>
  partners: Map<string, string[]>
}

/** Where in the plan a node stands, as far as the keys it may offer go. */
interface Scope {
  /** Below a `Gather`: the node sees one worker's share of the rows. */
  inWorker: boolean
  /**
   * Below a join. A grouping, a de-duplication, a `LIMIT` or a window stands below a
   * join only as the top of a subquery the planner could not flatten, and whether a
   * `Subquery Scan` over it is left in the plan — renaming its columns to names the
   * plan never maps back — is the planner's judgement of cost. So there the keys such
   * a node makes are offered only to pin it to the other side of a join, never
   * carried above it.
   */
  underJoin: boolean
}

/** Whether a `Limit` stands between `top` and the node carrying a select list under it. */
function limitAbove(
  top: ExplainPlanNode,
  selectList: ExplainPlanNode,
  context: KeyReadingContext
): boolean {
  let node: ExplainPlanNode | undefined = top
  for (let step = 0; step < 16 && node && node !== selectList; step++) {
    if (node['Node Type'] === 'Limit') return true
    const inputs = context.inputs(node)
    node = inputs.length === 1 ? inputs[0] : undefined
  }
  return false
}

class KeyReader {
  private readonly memo = new Map<ExplainPlanNode, NodeKey[]>()

  private readonly context: KeyReadingContext

  constructor(context: KeyReadingContext) {
    this.context = context
  }

  /** The element an entry reads: a bare column, or the entry's text as an expression. */
  private dedupElement(entry: string): string {
    return this.bareElement(entry) ?? expression(entry)
  }

  /** The element an entry reads where it reads one column with no cast over it. */
  private bareElement(entry: string): string | null {
    const reference = this.context.reference(entry)
    if (!reference || reference.coerced) return null
    const alias = reference.alias ?? this.context.soleAlias
    return alias === null ? null : element(alias, reference.column)
  }

  /**
   * The first position of `node`'s `Output` at which each element stands, leaving out
   * an entry under a cast: a cast may map two values to one, so a key is not carried
   * across it.
   */
  positionsIn(node: ExplainPlanNode): Map<string, number> {
    const positions = new Map<string, number>()
    for (const [at, entry] of (node.Output ?? []).entries()) {
      const value = this.bareElement(entry)
      if (value !== null && !positions.has(value)) positions.set(value, at)
    }
    return positions
  }

  keysOf(node: ExplainPlanNode, scope: Scope): NodeKey[] {
    const memoized = this.memo.get(node)
    if (memoized) return memoized
    const keys = this.compute(node, scope)
    this.memo.set(node, keys)
    return keys
  }

  private compute(node: ExplainPlanNode, scope: Scope): NodeKey[] {
    const type = node['Node Type']
    const inputs = this.context.inputs(node)
    const only = inputs.length === 1 ? inputs[0] : undefined

    if (node['Relation Name'] !== undefined && node.Schema !== undefined) {
      const alias = node.Alias ?? node['Relation Name']
      const keys = this.context.uniqueKeysOf(node.Schema, node['Relation Name']).map((key) => {
        const order = key.columns.map((column) => element(alias, column))
        return makeKey(order, {
          carried: {
            schema: node.Schema ?? '',
            relation: node['Relation Name'] ?? '',
            alias,
            name: key.name,
            isPrimary: key.isPrimary
          },
          order
        })
      })
      return minimal(keys)
    }

    if (type === 'Limit' && scope.underJoin) return []

    if (this.context.passThrough.has(type) || type === 'Hash') {
      if (!only) return []
      // A worker sees a share of the rows, and what a node makes unique inside one
      // is unique only among that worker's rows.
      const inWorker = scope.inWorker || GATHER_NODE_TYPES.has(type)
      return this.keysOf(only, { ...scope, inWorker })
    }

    if (type === 'WindowAgg') {
      return only && !scope.underJoin ? minimal(this.keysOf(only, scope)) : []
    }

    if (type === 'Result') {
      if (only) return minimal(this.keysOf(only, scope))
      // No input: one row at most.
      return inputs.length === 0 && !scope.inWorker
        ? [makeKey([], { pinOnly: scope.underJoin })]
        : []
    }

    if (type === 'Subquery Scan') return this.crossedKeys(node, scope)

    if (type === 'Aggregate' || type === 'Group') return this.groupedKeys(node, scope, only)

    if (type === 'Unique') {
      if (!only) return []
      if (scope.underJoin) {
        if (scope.inWorker) return []
        const output = (node.Output ?? []).map((entry) => this.dedupElement(entry))
        return output.length > 0 ? [makeKey(output, { pinOnly: true })] : []
      }
      const all = (node.Output ?? []).map((entry) => this.bareElement(entry))
      const whole =
        !scope.inWorker && all.length > 0 && all.every((value) => value !== null)
          ? [makeKey(all as string[])]
          : []
      return minimal([...this.keysOf(only, scope), ...whole])
    }

    if (this.context.unioning.has(type)) {
      return scope.underJoin ? [] : this.positionalUnionKeys(node, inputs, scope)
    }

    if (node['Join Type'] !== undefined) return this.joinKeys(node, scope)

    return []
  }

  /**
   * A view boundary the reader crosses: the keys of the crossed view's select list,
   * renamed to the crossed view's own column names by the catalog map the values are
   * crossed by.
   */
  private crossedKeys(node: ExplainPlanNode, scope: Scope): NodeKey[] {
    const alias = node.Alias
    const crossed = alias === undefined ? undefined : this.context.crossed.get(alias)
    if (alias === undefined || !crossed) return []
    // A crossed view that ends in a `LIMIT` is, below a join, the top of a subquery like
    // any other: the reader of values steps over the `Limit`, and it has to be seen
    // here, where the node would be refused had the planner removed the boundary.
    if (scope.underJoin && limitAbove(node, crossed.selectList, this.context)) return []
    const inner: Scope = {
      ...scope,
      inWorker: scope.inWorker || gatherAbove(node, crossed.selectList, this.context)
    }
    const keys = crossed.branches
      ? scope.underJoin
        ? []
        : this.positionalUnionKeys(crossed.selectList, crossed.branches, inner)
      : this.keysOf(crossed.selectList, inner)
    const positions = crossed.branches ? null : this.positionsIn(crossed.selectList)
    const renamedKeys: NodeKey[] = []
    for (const key of keys) {
      const next = renamed(key, (value) => {
        const at = positions ? positions.get(value) : Number(value.slice(1))
        const column = at === undefined ? undefined : crossed.view.columns[at]
        return column === undefined ? null : element(alias, column)
      })
      if (next) renamedKeys.push(next)
    }
    return minimal(renamedKeys)
  }

  private groupedKeys(
    node: ExplainPlanNode,
    scope: Scope,
    only: ExplainPlanNode | undefined
  ): NodeKey[] {
    if (!only || node['Grouping Sets'] !== undefined) return []
    const partial = node['Partial Mode'] === 'Partial'
    const groupKey = node['Group Key']
    if (groupKey === undefined) {
      // No grouping: one row for the whole input — unless a worker computes it over
      // its share and a `Finalize` above combines them.
      return scope.inWorker || partial ? [] : [makeKey([], { pinOnly: scope.underJoin })]
    }
    const grouped = groupKey.map((entry) => this.bareElement(entry))
    const references = grouped.filter((value): value is string => value !== null)
    const whole = !scope.inWorker && !partial && references.length === grouped.length
    if (scope.underJoin) {
      // Below a join only a de-duplication is offered, and only to be pinned: a node
      // that computes no aggregate beside its group key, which is what the planner
      // builds to turn a semi join into an inner one and what `(SELECT DISTINCT …)`
      // is. Its key may be an expression — `IN (SELECT b.y + 1 …)` groups by `b.y + 1`
      // and emits `b.y` — and is pinned where the join equates that expression.
      if (scope.inWorker || partial) return []
      const keyed = groupKey.map((entry) => this.dedupElement(entry))
      const pure = (node.Output ?? []).every(
        (entry) => keyed.includes(this.dedupElement(entry)) || this.bareElement(entry) !== null
      )
      return pure && keyed.length > 0 ? [makeKey(keyed, { pinOnly: true })] : []
    }
    // A key of the input the grouping contains leaves every group one row, whether
    // the grouping is done whole or worker by worker.
    const keys = this.keysOf(only, scope).filter((key) => isSubset(key.elements, references))
    if (whole && references.length > 0) keys.push(makeKey(references))
    return minimal(keys)
  }

  /**
   * The keys of a union, by position. Rows of different branches are told apart by a
   * discriminator — a position every branch fills with a non-NULL text literal of its
   * own — and rows of one branch by a key of that branch. So a set of positions that
   * holds a key of every branch, with a discriminator's position, is a key of the
   * union; without a discriminator the union has none.
   */
  private positionalUnionKeys(
    node: ExplainPlanNode,
    branches: ExplainPlanNode[],
    scope: Scope
  ): NodeKey[] {
    if (branches.length === 0) return []
    const width = branches[0]?.Output?.length ?? 0
    if (branches.some((branch) => branch.Output?.length !== width)) return []
    const discriminators: number[] = []
    for (let at = 0; at < width; at++) {
      const literals = branches.map((branch) => branch.Output?.[at] ?? '')
      const bodies = literals.map((literal) => TEXT_LITERAL.exec(literal)?.[1])
      if (!bodies.every((body) => body !== undefined)) continue
      if (new Set(bodies).size !== bodies.length) continue
      discriminators.push(at)
    }
    if (discriminators.length === 0) return []

    let combined: string[][] | null = null
    for (const branch of branches) {
      const positions = this.positionsIn(branch)
      const branchKeys: string[][] = []
      for (const key of this.keysOf(branch, scope)) {
        if (key.pinOnly) continue
        const mapped = key.elements.map((value) => positions.get(value))
        if (mapped.some((at) => at === undefined)) continue
        branchKeys.push((mapped as number[]).map(position))
      }
      if (branchKeys.length === 0) return []
      if (combined === null) {
        combined = branchKeys
        continue
      }
      const next: string[][] = []
      for (const held of combined) {
        for (const key of branchKeys) next.push([...new Set([...held, ...key])])
      }
      combined = minimal(next.map((elements) => makeKey(elements))).map((key) => key.elements)
    }
    const keys: NodeKey[] = []
    for (const held of combined ?? []) {
      for (const at of discriminators) {
        const elements = [...held, position(at)]
        keys.push(makeKey(elements, { discriminators: [position(at)] }))
      }
    }
    return minimal(keys)
  }

  /**
   * The equalities that hold of every row one input of a join emits, and the renames
   * a crossed boundary inside it makes. Left out: whatever stands on the nulled side
   * of an outer join inside the input, the join condition of an outer, semi or anti
   * join inside it — either holds only of the rows that matched — the branches of a
   * union, each of which holds of its own rows only, the arms of a `BitmapOr`, and the
   * input of a grouping, whose rows are not the rows it emits.
   */
  private collectEqualities(root: ExplainPlanNode, found: [string, string][]): void {
    const visit = (node: ExplainPlanNode): void => {
      const joinType = node['Join Type']
      const outerJoin = joinType !== undefined && joinType !== 'Inner'
      for (const field of CONDITION_FIELDS) {
        const condition = node[field]
        if (typeof condition !== 'string') continue
        if (outerJoin && (JOIN_CONDITION_FIELDS as readonly string[]).includes(field)) continue
        found.push(...conditionEqualities(condition, this.context))
      }
      if (this.context.unioning.has(node['Node Type'])) return
      if (node['Node Type'] === 'BitmapOr') return
      if (COLLAPSING_NODE_TYPES.has(node['Node Type'])) return
      if (node['Node Type'] === 'Subquery Scan' && node.Alias !== undefined) {
        const crossed = this.context.crossed.get(node.Alias)
        if (crossed && !crossed.branches) {
          for (const [at, entry] of (crossed.selectList.Output ?? []).entries()) {
            const inner = this.bareElement(entry)
            const column = crossed.view.columns[at]
            if (inner !== null && column !== undefined) {
              found.push([element(node.Alias, column), inner])
            }
          }
        }
      }
      const nulled = joinType === undefined ? new Set<string>() : this.context.nulledSides(joinType)
      for (const child of this.context.inputs(node)) {
        if (nulled.has(child['Parent Relationship'] ?? 'Outer')) continue
        visit(child)
      }
    }
    visit(root)
  }

  /**
   * The aliases whose columns a row of `root` fixes: not those inside a grouping, whose
   * rows it collapsed, nor those of a semi or anti join's side it does not emit.
   */
  private aliasesIn(root: ExplainPlanNode): Set<string> {
    const aliases = new Set<string>()
    const visit = (node: ExplainPlanNode): void => {
      if (node.Alias !== undefined) aliases.add(node.Alias)
      if (COLLAPSING_NODE_TYPES.has(node['Node Type'])) return
      const unemitted = UNEMITTED_SIDE.get(node['Join Type'] ?? '')
      for (const child of this.context.inputs(node)) {
        if (unemitted !== undefined && (child['Parent Relationship'] ?? 'Outer') === unemitted) {
          continue
        }
        visit(child)
      }
    }
    visit(root)
    return aliases
  }

  /**
   * The node under a join's own machinery that holds the rows it joins, and whether a
   * `Gather` stood on the way.
   */
  private joined(node: ExplainPlanNode): { node: ExplainPlanNode; inWorker: boolean } {
    let current = node
    let inWorker = false
    for (let step = 0; step < 16; step++) {
      if (!JOIN_INPUT_NODE_TYPES.has(current['Node Type'])) break
      const inputs = this.context.inputs(current)
      const only = inputs.length === 1 ? inputs[0] : undefined
      if (!only) break
      if (GATHER_NODE_TYPES.has(current['Node Type'])) inWorker = true
      current = only
    }
    return { node: current, inWorker }
  }

  /**
   * The row sources an input of a join is made of: the inputs of the inner joins it
   * is built of, down to whatever is not one — a scan, an outer join, a crossed view.
   * The inner joins themselves are returned too, for the conditions they print.
   */
  private innerBlock(node: ExplainPlanNode): {
    sources: { node: ExplainPlanNode; inWorker: boolean }[]
    joins: ExplainPlanNode[]
  } {
    const sources: { node: ExplainPlanNode; inWorker: boolean }[] = []
    const joins: ExplainPlanNode[] = []
    const visit = (input: ExplainPlanNode, inWorker: boolean): void => {
      const reached = this.joined(input)
      const worker = inWorker || reached.inWorker
      if (reached.node['Join Type'] === 'Inner') {
        joins.push(reached.node)
        for (const child of this.context.inputs(reached.node)) visit(child, worker)
        return
      }
      sources.push({ node: reached.node, inWorker: worker })
    }
    visit(node, false)
    return { sources, joins }
  }

  private sourcesOf(
    block: { sources: { node: ExplainPlanNode; inWorker: boolean }[] },
    scope: Scope
  ): { aliases: ReadonlySet<string>; keys: NodeKey[] }[] {
    return block.sources.map((source) => ({
      aliases: this.aliasesIn(source.node),
      keys: this.keysOf(source.node, {
        ...scope,
        inWorker: scope.inWorker || source.inWorker
      })
    }))
  }

  /**
   * Which row sources are determined by `seed` — the rows of the sources already
   * known and the aliases already known — through the equalities: a source is
   * determined once every column of one of its keys is equated to a known column or
   * to a literal, and then every column of it is known.
   */
  private closure(
    sources: { aliases: ReadonlySet<string>; keys: NodeKey[] }[],
    known: ReadonlySet<number>,
    knownAliases: ReadonlySet<string>,
    equalities: Equalities
  ): Set<number> {
    const { classes, members, partners } = equalities
    const determined = new Set(known)
    const aliases = new Set(knownAliases)
    for (const index of determined) {
      for (const alias of sources[index]?.aliases ?? []) aliases.add(alias)
    }
    const isKnownColumn = (value: string): boolean =>
      (members.get(classes.find(value)) ?? [value]).some((member) => {
        if (member === CONSTANT) return true
        const alias = aliasOf(member)
        return alias !== null && aliases.has(alias)
      })
    // An expression is known where it is equated, directly, to something known.
    const isKnown = (value: string): boolean =>
      value.startsWith(EXPRESSION)
        ? (partners.get(value) ?? []).some(isKnownColumn)
        : isKnownColumn(value)
    let grew = true
    while (grew) {
      grew = false
      for (const [index, source] of sources.entries()) {
        if (determined.has(index)) continue
        if (!source.keys.some((key) => key.elements.every(isKnown))) continue
        determined.add(index)
        for (const alias of source.aliases) aliases.add(alias)
        grew = true
      }
    }
    return determined
  }

  private equalityClasses(joins: ExplainPlanNode[], inputs: ExplainPlanNode[]): Equalities {
    const equalities: [string, string][] = []
    for (const join of joins) {
      for (const field of CONDITION_FIELDS) {
        const condition = join[field]
        if (typeof condition === 'string') {
          equalities.push(...conditionEqualities(condition, this.context))
        }
      }
    }
    for (const input of inputs) this.collectEqualities(input, equalities)
    const classes = new UnionFind()
    const partners = new Map<string, string[]>()
    for (const [left, right] of equalities) {
      const [expressionSide, other] = left.startsWith(EXPRESSION)
        ? [left, right]
        : right.startsWith(EXPRESSION)
          ? [right, left]
          : [null, null]
      if (expressionSide === null || other === null) {
        classes.union(left, right)
        continue
      }
      const seen = partners.get(expressionSide)
      if (seen) seen.push(other)
      else partners.set(expressionSide, [other])
    }
    return { classes, members: classes.members(), partners }
  }

  /**
   * The keys of a block of inner joins, whatever order the planner joined its row
   * sources in: a set of sources whose rows determine every other source's through
   * the equalities is a key when one key of each of them is taken together. Read
   * over the whole block at once, because a join order that first pairs two sources
   * with nothing between them — a genetic join order does — would otherwise lose a
   * dependency the next join restores.
   */
  private blockKeys(node: ExplainPlanNode, scope: Scope): NodeKey[] {
    const block = this.innerBlock(node)
    const equalities = this.equalityClasses(
      block.joins,
      block.sources.map((source) => source.node)
    )
    const sources = this.sourcesOf(block, scope)
    const seedable = [...sources.keys()].filter((index) =>
      sources[index]?.keys.some((key) => !key.pinOnly)
    )
    const covers: number[][] = []
    const limit = Math.min(RELATIONS_PER_KEY, seedable.length)
    const visitSubsets = (size: number, start: number, chosen: number[]): void => {
      if (chosen.length === size) {
        if (covers.some((cover) => cover.every((index) => chosen.includes(index)))) return
        const determined = this.closure(sources, new Set(chosen), new Set(), equalities)
        if (determined.size === sources.length) covers.push([...chosen])
        return
      }
      for (let at = start; at < seedable.length; at++) {
        visitSubsets(size, at + 1, [...chosen, seedable[at] as number])
      }
    }
    for (let size = 1; size <= limit; size++) visitSubsets(size, 0, [])

    const keys: NodeKey[] = []
    for (const cover of covers) {
      let combined: NodeKey[] = [makeKey([])]
      for (const index of cover) {
        const own = (sources[index]?.keys ?? []).filter((key) => !key.pinOnly)
        const next: NodeKey[] = []
        for (const held of combined) {
          for (const key of own) {
            next.push(
              cover.length === 1
                ? key
                : makeKey([...held.elements, ...key.elements], {
                    discriminators: [...held.discriminators, ...key.discriminators]
                  })
            )
          }
        }
        combined = minimal(next)
      }
      keys.push(...combined)
    }
    return minimal(keys)
  }

  private joinKeys(node: ExplainPlanNode, scope: Scope): NodeKey[] {
    const below: Scope = { ...scope, underJoin: true }
    const joinType = node['Join Type'] ?? ''
    if (joinType === 'Inner') return this.blockKeys(node, below)
    const inputs = this.context.inputs(node)
    const outer = inputs.find((child) => (child['Parent Relationship'] ?? 'Outer') === 'Outer')
    const inner = inputs.find((child) => child['Parent Relationship'] === 'Inner')
    if (!outer || !inner || inputs.length !== 2) return []
    const carriedFrom = (side: ExplainPlanNode): NodeKey[] =>
      this.keysOf(side, below).filter((key) => !key.pinOnly)
    switch (joinType) {
      case 'Semi':
      case 'Anti':
        return carriedFrom(outer)
      case 'Right Semi':
      case 'Right Anti':
        return carriedFrom(inner)
      case 'Left':
        return this.uniqueGiven(node, outer, inner, below) ? carriedFrom(outer) : []
      case 'Right':
        return this.uniqueGiven(node, inner, outer, below) ? carriedFrom(inner) : []
      default:
        return []
    }
  }

  /**
   * Whether every row of `kept` meets at most one row of `other` across `join`: the
   * rows of every source `other` is made of are determined by a row of `kept`.
   */
  private uniqueGiven(
    join: ExplainPlanNode,
    kept: ExplainPlanNode,
    other: ExplainPlanNode,
    scope: Scope
  ): boolean {
    const block = this.innerBlock(other)
    const equalities = this.equalityClasses(
      [join, ...block.joins],
      [kept, ...block.sources.map((source) => source.node)]
    )
    const sources = this.sourcesOf(block, scope)
    const determined = this.closure(sources, new Set(), this.aliasesIn(kept), equalities)
    return determined.size === sources.length
  }
}

/**
 * Every key the plan proves for the view, in terms of the view's column positions.
 * `selectList` is the node that carries the view's select list: the root, or what
 * stands under the pass-through nodes above it.
 */
export function readPlanKeys(
  root: ExplainPlanNode,
  selectList: ExplainPlanNode,
  context: KeyReadingContext
): PlanKey[] {
  const reader = new KeyReader(context)
  const union = context.unioning.has(selectList['Node Type'])
  const keys = union
    ? reader.keysOf(selectList, {
        inWorker: gatherAbove(root, selectList, context),
        underJoin: false
      })
    : reader.keysOf(root, { inWorker: false, underJoin: false })
  const positions = union ? new Map<string, number>() : reader.positionsIn(selectList)
  const at = (value: string): number | undefined =>
    union ? Number(value.slice(1)) : positions.get(value)

  const found: PlanKey[] = []
  for (const key of keys) {
    if (key.elements.length === 0 || key.pinOnly) continue
    const mapped = key.order.map(at)
    if (mapped.some((index) => index === undefined)) continue
    const columns = key.carried
      ? (mapped as number[])
      : [...new Set(mapped as number[])].sort((left, right) => left - right)
    const discriminators = key.discriminators
      .map(at)
      .filter((index): index is number => index !== undefined)
      .sort((left, right) => left - right)
    found.push({ columns, carried: key.carried, discriminators })
  }
  return found
}
