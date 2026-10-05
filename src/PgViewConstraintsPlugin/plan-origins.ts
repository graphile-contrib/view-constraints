// Where a view column comes from, read off the planner's own answer.
//
// `EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) SELECT <columns> FROM <view>` prints,
// on every plan node, the `Output` list of the expressions that node emits, in the
// same order as the query's select list. On a relation scan node it also prints
// `Schema`, `Relation Name` and `Alias`, which is what binds the `alias.column`
// spelling in an `Output` entry to a real catalog relation.
//
// Which plan comes back is the planner's judgement of cost, and that judgement moves
// with the statistics, with how many workers it may use and with every `enable_*`
// switch. What this reader answers must not: a derivation that moved with the plan
// would publish one contract against the empty database a schema is generated from
// and another against production. So the nodes that merely hand their child's select
// list on are stepped over rather than read (`PASS_THROUGH_NODE_TYPES`), and every
// reading that would have depended on the planner being generous is refused instead —
// deterministically, on a property of the query rather than of the day's plan.
// `invariance.ts` is the proof.
//
// This module is the reader of that answer and nothing else: it turns one plan into
// the sources of one requested column each, or a named refusal where the plan does
// not say. It never guesses. Which sets of those columns the plan proves unique is
// the other question the same plan answers, and `plan-keys.ts` reads it.
//
// A column is a *proxy* of a base column when its value in every row is either that
// base column's value or NULL — the criterion this reader implements. A bare
// reference is one. So is a bare reference under a cast, but only the catalog can
// say whether that cast leaves the value alone, so the types the value passed
// through are recorded here (`coerced`, `via`) and judged in `derive.ts`. A `UNION`
// branch that contributes only a NULL literal contributes no value at all, and drops
// out.
//
// The plan also answers the second half of "the base column's value or NULL": which
// of the two halves is still open. A scan standing on the nulled side of an outer
// join hands out a row of NULLs where nothing matched, and a `UNION` branch spelling
// a NULL literal writes one directly; `GROUP BY ROLLUP` and its kin add a
// superaggregate row in which the grouping columns are NULL. Where none of that
// stands over a column, the plan leaves it exactly as its base column, and
// `derive.ts` may ask `pg_attribute.attnotnull` whether that is never NULL. The plan
// is asked only about its own shape: no expression in it is examined, so a column
// made non-null by `COALESCE` or by a strict function reads here as nullable like any
// other; what the plan's qualifiers reject — `IS NOT NULL`, a strict equality — is
// read by `plan-qualifiers.ts` and recorded on the origin.

import { readPlanKeys } from './plan-keys.ts'
import type { PlanKey, UniqueKeysOf } from './plan-keys.ts'
import { qualifiedReference, readQualifiedNonNull } from './plan-qualifiers.ts'
import type { QualifierCatalog } from './plan-qualifiers.ts'
import { evaluateExpression, parseExpression } from './plan-expressions.ts'
import type { ExpressionNullability } from './plan-expressions.ts'

/** What the catalog answers for the plan: the keys a relation has, the qualifiers
 * a scan applies without printing them, and what the expression rules ask. */
export interface PlanCatalog extends QualifierCatalog {
  uniqueKeysOf: UniqueKeysOf
  /** Whether a base column of a catalog relation is NOT NULL in `pg_attribute`. */
  columnNotNull: (schema: string, relation: string, column: string) => boolean | undefined
  /**
   * Built-in spellings a user-defined function or operator has taken over, so the
   * non-nullness rule that spelling carries does not hold in this database.
   */
  shadowedNames: ReadonlySet<string>
  /**
   * Each `WITH` query of this view's defining query, by name, and its column names in
   * select-list order — the map a `CTE Scan` reads a column by. Read from the view's
   * stored rewrite tree (`view-tree.ts`); empty where it could not be read, which
   * leaves a `CTE Scan` refused as before.
   */
  cteColumns: ReadonlyMap<string, string[]>
}

/** One plan node of `EXPLAIN (FORMAT JSON)`, as much of it as this reader uses. */
export interface ExplainPlanNode {
  'Node Type': string
  Output?: string[]
  Plans?: ExplainPlanNode[]
  Schema?: string
  'Relation Name'?: string
  Alias?: string
  /** `Inner`, `Left`, `Right`, `Full`, `Semi`, `Anti` on a join node. */
  'Join Type'?: string
  /** Which input of its parent this node is: `Outer`, `Inner`, `InitPlan`, `SubPlan`. */
  'Parent Relationship'?: string
  /** Present on an `Aggregate` computing `GROUPING SETS` / `ROLLUP` / `CUBE`. */
  'Grouping Sets'?: unknown
  /** The grouping of an `Aggregate` or a `Group`, one expression per entry. */
  'Group Key'?: string[]
  /** `Simple`, or `Partial` / `Finalize` for an aggregate split across workers. */
  'Partial Mode'?: string
  /** On a `CTE Scan`: the `WITH` query it reads. */
  'CTE Name'?: string
  /** On the subplan computing a `WITH` query: `CTE <name>`. */
  'Subplan Name'?: string
  /** The index an index scan reads, whose predicate may stand in for a qualifier. */
  'Index Name'?: string
  // The conditions a node applies, where `plan-keys.ts` and `plan-qualifiers.ts` read
  // what they state.
  'Hash Cond'?: string
  'Merge Cond'?: string
  'Join Filter'?: string
  Filter?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  'TID Cond'?: string
}

/**
 * A view the reader may descend through, as the catalog describes it: the column
 * names in attribute order are the positions of its select list, which is the map the
 * plan does not print and this reader needs to cross the boundary.
 */
export interface ViewShape {
  schema: string
  name: string
  /** Column names in `attnum` order. */
  columns: string[]
}

/**
 * Why the plan as a whole could not be read. Closed on purpose: a view that derives
 * nothing says which of these it is, so that "nothing was derived" is never confused
 * with "nothing was looked at", and so that every one of them can carry a case in
 * `__tests__/PgViewConstraintsPlugin.lab.sql`.
 */
export const PLAN_REFUSALS = {
  'unreadable-set-operation':
    'a `Recursive Union`: its input is one tagged stream that references its own ' +
    'output, and there is no branch to read a column off',
  'set-operation-not-a-select-list':
    'a set operation’s branches cannot be told apart — a column of a branch is ' +
    'spelled the same as a column of another, as when a set operation stands over ' +
    'another, or a branch has no select list to read position by position',
  'output-not-positional':
    'the node carrying the select list prints no `Output`, or one that does not line ' +
    'up one-to-one with the view’s columns'
} as const

export type PlanRefusal = keyof typeof PLAN_REFUSALS

/**
 * Why one column of an otherwise readable plan has no source. Closed for the same
 * reason as `PLAN_REFUSALS`, and every one of them carries a lab case.
 */
export const COLUMN_REFUSALS = {
  'not-a-column-reference':
    'the entry is an expression, an aggregate, a constant, an operator, a subplan ' +
    'reference, a whole-row reference or a second cast — not a reference to a column',
  'unqualified-name-without-a-sole-relation':
    'the entry names a column with no prefix while the plan does not read exactly one ' +
    'relation, so which row source it belongs to is not said',
  'no-value-from-any-branch':
    'every reading of the column is a NULL literal, so no base column contributes a ' +
    'value to it',
  'through-a-materialized-with':
    'the entry is spelled with a materialized `WITH` query’s own column name, and the ' +
    'map from those names to the positions of its select list — read from the view’s ' +
    'stored rewrite tree — is not at hand',
  'through-an-unpinned-subquery':
    'the entry is spelled with the alias of a `Subquery Scan` the catalog does not pin ' +
    'to one view this relation is built on — a set operation’s own branch ' +
    '(`*SELECT* 3`), an inline `FROM (SELECT …) x`, or a source view whose alias the ' +
    'stored tree does not resolve — or one whose child does not print that view’s ' +
    'select list entry for entry',
  'through-a-row-source-the-catalog-does-not-name':
    'the entry is spelled with an alias that is not a relation scan — a function ' +
    'scan, a `VALUES` list, or a scan the plan does not carry at all because a ' +
    'constant-false qualifier removed it',
  'cast-not-value-preserving':
    'the value passed through a cast that builds a new datum or narrows it, so it is ' +
    'no longer the base column’s value'
} as const

export type ColumnRefusal = keyof typeof COLUMN_REFUSALS

/** A view column value that is a bare reference to `schema.relation.column`. */
export interface ColumnOrigin {
  schema: string
  relation: string
  /**
   * The plan's name for the scan instance the value was read from. Two columns of
   * one composite key must share it.
   */
  alias: string
  column: string
  /**
   * The reference stood under a cast. Whether the cast leaves the value alone is a
   * question for `pg_cast` and the two column types, not for the plan text.
   */
  coerced: boolean
  /**
   * The view columns the value passed through on its way up, innermost first. Each
   * is a step whose types `derive.ts` must find value-preserving: a barrier view that
   * truncates a column and a view over it that casts the truncation back to the base
   * type would otherwise read as the base column itself.
   */
  via: { schema: string; relation: string; column: string }[]
  /**
   * The scan this value was read from stands on the nulled side of an outer join, so
   * the plan itself can hand out a NULL here whatever the base column promises.
   */
  nullExtended: boolean
  /**
   * A qualifier of the plan rejects a NULL in this reference in every row it reaches
   * the view in — `IS NOT NULL`, or a strict equality; see `plan-qualifiers.ts`.
   * Set after the reading, over every stream a union assembled the value from.
   */
  qualifiedNonNull: boolean
}

/**
 * What one requested column is made of.
 *
 * `null` — the plan does not say. One entry — the column proxies that base column.
 * Several — a `UNION` whose branches proxy different base columns; the column is one
 * of them per row, so only a relation every one of them authorises is true of it.
 */
export type ColumnSources = ColumnOrigin[] | null

// A node that unions tuple streams. The rows above it come from several branches
// while the `Output` above it is spelled with the Vars of one branch only, so a node
// that projects over a union reads exactly like one over a single scan — which is why
// the branches are read position by position: `Append`/`Merge Append` for a
// `UNION ALL` (and an inheritance scan), `SetOp`/`HashSetOp` for `UNION`,
// `INTERSECT` and `EXCEPT`. Each branch prints the set operation's columns in its own
// order, and the column at a position of the union is the column at that position of
// whichever branch a row came from.
const SET_OPERATION_NODE_TYPES = new Set(['Append', 'Merge Append', 'SetOp', 'HashSetOp'])

// The set-operation nodes whose branches the key reader walks positionally to build
// a key of the union: a `UNION ALL` and an inheritance scan. A `SetOp`/`HashSetOp`
// de-duplicates or filters and names no key by position, so its keys are not read.
const TUPLE_UNIONING_NODE_TYPES = new Set(['Append', 'Merge Append'])

// Nodes that hand their child's select list on and say nothing of their own.
//
// Which of these stands over the plan is the planner's judgement of cost, not a
// property of the view: the same `UNION ALL` plans as `Append` at the root when the
// planner costs it serially and as `Gather` over a parallel `Append` when it does
// not, as `MergeAppend` or as `Sort` over `Append` depending on which it thinks
// cheaper, and the same `select id, code::text from t` plans as a bare scan or as a
// `Gather` over one. A reader that answered differently under each would publish a
// different contract against an empty CI database than against production, so it
// reads through them to the node that really carries the select list.
//
// Every node type here builds its target list as its child's, entry for entry —
// `make_sort`, `make_limit`, `make_material`, `make_memoize` and `make_lockrows`
// assign `lefttree->targetlist` outright, and `create_gather_plan` /
// `create_gather_merge_plan` demand the exact target list from the child. So stepping
// over one changes no position and drops no column, while two things that are only
// noise are left behind: over a union, an `Output` spelled in the vocabulary of one
// branch out of several, and over anything, the extra parentheses EXPLAIN puts round
// an expression it resolves through a node — `((t.code)::text)` at a `Gather` for the
// `(t.code)::text` the scan under it prints.
//
// `Unique` copies its child's target list the same way and is deliberately NOT here.
// De-duplication has two implementations — `Unique` over a `Sort`, and a hashed
// `Aggregate` grouping by every column — and the planner picks between them by cost.
// `Aggregate` computes and so can never be stepped over; accepting `Unique` would
// make a `SELECT DISTINCT` over a `UNION` readable under one of the two and refused
// under the other. Refusing both is the answer that does not move.
const PASS_THROUGH_NODE_TYPES = new Set([
  'Gather',
  'Gather Merge',
  'Sort',
  'Incremental Sort',
  'Limit',
  'Materialize',
  'Memoize',
  'LockRows'
])

const SUBQUERY_SCAN = 'Subquery Scan'
const CTE_SCAN = 'CTE Scan'

// The children of a node that are its input, as opposed to an `InitPlan` or a
// `SubPlan` computed beside it.
function inputChildren(node: ExplainPlanNode): ExplainPlanNode[] {
  return (node.Plans ?? []).filter((child) => {
    const relationship = child['Parent Relationship'] ?? 'Outer'
    return relationship !== 'InitPlan' && relationship !== 'SubPlan'
  })
}

/**
 * The node of this plan that really carries the view's select list: the root, or
 * whatever stands under the pass-through nodes above it.
 */
function selectListNodeOf(root: ExplainPlanNode): ExplainPlanNode {
  let node = root
  for (let step = 0; step < 16; step++) {
    if (!PASS_THROUGH_NODE_TYPES.has(node['Node Type'])) return node
    const children = inputChildren(node)
    const only = children.length === 1 ? children[0] : undefined
    if (!only) return node
    // A `Gather` can project after all: a select-list subplan a worker may not run is
    // computed at the `Gather`, whose `Output` then carries an entry its child does
    // not. The node that prints the select list is the one to read.
    if (node.Output && only.Output && node.Output.length !== only.Output.length) return node
    node = only
  }
  return node
}

// A recursive `WITH` reads one tagged stream that references its own output, so a
// column cannot be traced to a branch. No other set operation is refused here: the
// branches of an `Append`, a `SetOp` and their kin are read position by position.
const UNREADABLE_SET_NODE_TYPES = new Set(['Recursive Union'])

// Which input of a join the join itself can null. `Left` keeps every row of its outer
// input and writes NULLs into the inner one where nothing matched; `Right` is the
// mirror; `Full` does both. Getting this backwards would declare a column NOT NULL on
// exactly the side the emptiness arrives from, so it is read off the plan's own
// `Join Type` and `Parent Relationship` rather than off the view's text — which is
// also what keeps the good case: the planner folds an outer join into an inner one
// when a strict qualifier makes the null-extended rows impossible, and then the plan
// says `Inner` and the column is non-null however the view spelled it.
//
// `Semi` and `Anti` emit no column of their inner input at all, and `Right Semi` and
// `Right Anti` none of their outer one; that input is listed here so that an entry
// appearing in one all the same is read as nullable rather than trusted, and the side
// they emit is left alone — the planner turns one into the other by cost. A join type
// this map does not know nulls both sides.
const JOIN_TYPE_NULLED_SIDES = new Map<string, ReadonlySet<string>>([
  ['Inner', new Set()],
  ['Left', new Set(['Inner'])],
  ['Right', new Set(['Outer'])],
  ['Full', new Set(['Outer', 'Inner'])],
  ['Semi', new Set(['Inner'])],
  ['Anti', new Set(['Inner'])],
  ['Right Semi', new Set(['Outer'])],
  ['Right Anti', new Set(['Outer'])]
])
const BOTH_JOIN_SIDES: ReadonlySet<string> = new Set(['Outer', 'Inner'])

// The two `Parent Relationship` values that make a child an input of the join above
// it. A child that is an `InitPlan` or a `SubPlan` is computed beside the join, not
// joined by it, and no outer join nulls it.
const JOIN_INPUT_RELATIONSHIPS: ReadonlySet<string> = new Set(['Outer', 'Inner'])

/**
 * Every scan instance, by alias, that stands on the nulled side of an outer join
 * somewhere between itself and the root of the plan — and every plan node,
 * computed columns included, that stands on one.
 *
 * An alias reached on a nulled path anywhere is nulled everywhere it is read: two
 * scan instances the plan gave one name are not told apart here, and the side that
 * loses is the claim of non-nullness. The nodes are the same answer for the
 * expressions a node prints: a `count(*)` computed below an outer join is NULL in
 * every row the join padded, whatever `count` promises about the rows it counted.
 */
function nullExtendedIn(root: ExplainPlanNode): {
  aliases: Set<string>
  nodes: Set<ExplainPlanNode>
} {
  const aliases = new Set<string>()
  const nodes = new Set<ExplainPlanNode>()
  const visit = (node: ExplainPlanNode, underNull: boolean): void => {
    if (underNull) {
      nodes.add(node)
      if (node.Alias !== undefined) aliases.add(node.Alias)
    }
    const joinType = node['Join Type']
    const nulledSides =
      joinType === undefined ? undefined : (JOIN_TYPE_NULLED_SIDES.get(joinType) ?? BOTH_JOIN_SIDES)
    for (const child of node.Plans ?? []) {
      const relationship = child['Parent Relationship'] ?? ''
      const nulledHere =
        nulledSides !== undefined &&
        JOIN_INPUT_RELATIONSHIPS.has(relationship) &&
        nulledSides.has(relationship)
      visit(child, underNull || nulledHere)
    }
  }
  visit(root, false)
  return { aliases, nodes }
}

// `quote_identifier` spelling: either a bare lower-case identifier, or a
// double-quoted one in which an embedded quote is doubled.
const IDENTIFIER = String.raw`(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")*")`
const QUALIFIED_REFERENCE = new RegExp(`^(${IDENTIFIER})\\.(${IDENTIFIER})$`)
// `(alias.column)::type` — the deparser always parenthesises the cast's argument.
const COERCED_REFERENCE = new RegExp(`^\\((${IDENTIFIER})\\.(${IDENTIFIER})\\)::.+$`)
// A query with one range table entry has nothing to disambiguate, so `EXPLAIN`
// prints its columns unqualified. That is the ordinary shape of a materialized
// view's defining query, and of nothing else this reader meets.
const UNQUALIFIED_REFERENCE = new RegExp(`^(${IDENTIFIER})$`)
const UNQUALIFIED_COERCED_REFERENCE = new RegExp(`^\\((${IDENTIFIER})\\)::.+$`)
// A branch of a `UNION` that contributes no value: the column is NULL in its rows.
const NULL_LITERAL = /^NULL(?:::.+)?$/

function unquote(identifier: string): string {
  if (!identifier.startsWith('"')) return identifier
  return identifier.slice(1, -1).replaceAll('""', '"')
}

/**
 * Parses one `Output` entry that must be a reference to a column, optionally under
 * one cast. Anything else — an operator, a function call, a constant, a nested cast,
 * a subplan reference, a whole-row `alias.*` — is not a column reference and yields
 * `null`.
 */
export function parseReference(
  entry: string
): { alias: string | null; column: string; coerced: boolean } | null {
  const bare = QUALIFIED_REFERENCE.exec(entry)
  if (bare?.[1] !== undefined && bare[2] !== undefined) {
    return { alias: unquote(bare[1]), column: unquote(bare[2]), coerced: false }
  }
  const coerced = COERCED_REFERENCE.exec(entry)
  if (coerced?.[1] !== undefined && coerced[2] !== undefined) {
    return { alias: unquote(coerced[1]), column: unquote(coerced[2]), coerced: true }
  }
  const unqualified = UNQUALIFIED_REFERENCE.exec(entry)
  if (unqualified?.[1] !== undefined) {
    return { alias: null, column: unquote(unqualified[1]), coerced: false }
  }
  const unqualifiedCoerced = UNQUALIFIED_COERCED_REFERENCE.exec(entry)
  if (unqualifiedCoerced?.[1] !== undefined) {
    return { alias: null, column: unquote(unqualifiedCoerced[1]), coerced: true }
  }
  return null
}

function walk(node: ExplainPlanNode, visit: (node: ExplainPlanNode) => void): void {
  visit(node)
  for (const child of node.Plans ?? []) walk(child, visit)
}

function countNodes(root: ExplainPlanNode, predicate: (node: ExplainPlanNode) => boolean): number {
  let count = 0
  walk(root, (node) => {
    if (predicate(node)) count += 1
  })
  return count
}

function collectNodes(
  root: ExplainPlanNode,
  predicate: (node: ExplainPlanNode) => boolean
): ExplainPlanNode[] {
  const found: ExplainPlanNode[] = []
  walk(root, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

/**
 * Every relation scan in the plan, by the alias its `Output` entries are spelled
 * with. An alias bound to two different relations is dropped rather than guessed;
 * PostgreSQL renames colliding range-table entries before printing, so this is
 * insurance, not a code path we expect to take.
 */
export function scanAliases(
  root: ExplainPlanNode
): Map<string, { schema: string; relation: string }> {
  const found = new Map<string, { schema: string; relation: string }>()
  const ambiguous = new Set<string>()
  walk(root, (node) => {
    const alias = node.Alias
    const schema = node.Schema
    const relation = node['Relation Name']
    if (alias === undefined || schema === undefined || relation === undefined) return
    const existing = found.get(alias)
    if (existing && (existing.schema !== schema || existing.relation !== relation)) {
      ambiguous.add(alias)
      return
    }
    found.set(alias, { schema, relation })
  })
  for (const alias of ambiguous) found.delete(alias)
  return found
}

/** Every alias-bearing node, by alias, so an alias that is not a relation still has a kind. */
function aliasNodeTypes(root: ExplainPlanNode): Map<string, string> {
  const kinds = new Map<string, string>()
  walk(root, (node) => {
    if (node.Alias !== undefined && !kinds.has(node.Alias)) kinds.set(node.Alias, node['Node Type'])
  })
  return kinds
}

// The name a `CTE Scan` prints for the query it reads: `Subplan Name` is `CTE <name>`
// on the subplan that computes the query, and `CTE Name` is where a scan says which
// query it reads.
const CTE_SUBPLAN_PREFIX = 'CTE '

/** The subplan computing each `WITH` query, by the query's name. */
function cteSubplansIn(root: ExplainPlanNode): Map<string, ExplainPlanNode> {
  const subplans = new Map<string, ExplainPlanNode>()
  walk(root, (node) => {
    const name = node['Subplan Name']
    if (typeof name === 'string' && name.startsWith(CTE_SUBPLAN_PREFIX)) {
      const cte = name.slice(CTE_SUBPLAN_PREFIX.length)
      if (!subplans.has(cte)) subplans.set(cte, node)
    }
  })
  return subplans
}

/** The `WITH` query each `CTE Scan` alias reads, by alias. */
function cteAliasesIn(root: ExplainPlanNode): Map<string, string> {
  const aliases = new Map<string, string>()
  walk(root, (node) => {
    if (
      node['Node Type'] === CTE_SCAN &&
      node.Alias !== undefined &&
      node['CTE Name'] !== undefined
    ) {
      aliases.set(node.Alias, node['CTE Name'])
    }
  })
  return aliases
}

/**
 * A `Subquery Scan` this reader may descend through, and the node under it that
 * carries the crossed view's select list.
 *
 * PostgreSQL leaves a `Subquery Scan` where it could not flatten a view into the
 * query above it — which is every security-barrier view whose columns the query above
 * narrows, and therefore the shape of every layered surface projection in this
 * repository. The node prints its alias and spells its `Output` with the inner view's
 * own column names, and nothing else: no schema, no relation name, and no map from
 * those names to positions. The catalog holds that map, because a view's columns in
 * `attnum` order *are* the positions of its select list, and the plan can be checked
 * against it — the child of such a node prints the inner view's select list entry for
 * entry, the columns nobody above asked for replaced by NULL constants but never
 * dropped, so the entry count must equal the view's column count or this is not that
 * view.
 */
interface CrossableSubquery {
  view: ViewShape
  /** The node under the `Subquery Scan` that carries the inner view's select list. */
  selectList: ExplainPlanNode
  /** When that node is a union, its branches; each prints the whole select list. */
  branches: ExplainPlanNode[] | null
}

/** One branch of a set operation: the node printing its select list, and the entries. */
interface UnionBranch {
  node: ExplainPlanNode
  output: string[]
}

/** One column of a set operation, and the branches whose value it is. */
interface UnionColumn {
  branches: UnionBranch[]
  /** The position of the column in every branch's select list. */
  position: number
}

/**
 * Every column of every set operation whose branches can be told apart, by the
 * `Output` entry an enclosing node spells it with.
 *
 * A node above a set operation prints the Vars of one branch, so a column of the union
 * appears there as that branch's own expression; the position of that expression in
 * the branch's select list is the union's column. The branches are told apart by their
 * scan aliases, which name one range-table entry each; where the same spelling would
 * name a column of two different set operations — a set operation over another — there
 * is no one branch to read the column off, and the plan is refused rather than guessed
 * between them. A set operation inside a view this reader crosses is read by the cross
 * itself and left out here.
 */
function unionColumnsOf(
  root: ExplainPlanNode,
  crossable: ReadonlyMap<string, CrossableSubquery>
): { columns: Map<string, UnionColumn>; aliases: Set<string>; ambiguous: boolean } {
  const columns = new Map<string, UnionColumn>()
  const aliases = new Set<string>()
  let ambiguous = false

  const branchesOf = (node: ExplainPlanNode): UnionBranch[] | null => {
    const branches = inputChildren(node).map((child) => {
      const list = selectListNodeOf(child)
      return { node: list, output: list.Output ?? [] }
    })
    if (branches.length < 2) return null
    const width = branches[0]?.output.length ?? 0
    if (width === 0) return null
    // A branch that prints a shorter list than the first is not the set operation's
    // columns in the same order, and nothing may be read off it positionally.
    if (branches.some((branch) => branch.output.length !== width)) return null
    return branches
  }

  const visit = (node: ExplainPlanNode, insideCrossing: boolean): void => {
    if (!insideCrossing && SET_OPERATION_NODE_TYPES.has(node['Node Type'])) {
      const branches = branchesOf(node)
      if (branches === null) {
        ambiguous = true
      } else {
        for (const branch of branches) {
          for (const entry of branch.output) {
            const reference = parseReference(entry)
            if (reference?.alias != null) aliases.add(reference.alias)
          }
        }
        const width = branches[0]?.output.length ?? 0
        for (let position = 0; position < width; position++) {
          const column: UnionColumn = { branches, position }
          for (const branch of branches) {
            const entry = branch.output[position] ?? ''
            const seen = columns.get(entry)
            if (seen !== undefined && seen !== column) {
              ambiguous = true
              continue
            }
            columns.set(entry, column)
          }
        }
      }
    }
    const crossed =
      node['Node Type'] === SUBQUERY_SCAN && node.Alias !== undefined && crossable.has(node.Alias)
    for (const child of node.Plans ?? []) visit(child, insideCrossing || crossed)
  }
  visit(root, false)
  return { columns, aliases, ambiguous }
}

/**
 * Whether everything this `Subquery Scan` says about itself agrees with the view it
 * would be pinned to. The plan offers the alias and nothing else, so the alias is
 * matched by name — and a name is only evidence while nothing contradicts it. Every
 * entry of the node's own `Output` that is a plain reference to its own alias must
 * name a column the view has; one that does not means the node is some other
 * subquery that happens to be called this, and the node is left uncrossed.
 */
function namesOnlyColumnsOf(node: ExplainPlanNode, alias: string, view: ViewShape): boolean {
  for (const entry of node.Output ?? []) {
    const reference = parseReference(entry)
    if (!reference || reference.alias !== alias) continue
    if (!view.columns.includes(reference.column)) return false
  }
  return true
}

function crossableSubqueries(
  root: ExplainPlanNode,
  candidates: ReadonlyMap<string, ViewShape>
): Map<string, CrossableSubquery> {
  const crossable = new Map<string, CrossableSubquery>()
  for (const node of collectNodes(root, (candidate) => candidate['Node Type'] === SUBQUERY_SCAN)) {
    const alias = node.Alias
    if (alias === undefined) continue
    const view = candidates.get(alias)
    if (!view) continue
    const children = inputChildren(node)
    const only = children.length === 1 ? children[0] : undefined
    if (!only) continue
    const selectList = selectListNodeOf(only)
    if (SET_OPERATION_NODE_TYPES.has(selectList['Node Type'])) {
      const branches = inputChildren(selectList)
      if (branches.length === 0) continue
      if (!branches.every((branch) => branch.Output?.length === view.columns.length)) continue
      if (!namesOnlyColumnsOf(node, alias, view)) continue
      crossable.set(alias, { view, selectList, branches })
      continue
    }
    if (selectList.Output?.length !== view.columns.length) continue
    if (!namesOnlyColumnsOf(node, alias, view)) continue
    crossable.set(alias, { view, selectList, branches: null })
  }
  return crossable
}

/**
 * One reading of one column: the base columns behind it, whether a NULL of the plan's
 * own reaches it, and — where there are no base columns — which refusal that is.
 */
interface Reading {
  /** `null` where the plan does not say; empty where no branch contributes a value. */
  origins: ColumnOrigin[] | null
  /** The plan writes a NULL of its own into this column. */
  nullValue: boolean
  reason: ColumnRefusal | null
  /**
   * The expression rules' answer for a column a set operation assembled, where that is
   * more than the origins say: a branch spelling a literal has no base column yet its
   * value is never NULL, and the union's column is never NULL where every branch's is.
   * Absent for a column read off one scan, whose nullability the origins already give.
   */
  nullability?: ExpressionNullability
}

function unknown(reason: ColumnRefusal): Reading {
  return { origins: null, nullValue: true, reason }
}

/**
 * Merges the readings of one column across the branches of a union.
 *
 * A branch contributing a NULL literal contributes no value and drops out; a branch
 * the reader could not read leaves the whole column unknown, because a relation
 * derived from the branches that were read would be a claim about rows that came
 * from the one that was not.
 */
function mergeReadings(readings: Reading[]): Reading {
  const origins: (ColumnOrigin & { aliases: Set<string> })[] = []
  let nullValue = false
  for (const reading of readings) {
    if (reading.origins === null) {
      // A branch the reader could not read leaves the whole column unknown, and the
      // column carries that branch's own refusal: a source taken from the branches
      // that were read would be a claim about the rows of the one that was not.
      return { origins: null, nullValue: true, reason: reading.reason ?? 'not-a-column-reference' }
    }
    nullValue = nullValue || reading.nullValue
    for (const origin of reading.origins) {
      const same = origins.find(
        (seen) =>
          seen.schema === origin.schema &&
          seen.relation === origin.relation &&
          seen.column === origin.column
      )
      if (same) {
        // One base column reached through two branches: still one column, but the two
        // branches are two row streams, so the instance is the pair of them.
        same.aliases.add(origin.alias)
        same.coerced = same.coerced || origin.coerced
        same.nullExtended = same.nullExtended || origin.nullExtended
        continue
      }
      origins.push({ ...origin, aliases: new Set([origin.alias]) })
    }
  }
  // The order the branches arrive in is the planner's: a parallel `Append` lists its
  // children by the cost of running them, an ordinary one in the set operation's own
  // order. Neither is a fact about the view, so what is kept is sorted rather than
  // taken as it came, and the same goes for the names of the streams a column was
  // assembled from.
  const sorted = origins
    .map(({ aliases, ...origin }) => ({ ...origin, alias: [...aliases].sort().join('∨') }))
    .sort((left, right) =>
      `${left.schema}.${left.relation}.${left.column}`.localeCompare(
        `${right.schema}.${right.relation}.${right.column}`
      )
    )
  return { origins: sorted, nullValue, reason: null }
}

/**
 * The two boundaries the reader crosses, and where each one's map lives.
 *
 * A `WITH` query referenced once is inlined and leaves no boundary at all; referenced
 * twice it is materialized, and then the reader above it says `live_routes.currency_id`
 * — the name of the `WITH` query's own column, not of any relation. Crossing that needs
 * the map from the `WITH` query's column names to the positions of its select list, and
 * the plan does not hold it: the `CTE <name>` subplan node prints the select list in
 * order but never its names, and a `CTE Scan` prints names in the order its own parent
 * asked for. Recovering the map from a scan that happens to print the whole list is an
 * answer that exists on the days the planner is generous; the map the view's stored
 * rewrite tree holds (`cteColumns`, read by `view-tree.ts`) is a fact about the schema
 * and is what this reader uses.
 *
 * A view is the other boundary, and there the map — a view's columns in `attnum` order
 * are the positions of its select list — is in the catalog rather than the plan. So a
 * `Subquery Scan` the catalog pins to one view this relation is built on is descended
 * through, and a `CTE Scan` whose tree names the query's columns is descended into its
 * subplan.
 */
class OriginReader {
  private readonly relations: Map<string, { schema: string; relation: string }>
  /**
   * The one relation an unqualified column name can belong to, when there is one.
   * `EXPLAIN` prints a prefix only where the plan's flattened range table has more
   * than one entry, so an unqualified name is the planner saying there is nothing
   * else it could be — and the plan's single row source says which relation that is.
   */
  private readonly soleRelation: { alias: string; schema: string; relation: string } | null
  /** Scan instances an outer join above them can null. */
  private readonly nulled: ReadonlySet<string>
  /** Plan nodes an outer join above them can null the whole output of. */
  private readonly nulledNodes: ReadonlySet<ExplainPlanNode>
  private readonly crossable: ReadonlyMap<string, CrossableSubquery>
  private readonly aliasKinds: ReadonlyMap<string, string>
  /** The `WITH` query each `CTE Scan` alias reads, and the subplan computing each. */
  private readonly cteOfAlias: ReadonlyMap<string, string>
  private readonly cteSubplans: ReadonlyMap<string, ExplainPlanNode>
  private readonly cteStack = new Set<string>()
  private readonly catalog: PlanCatalog
  /** Every column of a set operation whose branches can be told apart, by entry text. */
  private readonly unionColumns: ReadonlyMap<string, UnionColumn>
  /** Branch scan aliases of those set operations, by alias. */
  private readonly unionAliases: ReadonlySet<string>
  private readonly unionsAmbiguous: boolean
  private readonly unionMemo = new Map<UnionColumn, Reading>()
  private readonly unionPending = new Set<UnionColumn>()

  constructor(
    root: ExplainPlanNode,
    candidates: ReadonlyMap<string, ViewShape>,
    catalog: PlanCatalog
  ) {
    this.relations = scanAliases(root)
    const nullExtended = nullExtendedIn(root)
    this.nulled = nullExtended.aliases
    this.nulledNodes = nullExtended.nodes
    this.crossable = crossableSubqueries(root, candidates)
    this.aliasKinds = aliasNodeTypes(root)
    this.cteOfAlias = cteAliasesIn(root)
    this.cteSubplans = cteSubplansIn(root)
    const unions = unionColumnsOf(root, this.crossable)
    this.unionColumns = unions.columns
    this.unionAliases = unions.aliases
    this.unionsAmbiguous = unions.ambiguous
    const [sole] = [...this.relations]
    const aliasNodes = countNodes(root, (node) => node.Alias !== undefined)
    this.soleRelation =
      aliasNodes === 1 && this.relations.size === 1 && sole ? { alias: sole[0], ...sole[1] } : null
    this.catalog = catalog
  }

  /** `Subquery Scan` nodes this reader descends through, by alias. */
  get crossed(): ReadonlyMap<string, CrossableSubquery> {
    return this.crossable
  }

  /** Whether a set operation's branches could not be told apart anywhere in the plan. */
  get ambiguousUnions(): boolean {
    return this.unionsAmbiguous
  }

  /** The alias an unqualified column name belongs to, where there is one. */
  get soleAlias(): string | null {
    return this.soleRelation?.alias ?? null
  }

  /**
   * The base columns one `Output` entry reads. `crossing` holds the aliases of the
   * `Subquery Scan` nodes already descended through on the way here: a plan's
   * range-table names are unique, so an alias that came round twice would be a
   * cycle, which PostgreSQL does not allow between views and this reader does not
   * follow.
   */
  read(entry: string, crossing: ReadonlySet<string> = new Set(), branchLocal = false): Reading {
    if (!branchLocal) {
      const column = this.unionColumns.get(entry)
      if (column) return this.readUnionColumn(column, crossing)
      const reference = parseReference(entry)
      if (reference?.alias != null && this.unionAliases.has(reference.alias)) {
        // A column of a set operation's branch reached somewhere its position in the
        // branch is not the entry itself — inside a larger expression. The same spelling
        // may stand for another branch's column of a different type, so which value it
        // is is not said here, and the column stays unknown rather than read off one
        // branch.
        return unknown('not-a-column-reference')
      }
    }
    return this.readEntry(entry, crossing)
  }

  /**
   * The one value every branch of a set operation answers at this column: one base
   * column per branch, and a NULL in any branch makes the column nullable there. A key
   * of the union under a column a branch reads is not carried: the union's own columns
   * are the union's answer, read by `plan-keys.ts`.
   */
  private readUnionColumn(column: UnionColumn, crossing: ReadonlySet<string>): Reading {
    const memo = this.unionMemo.get(column)
    if (memo) return memo
    if (this.unionPending.has(column)) return unknown('not-a-column-reference')
    this.unionPending.add(column)
    const merged = mergeReadings(
      column.branches.map((branch) =>
        this.readEntry(branch.output[column.position] ?? '', crossing)
      )
    )
    // The origins name the base columns a branch proxies and say nothing where a branch
    // spells a literal; the nullability is the union's own answer — never NULL only
    // where every branch's entry is — and is kept beside them.
    merged.nullability = mergeNullabilities(
      column.branches.map((branch) =>
        this.evaluateEntry(branch.output[column.position] ?? '', branch.node, crossing, true)
      )
    )
    this.unionPending.delete(column)
    this.unionMemo.set(column, merged)
    return merged
  }

  /** The reading of one entry that is not itself a set operation's column. */
  readEntry(entry: string, crossing: ReadonlySet<string> = new Set()): Reading {
    if (NULL_LITERAL.test(entry)) return { origins: [], nullValue: true, reason: null }
    const reference = parseReference(entry)
    if (!reference) return unknown('not-a-column-reference')
    if (reference.alias === null) {
      const sole = this.soleRelation
      if (!sole) return unknown('unqualified-name-without-a-sole-relation')
      return this.origin(sole.schema, sole.relation, sole.alias, reference)
    }
    const relation = this.relations.get(reference.alias)
    if (relation) {
      return this.origin(relation.schema, relation.relation, reference.alias, reference)
    }
    const crossable = this.crossable.get(reference.alias)
    if (crossable) {
      if (crossing.has(reference.alias)) return unknown('through-an-unpinned-subquery')
      return this.cross(crossable, reference, new Set([...crossing, reference.alias]))
    }
    const kind = this.aliasKinds.get(reference.alias)
    if (kind === CTE_SCAN) {
      return this.crossCte(reference.alias, reference.column, crossing)
    }
    if (kind === SUBQUERY_SCAN) return unknown('through-an-unpinned-subquery')
    return unknown('through-a-row-source-the-catalog-does-not-name')
  }

  /**
   * Reads one column of a `WITH` query through the subplan that computes it: the stored
   * tree says which position of the query's select list the column stands at, and the
   * subplan prints that select list. The value is the entry's value unchanged — a
   * `WITH` query's column is its select list entry's type — so there is no waypoint to
   * judge. A `WITH` query whose map or subplan is not in hand stays refused.
   */
  private crossCte(alias: string, column: string, crossing: ReadonlySet<string>): Reading {
    const cte = this.cteOfAlias.get(alias)
    const columns = cte === undefined ? undefined : this.catalog.cteColumns.get(cte)
    const subplan = cte === undefined ? undefined : this.cteSubplans.get(cte)
    if (cte === undefined || !columns || !subplan || this.cteStack.has(cte)) {
      return unknown('through-a-materialized-with')
    }
    const position = columns.indexOf(column)
    if (position < 0) return unknown('through-a-materialized-with')
    this.cteStack.add(cte)
    const inner = this.read(subplan.Output?.[position] ?? '', crossing)
    this.cteStack.delete(cte)
    // An outer join nulls the `CTE Scan` instance, not the subplan that computes the
    // query — the subplan is an `InitPlan` beside the join and is never padded — so the
    // scan's own null-extension is what the value carries.
    if (this.nulled.has(alias)) {
      return {
        origins: inner.origins?.map((origin) => ({ ...origin, nullExtended: true })) ?? null,
        nullValue: true,
        reason: inner.reason
      }
    }
    return inner
  }

  private origin(
    schema: string,
    relation: string,
    alias: string,
    reference: { column: string; coerced: boolean }
  ): Reading {
    return {
      origins: [
        {
          schema,
          relation,
          alias,
          column: reference.column,
          coerced: reference.coerced,
          via: [],
          nullExtended: this.nulled.has(alias),
          qualifiedNonNull: false
        }
      ],
      nullValue: false,
      reason: null
    }
  }

  /**
   * Reads one column of a crossed view: the catalog says which position of its select
   * list the name stands at, and the node under the `Subquery Scan` prints that
   * select list. The crossed view's own column is recorded as a waypoint, because the
   * value is that column's value and the step out of it is a step between two types
   * `derive.ts` still has to find value-preserving.
   */
  private cross(
    crossable: CrossableSubquery,
    reference: { column: string; coerced: boolean },
    crossing: ReadonlySet<string>
  ): Reading {
    const position = crossable.view.columns.indexOf(reference.column)
    // Every parseable reference of this node's `Output` was checked against the view's
    // columns before the node was called crossable, so a name that is not one of them
    // cannot arrive here.
    if (position < 0) return unknown('through-an-unpinned-subquery')
    const inner = crossable.branches
      ? mergeReadings(
          crossable.branches.map((branch) => this.read(branch.Output?.[position] ?? '', crossing))
        )
      : this.read(crossable.selectList.Output?.[position] ?? '', crossing)
    if (inner.origins === null) return inner
    if (inner.origins.length === 0) return inner
    const waypoint = {
      schema: crossable.view.schema,
      relation: crossable.view.name,
      column: reference.column
    }
    return {
      origins: inner.origins.map((origin) => ({
        ...origin,
        coerced: origin.coerced || reference.coerced,
        via: [...origin.via, waypoint]
      })),
      nullValue: inner.nullValue,
      reason: null
    }
  }

  /**
   * Whether the expression one `Output` entry spells can be NULL: the same
   * reading `read` gives of the column references in it, evaluated by the
   * expression rules of `plan-expressions.ts`. `node` is the node printing the
   * entry — it says whether the plan has nulled the entry's whole row, and
   * whether its aggregates group their input.
   */
  evaluateEntry(
    entry: string,
    node: ExplainPlanNode,
    crossing: ReadonlySet<string> = new Set(),
    branchLocal = false
  ): ExpressionNullability {
    if (this.nulledNodes.has(node)) return 'nullable'
    // A join that nulls one of its inputs can print the very aggregate the nulled
    // input computed — the planner inlines a grouped subquery under it whole, and the
    // aggregate lands in the join's own `Output`. In every row the join padded, that
    // value is NULL however `count` reads, and which side the entry came from is not
    // in the entry. A column reference is safe here — the alias it names says the
    // side, and `readingNullability` reads it — and so is everything else built of
    // references, whose own reading carries the side; a `count` is the one shape
    // that answers never-NULL of itself and so cannot be told apart. A join type
    // this map does not know nulls both sides, so it reads the same.
    const joinType = node['Join Type']
    if (
      joinType !== undefined &&
      (JOIN_TYPE_NULLED_SIDES.get(joinType) ?? BOTH_JOIN_SIDES).size > 0 &&
      computesCount(entry)
    ) {
      return 'unknown'
    }
    if (NULL_LITERAL.test(entry)) return 'nullable'
    // A `GROUP BY ROLLUP` and its kin emit a superaggregate row in which every
    // grouping column is NULL and which stands for no base row. Any bare column the
    // select list names is one of those grouping columns — a column outside every
    // grouping set is not valid SQL here — so where the node computes `GROUPING
    // SETS`, a column reference is nullable whatever the plan around it says. What
    // survives is what is non-null independently of any such column: a literal, a
    // `count`, a `COALESCE` with a non-null arm. `min`/`max`/`sum`/`avg` do not: the
    // grand-total row over an empty input is the aggregate over no rows, and that
    // answers NULL. So `hasGroupKey` is false here and the references a shape is
    // built of answer nullable; the shapes whose SQL definition is the claim answer
    // for themselves.
    const groupingSets = node['Grouping Sets'] !== undefined
    const reference = parseReference(entry)
    if (reference) {
      if (groupingSets) return 'nullable'
      if (reference.alias !== null) {
        if (this.aliasKinds.get(reference.alias) === CTE_SCAN) {
          return this.evaluateCte(reference.alias, reference.column, crossing)
        }
        const crossable = this.crossable.get(reference.alias)
        if (crossable) {
          // The expression rules reach across a boundary the origin reader
          // crosses too: a computed column of a crossed view is the same
          // expression one step down, read there where the node printing it
          // says what the plan does around it.
          if (crossing.has(reference.alias)) return 'unknown'
          return this.evaluateCrossed(
            crossable,
            reference.column,
            new Set([...crossing, reference.alias]),
            branchLocal
          )
        }
      }
      return this.readingNullability(this.read(entry, crossing, branchLocal))
    }
    return evaluateExpression(parseExpression(entry), {
      column: (referenceText) =>
        groupingSets
          ? 'nullable'
          : this.readingNullability(this.read(referenceText, crossing, branchLocal)),
      hasGroupKey: groupsItsInput(node),
      shadowed: (name) => this.catalog.shadowedNames.has(name)
    })
  }

  /**
   * The nullability of one column of a `WITH` query, evaluated at the entry of the
   * subplan that computes it — where the node that grouped the query, and the plan's
   * own outer joins around it, are the node's own.
   */
  private evaluateCte(
    alias: string,
    column: string,
    crossing: ReadonlySet<string>
  ): ExpressionNullability {
    const cte = this.cteOfAlias.get(alias)
    const columns = cte === undefined ? undefined : this.catalog.cteColumns.get(cte)
    const subplan = cte === undefined ? undefined : this.cteSubplans.get(cte)
    if (cte === undefined || !columns || !subplan || this.cteStack.has(cte)) return 'unknown'
    const position = columns.indexOf(column)
    if (position < 0) return 'unknown'
    // An outer join nulls the `CTE Scan` instance even though the subplan beside the
    // join is never padded, so the scan's own null-extension answers here.
    if (this.nulled.has(alias)) return 'nullable'
    this.cteStack.add(cte)
    const state = this.evaluateEntry(subplan.Output?.[position] ?? '', subplan, crossing)
    this.cteStack.delete(cte)
    return state
  }

  private evaluateCrossed(
    crossable: CrossableSubquery,
    column: string,
    crossing: ReadonlySet<string>,
    branchLocal = false
  ): ExpressionNullability {
    const position = crossable.view.columns.indexOf(column)
    if (position < 0) return 'unknown'
    if (crossable.branches) {
      return mergeNullabilities(
        crossable.branches.map((branch) =>
          this.evaluateEntry(branch.Output?.[position] ?? '', branch, crossing, branchLocal)
        )
      )
    }
    return this.evaluateEntry(
      crossable.selectList.Output?.[position] ?? '',
      crossable.selectList,
      crossing,
      branchLocal
    )
  }

  /** The reading of a bare reference, turned into the expression rules' answers. */
  private readingNullability(reading: Reading): ExpressionNullability {
    if (reading.nullability !== undefined) return reading.nullability
    if (reading.origins === null) return 'unknown'
    if (reading.origins.length === 0) return 'nullable'
    if (reading.nullValue) return 'nullable'
    let unknown = false
    for (const origin of reading.origins) {
      if (origin.nullExtended) return 'nullable'
      const notNull = this.catalog.columnNotNull(origin.schema, origin.relation, origin.column)
      if (notNull === undefined) {
        unknown = true
        continue
      }
      if (!notNull) return 'nullable'
    }
    return unknown ? 'unknown' : 'never-null'
  }
}

/**
 * Whether the entry may compute a lifted aggregate: a `count`, the one aggregate
 * whose value is never NULL of itself, or an opaque fragment that could be one. On
 * a join that nulls an input, an aggregate the nulled input computed is NULL in
 * every padded row, and nothing in the entry says which side it came from.
 */
function computesCount(entry: string): boolean {
  const contains = (node: ReturnType<typeof parseExpression>): boolean => {
    if (!node) return false
    switch (node.kind) {
      case 'opaque':
        return true
      case 'call':
        return node.name === 'count' || node.args.some(contains)
      case 'case':
        return node.arms.some(contains) || (node.otherwise !== null && contains(node.otherwise))
      case 'chain':
        return node.operands.some(contains)
      case 'unary':
        return contains(node.operand)
      case 'cast':
        return contains(node.operand)
      default:
        return false
    }
  }
  return contains(parseExpression(entry))
}

/** A node whose every output row stands for a non-empty group of its input. */
function groupsItsInput(node: ExplainPlanNode): boolean {
  const keys = node['Group Key']
  return node['Grouping Sets'] === undefined && Array.isArray(keys) && keys.length > 0
}

/**
 * The nullability of a value several branches each produce one shape of: NULL in
 * any branch makes the column nullable there, and only a column no branch can
 * NULL is never NULL — the intersection, as the origins of a union are.
 */
function mergeNullabilities(states: readonly ExpressionNullability[]): ExpressionNullability {
  if (states.some((state) => state === 'nullable')) return 'nullable'
  if (states.every((state) => state === 'never-null')) return 'never-null'
  return 'unknown'
}

export interface PlanOrigins {
  /** One entry per requested column, in the requested order. */
  columns: ColumnSources[]
  /** One entry per requested column: why it has no sources, `null` where it has. */
  refusals: (ColumnRefusal | null)[]
  /**
   * One entry per requested column: the plan puts a NULL into this column of its own
   * accord — an outer join nulling the side it is read from, a `UNION` branch
   * spelling a NULL literal, the superaggregate row of a `GROUPING SETS` — so what
   * the base column promises about its own values does not reach the view.
   */
  nullIntroduced: boolean[]
  /**
   * One entry per requested column: the select-list expression itself proves the
   * value never NULL — a literal, `count`, a `COALESCE` over a never-NULL argument
   * — without any base column it may read. A `GROUPING SETS` row can still put a
   * NULL where the expression does not, which `groupingSets` below says apart.
   */
  expressionNotNull: boolean[]
  /** The plan computes `GROUPING SETS` / `ROLLUP` / `CUBE`, whose superaggregate row is all-NULL grouping columns. */
  groupingSets: boolean
  /**
   * Every set of the requested columns the plan proves no two rows share; see
   * `plan-keys.ts`. Whether a column of one can be NULL is `derive.ts`'s question.
   */
  rowIdentities: PlanKey[]
}

/**
 * Reads the sources of each requested column off one plan.
 *
 * `candidates` are the views this relation is built on, by the name a `Subquery Scan`
 * over one of them would carry — the only boundaries this reader may descend through.
 * `catalog` answers which keys each scanned relation has, which every row identity
 * starts from, and which qualifiers a scan applies without printing them.
 *
 * Returns a `PlanRefusal` — no column of this view gets a source — where the plan
 * cannot be read positionally at all.
 */
export function readPlanOrigins(
  root: ExplainPlanNode,
  requestedColumnCount: number,
  candidates: ReadonlyMap<string, ViewShape>,
  catalog: PlanCatalog
): PlanOrigins | PlanRefusal {
  if (countNodes(root, (node) => UNREADABLE_SET_NODE_TYPES.has(node['Node Type'])) > 0) {
    return 'unreadable-set-operation'
  }
  // `GROUP BY ROLLUP`, `CUBE` and `GROUPING SETS` emit a superaggregate row in which
  // the grouping columns are NULL and which stands for no base row at all. The values
  // in the ordinary rows are still the base column's, so the origins hold; what does
  // not hold is that every row of the view answers to a row of the base relation —
  // so neither a non-null column nor a row identity survives it.
  const groupingSets = countNodes(root, (node) => node['Grouping Sets'] !== undefined) > 0
  const reader = new OriginReader(root, candidates, catalog)
  const selectListNode = selectListNodeOf(root)

  // A set operation's branches are read position by position, wherever the operation
  // stands: at the select list of the plan, under a node that computes over it, or at
  // the select list of a view the reader descends into. Where the branches cannot be
  // told apart — a set operation over another, a branch with no select list — the
  // plan is refused rather than one branch's spelling trusted for the union's.
  if (reader.ambiguousUnions) return 'set-operation-not-a-select-list'

  const readings: Reading[] = []
  const nullabilities: ExpressionNullability[] = []
  if (SET_OPERATION_NODE_TYPES.has(selectListNode['Node Type'])) {
    const branches = inputChildren(selectListNode).map((child) => selectListNodeOf(child))
    if (branches.length === 0) return 'output-not-positional'
    // Each branch prints its own select list, in the set operation's column order. A
    // shorter or longer one is not that list, and nothing may be read off it
    // positionally.
    if (branches.some((branch) => branch.Output?.length !== requestedColumnCount)) {
      return 'output-not-positional'
    }
    for (let index = 0; index < requestedColumnCount; index++) {
      readings.push(
        mergeReadings(branches.map((branch) => reader.readEntry(branch.Output?.[index] ?? '')))
      )
      nullabilities.push(
        mergeNullabilities(
          branches.map((branch) =>
            reader.evaluateEntry(branch.Output?.[index] ?? '', branch, new Set(), true)
          )
        )
      )
    }
  } else {
    const output = selectListNode.Output
    if (!output || output.length !== requestedColumnCount) return 'output-not-positional'
    for (const entry of output) {
      readings.push(reader.read(entry))
      nullabilities.push(reader.evaluateEntry(entry, selectListNode))
    }
  }

  const context = {
    inputs: inputChildren,
    reference: parseReference,
    soleAlias: reader.soleAlias,
    passThrough: PASS_THROUGH_NODE_TYPES,
    unioning: TUPLE_UNIONING_NODE_TYPES,
    crossed: reader.crossed,
    nulledSides: (joinType: string) => JOIN_TYPE_NULLED_SIDES.get(joinType) ?? BOTH_JOIN_SIDES,
    uniqueKeysOf: catalog.uniqueKeysOf
  }
  // A value a union assembled is read off several streams, named together as
  // `a∨b`; a qualifier keeps it from NULL only where it does so in every one of them.
  const qualified = readQualifiedNonNull(root, context, catalog)
  for (const reading of readings) {
    for (const origin of reading.origins ?? []) {
      origin.qualifiedNonNull = origin.alias
        .split('∨')
        .every((alias) => qualified.has(qualifiedReference(alias, origin.column)))
    }
  }

  return {
    columns: readings.map((reading) =>
      reading.origins && reading.origins.length > 0 ? reading.origins : null
    ),
    refusals: readings.map((reading) =>
      reading.origins === null
        ? (reading.reason ?? 'not-a-column-reference')
        : reading.origins.length === 0
          ? 'no-value-from-any-branch'
          : null
    ),
    nullIntroduced: readings.map(
      (reading) =>
        groupingSets ||
        reading.origins === null ||
        reading.origins.length === 0 ||
        reading.nullValue ||
        reading.origins.some((origin) => origin.nullExtended)
    ),
    expressionNotNull: nullabilities.map((state) => state === 'never-null'),
    groupingSets,
    rowIdentities: readPlanKeys(root, selectListNode, context)
  }
}
