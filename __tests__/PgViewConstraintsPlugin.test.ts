// What the planner says about a view column, case by case.
//
// `PgViewConstraintsPlugin.fixture.json` is PostgreSQL 18's own answer — the plans,
// the constraints, the unique indexes, the column types and the binary-coercible
// casts — for the schema in `PgViewConstraintsPlugin.lab.sql`, read through the
// plugin's own catalog queries. Nothing here is written by hand except the
// expectations. `yarn fixture` rebuilds it (`build-fixture.ts`).
//
// The negative cases carry the weight. A relation this plugin fails to derive costs
// a smart tag someone writes by hand; a relation it derives wrongly is a join that
// silently matches nothing, and the whole point of reading the plan instead of
// trusting a tag is that the reader says "I do not know" wherever it does not.
//
// `notNull` is stricter again, and the outer-join cases are why. A wrong relation
// costs an empty related object; a wrong `notNull` puts a NULL in a non-null GraphQL
// field, and GraphQL then nulls the parent object rather than the field — the answer
// is destroyed. Every kind of outer join is here from both sides, because getting the
// direction backwards is exactly the mistake that claims non-nullness on the side the
// emptiness arrives from.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  castPreservesNonNull,
  deriveProjectionRelations,
  deriveViewConstraints,
  TARGET_REFUSALS,
  valuePreservingCast
} from '../src/PgViewConstraintsPlugin/derive.ts'
import type {
  CatalogRelation,
  TableDerivation,
  TargetRefusal,
  TypeCoercions,
  ViewColumn,
  ViewDerivation
} from '../src/PgViewConstraintsPlugin/derive.ts'
import {
  collectViewConstraints,
  NO_PRIVILEGED_CONNECTION_REASON,
  readShadowedNames,
  readViewTrees,
  subqueryViewCandidates,
  TREE_FORMAT_UNCHECKED_REASON,
  planCatalogFrom
} from '../src/PgViewConstraintsPlugin/collect.ts'
import type { ViewSourceRow } from '../src/PgViewConstraintsPlugin/collect.ts'
import type { RunQuery } from '../src/PgViewConstraintsPlugin/collect.ts'
import {
  COLUMN_REFUSALS,
  PLAN_REFUSALS,
  parseReference,
  readPlanOrigins
} from '../src/PgViewConstraintsPlugin/plan-origins.ts'
import { conditionEqualities } from '../src/PgViewConstraintsPlugin/plan-keys.ts'
import { readViewTree } from '../src/PgViewConstraintsPlugin/view-tree.ts'
import {
  evaluateExpression,
  parseExpression
} from '../src/PgViewConstraintsPlugin/plan-expressions.ts'
import type {
  ColumnRefusal,
  ExplainPlanNode,
  PlanOrigins,
  PlanRefusal,
  ViewShape
} from '../src/PgViewConstraintsPlugin/plan-origins.ts'

interface Fixture {
  catalog: (Omit<CatalogRelation, 'columns'> & {
    columns: Record<string, { typeId: number; typeMod: number; notNull: boolean }>
  })[]
  coercions: { binary: string[]; domainBase: Record<string, number> }
  /** Every `=` operator of the lab database is strict. */
  strictEquality: boolean
  /** The rule spellings a user object has taken over somewhere in the lab database. */
  shadowedNames: string[]
  /** Every lab table, each a referencing half of a relation to a projection. */
  tables: { schema: string; table: string }[]
  /** Every lab view's select-list order and the views it is built on. */
  viewSources: ViewSourceRow[]
  views: {
    schema: string
    view: string
    relkind: 'v' | 'm'
    /** The planner regime the plan was taken under; see build-fixture.ts. */
    regime: string
    columns: ViewColumn[]
    /** Whether the view's stored rewrite tree parsed. */
    treeOk: boolean
    /** The view's `WITH` query column map, from its stored rewrite tree. */
    cteColumns: Record<string, string[]>
    /** Each `WITH` query column's base column, by query and position, or `null`. */
    cteOrigins: Record<string, ({ schema: string; relation: string; column: string } | null)[]>
    /** `WITH` names the tree defines at more than one query level. */
    cteAmbiguous: string[]
    /** Whether each `WITH` query of the view is materialized by PostgreSQL. */
    cteMaterialized: Record<string, boolean>
    /** How many times each `WITH` query is referenced in the view's own query. */
    cteRefCount: Record<string, number>
    /** Each view column's traced base column, by position, from the stored tree. */
    treeColumns: Record<
      string,
      { schema: string; relation: string; column: string; relkind: string }
    >
    /** Each range-table alias of the view, resolved to the relation it names. */
    viewAliases: Record<string, string>
    plan: ExplainPlanNode
  }[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('./PgViewConstraintsPlugin.fixture.json', import.meta.url), 'utf8')
)

const catalog = new Map<string, CatalogRelation>(
  fixture.catalog.map((relation) => [
    `${relation.schema}.${relation.relation}`,
    { ...relation, columns: new Map(Object.entries(relation.columns)) }
  ])
)

// The rule spellings a user object has taken over across the lab database: the same
// set for every view, since a plan prints a name and not the object it stands for.
const shadowedNames = new Set(fixture.shadowedNames ?? [])

const planCatalog = planCatalogFrom(catalog, fixture.strictEquality, shadowedNames)

const coercions: TypeCoercions = {
  binary: new Set(fixture.coercions.binary),
  domainBase: new Map(
    Object.entries(fixture.coercions.domainBase).map(([domain, base]) => [Number(domain), base])
  )
}

/** A hand-built plan read, asserted to be readable so the case is about its columns. */
function read(
  plan: ExplainPlanNode,
  columnCount: number,
  candidates?: ReadonlyMap<string, ViewShape>
): PlanOrigins {
  const origins = readPlanOrigins(plan, columnCount, candidates ?? new Map(), planCatalog)
  assert.ok(typeof origins !== 'string', `plan refused: ${String(origins)}`)
  return origins
}

/** The regime the cases below are written against. */
const DEFAULT_REGIME = 'default'

const REGIMES = [...new Set(fixture.views.map((view) => view.regime))]

/** What one lab view's derivation reduces to, in the shape the cases are written in. */
function derive(
  name: string,
  regime: string = DEFAULT_REGIME,
  shadowed: ReadonlySet<string> = shadowedNames
): {
  origins: string[] | null
  notNull: string[]
  foreignKeys: string[]
  primaryKey: string | null
  unique: string | null
  planRefusal: PlanRefusal | null
  refusals: (ColumnRefusal | null)[]
  notes: string[]
} {
  const view = fixture.views.find(
    (candidate) => candidate.view === name && candidate.regime === regime
  )
  assert.ok(view, `no fixture for lab.${name} under ${regime}`)
  const cteColumns = new Map(Object.entries(view.cteColumns ?? {}))
  const cteOrigins = new Map(Object.entries(view.cteOrigins ?? {}))
  const cteMaterialized = new Map(Object.entries(view.cteMaterialized ?? {}))
  const cteRefCount = new Map(Object.entries(view.cteRefCount ?? {}))
  const treeColumns = new Map(
    Object.entries(view.treeColumns ?? {}).map(([position, column]) => [Number(position), column])
  )
  // A source view the defining query gave an explicit alias is crossable by that alias.
  const candidates = subqueryViewCandidates(fixture.viewSources, view.schema, view.view)
  for (const [alias, relation] of Object.entries(view.viewAliases ?? {})) {
    const shape = candidates.get(relation)
    if (shape) candidates.set(alias, shape)
  }
  const derivation = deriveViewConstraints(
    view.schema,
    view.view,
    view.relkind,
    view.columns,
    readPlanOrigins(
      view.plan,
      view.columns.length,
      candidates,
      planCatalogFrom(
        catalog,
        fixture.strictEquality,
        shadowed,
        cteColumns,
        cteOrigins,
        cteMaterialized,
        cteRefCount
      )
    ),
    catalog,
    coercions,
    true,
    treeColumns
  )
  return {
    origins:
      derivation.origins?.map((sources, index) => {
        const column = view.columns[index]?.name ?? '?'
        if (!sources) return `${column}=—`
        return `${column}=${sources.map((origin) => `${origin.relation}.${origin.column}`).join('|')}`
      }) ?? null,
    notNull: derivation.notNullColumns,
    foreignKeys: derivation.foreignKeys.map((foreignKey) => foreignKey.tag),
    primaryKey: derivation.primaryKey?.tag ?? null,
    unique: derivation.unique?.tag ?? null,
    planRefusal: derivation.planRefusal,
    refusals: derivation.columnRefusals,
    notes: derivation.notes
  }
}

interface Case {
  /** The lab view, and what makes it the case it is. */
  view: string
  about: string
  origins: string[] | null
  /** View columns derived NOT NULL, in attribute order. */
  notNull: string[]
  foreignKeys: string[]
  primaryKey: string | null
  /**
   * The `@unique` tag derived for the view, where the plan proves a key whose columns
   * may be NULL. Left out on the cases that prove none, which is asserted to be none.
   */
  unique?: string
  /**
   * A whole-plan refusal a reader on another PostgreSQL major gives this view instead of
   * the expectations above, which is accepted. A plan shape that moved between majors
   * (a set operation the older one wraps in a subquery) makes the column unread either
   * way; both answers are the conservative one, and the lab is read on every supported
   * major in CI.
   */
  alsoPlanRefusal?: PlanRefusal
}

const CASES: Case[] = [
  // ── Proxying, in every shape that still proxies ────────────────────────────────
  {
    view: 'v_bare',
    about: 'a bare reference is the plain case: every column proxies its base column',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_left_join',
    about:
      'LEFT JOIN, both sides: the inner one still proxies — NULL or the base value — ' +
      'and is the one the join can null, while the outer one keeps NOT NULL',
    origins: ['id=tx.id', 'bank_id=bank.id', 'cur_code=tx.cur_code'],
    // `bank.id` is the primary key of `bank` and NOT NULL there; it is nullable here
    // and nowhere else, because of where the join stands over it.
    notNull: ['id', 'cur_code'],
    foreignKeys: [
      '(bank_id) references lab.bank (id)',
      '(cur_code) references lab.currency (code)',
      '(id) references lab.tx (id)'
    ],
    // `bank` is joined by its own key, so no row of `tx` meets two of it, and `tx`'s
    // key is the view's.
    primaryKey: 'id'
  },
  {
    view: 'v_left_group_nulled',
    about:
      'a group key taken from the nulled side of an outer join is no row identity for a ' +
      '`@unique` either: the guard a `@primaryKey` is taken under holds for both, so no ' +
      'key is derived and the plan’s own set is named in the notes',
    origins: ['bank_id=bank.id', 'n=—'],
    // The group key is NULL in every padded row — that is why it is no identity — while
    // `count` answers 0 over the rows it counted.
    notNull: ['n'],
    foreignKeys: ['(bank_id) references lab.bank (id)'],
    primaryKey: null
  },
  {
    view: 'v_group',
    about: 'a grouping key proxies; the aggregate beside it does not',
    origins: ['cur_code=tx.cur_code', 'n=—'],
    // `count` answers 0 over whatever rows there are, grouped or not.
    notNull: ['cur_code', 'n'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    // The group key is a key, and a key the plan makes of its own names no row of
    // `tx`: no relation is led to it.
    primaryKey: 'cur_code'
  },
  {
    view: 'v_window',
    about: 'a column beside a window function proxies; the window result does not',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'rn=—'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_distinct_src',
    about: 'DISTINCT drops rows and changes no value',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_over_view',
    about: 'a view over a view is rewritten away and reads like the base relation',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_varchar_to_text',
    about: 'varchar to text is binary-coercible: the datum is handed on untouched',
    origins: ['id=tx2.id', 'cur_code=tx2.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx2 (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_domain_to_base',
    about: 'a domain to the type it is over is the same value with fewer promises',
    origins: ['id=tx3.id', 'cur_code=tx3.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx3 (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cte',
    about:
      'a WITH query referenced twice is materialized, and its column names come from ' +
      'the view’s stored tree: each `live.col` is read at that column’s position in ' +
      'the subplan the WITH query computes',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'top_amount=—'],
    notNull: ['id', 'cur_code', 'top_amount'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id,cur_code'
  },
  {
    view: 'v_cte_aggregate',
    about:
      'a computed column of a materialized WITH query is read at the entry its ' +
      'subplan prints — here a count, never NULL',
    origins: ['cur_code=tx.cur_code', 'n=—'],
    notNull: ['cur_code', 'n'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_unique_key',
    about: 'a unique index is as good a key of the base table as the primary key',
    origins: ['code=asset.code'],
    notNull: ['code'],
    foreignKeys: [],
    primaryKey: 'code'
  },
  {
    view: 'm_tx',
    about:
      'a materialized view is read through its defining query, whose single range ' +
      'table entry EXPLAIN prints unqualified, and by the same non-nullness rule a ' +
      'plain view is: its stored copy of a never-`NULL` column holds no NULL either',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'amount=tx.amount'],
    // The same columns `v_bare` derives non-null over the same base table: a
    // materialized view carries no exception, and its key's columns are read as
    // never `NULL` here as they are there.
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },

  // ── Unions, where every branch has to be read or none of it counts ─────────────
  {
    view: 'v_union_same_column',
    about: 'every branch of the union proxies the same base column',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_union_same_target',
    about:
      'the branches proxy different base columns whose foreign keys lead to one ' +
      'table: every value is a legal key there, whichever branch it came from',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    // `id` is the primary key of two different tables: nothing is true of both.
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_union_null_branch',
    about: 'a branch contributing a NULL literal contributes no value and drops out',
    origins: ['id=refund.id|tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)'],
    primaryKey: null
  },
  {
    view: 'v_union_unreadable_branch',
    about: 'one branch the reader cannot read leaves the whole column unknown',
    origins: ['id=tx.id|wallet.id', 'cur_code=—'],
    notNull: ['id'],
    foreignKeys: [],
    primaryKey: null
  },

  // ── Negative: everything that looks like proxying and is not ───────────────────
  {
    view: 'v_coalesce',
    about: 'COALESCE takes the value from here or from there: it proxies neither',
    origins: ['id=tx.id', 'cur_code=—'],
    // `tx.cur_code` is never NULL, and one never-NULL arm is what `COALESCE` needs.
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(id) references lab.tx (id)'],
    // What COALESCE computes is no column; the join under it is still by `wallet`'s
    // key, so `tx`'s key is the view's.
    primaryKey: 'id'
  },
  {
    view: 'v_constant',
    about: 'a literal is nobody’s column, and never NULL either',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_truncating',
    about:
      'text to varchar(4) is binary-coercible and still truncates: no origins — ' +
      'but the value is the never-NULL column’s value or an error, never NULL',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_function',
    about: 'bigint to numeric goes through a function: a new datum for the same number',
    origins: ['id=tx.id', 'bank_id=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_distinct_over_union',
    about:
      'DISTINCT over a UNION prints a `Unique` or a de-duplicating `Aggregate` whose ' +
      'Output names one branch of two; the branches are read position by position and ' +
      'the group key over the union’s columns is the row identity',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'id,cur_code'
  },
  {
    view: 'v_self_join',
    about:
      'a table joined to itself: each column belongs to the instance its alias names, ' +
      'and no key is assembled across the two',
    origins: ['a_id=tx.id', 'b_cur_code=tx.cur_code'],
    notNull: ['a_id', 'b_cur_code'],
    foreignKeys: ['(a_id) references lab.tx (id)', '(b_cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_nullable_unique',
    about:
      'a unique index over a nullable column identifies no row of the table, so it is ' +
      'no @primaryKey — but no two rows share the value, which is a proven @unique',
    origins: ['tag=slot.tag'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null,
    unique: 'tag'
  },

  // ── Non-nullness: what the shape of the plan gives, and what it takes away ─────
  {
    view: 'v_collapsed_left_join',
    about:
      'the planner folds the LEFT JOIN into an inner one because the qualifier is ' +
      'strict, so a column the view spells nullable is NOT NULL in fact',
    origins: ['id=tx.id', 'title=bank.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_right_join',
    about: 'RIGHT JOIN, both sides: it nulls the outer one and keeps the inner one',
    origins: ['t_id=tx.id', 'title=bank.title'],
    notNull: ['title'],
    foreignKeys: ['(t_id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_full_join',
    about: 'FULL JOIN, both sides: it nulls both, and neither column survives NOT NULL',
    origins: ['t_id=tx.id', 'title=bank.title'],
    notNull: [],
    foreignKeys: ['(t_id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_nested_outer_join',
    about:
      'the nulled scan sits two joins below the outer join — and the planner states ' +
      'that outer join as a RIGHT one whose outer input is the nulled side, so the ' +
      'side is read off the plan rather than off the view’s LEFT JOIN',
    origins: ['id=refund.id', 'title=bank.title'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.refund (id)'],
    // The nulled side meets `refund` by `bank`'s key, whatever the plan calls the
    // join, so no `refund` row is repeated.
    primaryKey: 'id'
  },
  {
    view: 'v_union_null_over_not_null',
    about: 'a UNION branch spelling NULL makes the column nullable however NOT NULL the other is',
    origins: ['id=refund.id|tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_grouping_sets',
    about:
      'GROUP BY ROLLUP adds a superaggregate row that answers to no base row: the ' +
      'grouping column is NULL in it, and it is not a row of the table either — but ' +
      'count is 0 over the rows it counted, grand-total row included',
    origins: ['id=tx.id', 'n=—'],
    notNull: ['n'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_group_by_empty_count',
    about:
      'GROUP BY () reaches the plan as GROUPING SETS too: min over the one possibly ' +
      'empty group answers NULL, count does not',
    origins: ['lo=—', 'n=—'],
    notNull: ['n'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_group_count_rollup',
    about:
      'count survives the superaggregate rows of ROLLUP, counting every row the group ' +
      'holds and answering 0 for none — while the grouping column does not',
    origins: ['id=tx.id', 'n=—', 'some_n=—'],
    notNull: ['n', 'some_n'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_group_count_cube',
    about: 'and the same under CUBE, whose every subtotal group count counts over',
    origins: ['id=tx.id', 'n=—'],
    notNull: ['n'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_not_null_predicate',
    about:
      'WHERE bank_id IS NOT NULL leaves no NULL in the column, and the qualifier the ' +
      'plan applies to every row says so',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id', 'bank_id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cte_nulled_scan',
    about:
      'a column read through a materialized WITH query is read like any other; the ' +
      'outer join nulls the `CTE Scan` instance, so the column it pads stays nullable',
    origins: ['id=refund.id', 'a_code=tx.cur_code', 'b_code=tx.cur_code'],
    notNull: ['id', 'b_code'],
    foreignKeys: ['(id) references lab.refund (id)'],
    primaryKey: null
  },
  {
    view: 'v_union_ordered',
    about:
      'the union is read through whatever the planner puts over it: a `MergeAppend`, ' +
      'a `Sort` over an `Append`, or a `Gather Merge` over a parallel one',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_union_limited',
    about: 'a `Limit` over the union hides it no more than a `Sort` does',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_union_distinct',
    about:
      'a de-duplicating `UNION` is a grouping by every column over the union: read the ' +
      'same whether the planner hashes it or sorts it, and its key is the whole tuple',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'id,cur_code'
  },
  {
    view: 'v_cte_reordered_scans',
    about:
      'two scans of one WITH query print its columns in two different orders; the ' +
      'stored tree says which order is the query’s own, so each is read off its position',
    origins: ['id=refund.id', 'cur_code=tx.cur_code', 'b_cur_code=tx.cur_code'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.refund (id)'],
    primaryKey: null
  },

  // ── Views built on views: the boundary PostgreSQL leaves and the catalog crosses ─
  //
  // A security-barrier view is never flattened into the query above it, and a
  // `Subquery Scan` that projects fewer columns than its child is not the trivial one
  // `setrefs.c` removes. So the shape every published projection of this repository is
  // made of — a view over a barrier view, taking a subset of its columns — leaves a
  // node spelled `v_barrier.cur_code` and nothing else. The catalog says which
  // position of the inner view's select list that name stands at, and the child prints
  // that select list entry for entry.
  {
    view: 'v_barrier',
    about:
      'a barrier view asked for its whole select list is a trivial Subquery Scan and ' +
      'PostgreSQL removes it: the plan is the plan of the base table',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'bank_id=tx.bank_id', 'amount=tx.amount'],
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: [
      '(bank_id) references lab.bank (id)',
      '(cur_code) references lab.currency (code)',
      '(id) references lab.tx (id)'
    ],
    primaryKey: 'id'
  },
  {
    view: 'v_barrier_whole',
    about: 'a view that narrows nothing lets the barrier under it dissolve as well',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'bank_id=tx.bank_id', 'amount=tx.amount'],
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: [
      '(bank_id) references lab.bank (id)',
      '(cur_code) references lab.currency (code)',
      '(id) references lab.tx (id)'
    ],
    primaryKey: 'id'
  },
  {
    view: 'v_over_barrier',
    about:
      'a view over a barrier view taking a subset of its columns: the boundary stays, ' +
      'and is crossed by position — the key and the non-nullness survive it',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_barrier_over_barrier',
    about: 'a barrier over a barrier, narrowing once: one boundary in the plan',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'bank_id=tx.bank_id'],
    notNull: ['id', 'cur_code'],
    foreignKeys: [
      '(bank_id) references lab.bank (id)',
      '(cur_code) references lab.currency (code)',
      '(id) references lab.tx (id)'
    ],
    primaryKey: 'id'
  },
  {
    view: 'v_barrier_chain',
    about:
      'three levels, narrowing at each: two Subquery Scans one inside the other, and ' +
      'the descent is the same step taken twice',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_barrier_over_plain',
    about: 'a barrier over a plain view: the plain one is flattened into it and nothing is left',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_plain_over_barrier',
    about: 'a plain view over a barrier one, which is the ordinary surface shape',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_barrier_union',
    about:
      'a UNION ALL inside a barrier view is pulled up into the query above all the ' +
      'same, and reads as the union it is',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code', 'amount=—'],
    // `amount` is `tx.amount` in one branch and `0::numeric` in the other: each
    // branch proves it never NULL its own way.
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_over_barrier_union',
    about: 'and narrowing it from above does not change that',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_barrier_union_ordered',
    about:
      'an ORDER BY of its own stops the union being pulled up, so the boundary stays ' +
      'and the union stays under it',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code', 'amount=—'],
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_over_barrier_union_ordered',
    about:
      'the branches of that union are read one by one through the boundary: the ' +
      'descent lands on the select list of the crossed view, whatever shape it has',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },
  {
    view: 'v_barrier_computed',
    about: 'what the inner view computes is computed whichever side of the boundary reads it',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'loud=—', 'amount=tx.amount'],
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_over_barrier_computed',
    about: 'and it stays computed across it: the column beside it is read as usual',
    origins: ['id=tx.id', 'loud=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_barrier_narrowing',
    about:
      'the inner view truncates the value, so it is not the base column’s any more — ' +
      'the value and the nullability are separate questions',
    origins: ['id=tx.id', 'cur_code=—', 'amount=tx.amount'],
    notNull: ['id', 'cur_code', 'amount'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_over_barrier_narrowing',
    about:
      'and the outer view casting it back to the base type does not undo that: each ' +
      'step is binary-coercible on its own, and the chain of them is not',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_aliased_barrier',
    about:
      'the plan gives a Subquery Scan an alias and nothing else; the stored tree says ' +
      'which view that alias stands for, so `t` is crossed to the barrier view it names',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },

  // ── The rest of the closed list of refusals ────────────────────────────────────
  {
    view: 'v_null_column',
    about: 'a column that is a NULL literal all the way up has no base column at all',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_except',
    about:
      'EXCEPT prints its two branches directly and a column of the result is one ' +
      'branch’s value, never NULL only where both branches’ entries are not',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null,
    // PostgreSQL 17 and earlier wrap the `SetOp` in a `Subquery Scan`, so the columns
    // are not read and the view is refused whole; both answers hold back rather than
    // claim.
    alsoPlanRefusal: 'set-operation-not-a-select-list'
  },
  {
    view: 'v_intersect',
    about: 'and INTERSECT the same, a row of the result answering to both branches',
    origins: ['id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null,
    alsoPlanRefusal: 'set-operation-not-a-select-list'
  },
  {
    view: 'v_union_grouped',
    about:
      'a grouping over a `UNION ALL`: the group key proxies both branches and is the ' +
      'row identity, and sum/count read the union’s columns — a literal branch answers ' +
      'never NULL, so the aggregate is never NULL too',
    origins: ['sid=refund.id|tx.id', 'cur_code=refund.cur_code|tx.cur_code', 'total=—', 'n=—'],
    notNull: ['sid', 'cur_code', 'total', 'n'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'sid,cur_code'
  },
  {
    view: 'v_union_nested',
    about:
      'a set operation over another cannot tell its branches apart: the same spelling ' +
      'names a column of both, so no column is read',
    origins: null,
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_recursive',
    about: 'a recursive WITH reads its own output as one tagged stream: no branch',
    origins: null,
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_function_scan',
    about: 'a function scan carries an alias like any other scan and names no relation',
    origins: ['id=tx.id', 'val=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_values_scan',
    about: 'so does a VALUES list',
    origins: ['a=—', 'b=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_where_false',
    about:
      'a constant-false qualifier leaves a plan with no scan in it, while the select ' +
      'list still spells the relation that is not read — the stored tree still traces ' +
      'the columns to the base table, so their relations are led',
    origins: ['id=—', 'cur_code=—'],
    notNull: [],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: null
  },

  // ── The relations a view is led to on its own, before any projection ───────────
  //
  // These views exist for the pass that leads a relation to a projection, which is
  // an answer over a whole surface and not over one view; `derive` below is the
  // per-view half of it, so what a case here states is what the view carries before
  // any other view of the lab is looked at. The pass itself is held further down.
  {
    view: 'v_merchant',
    about: 'a barrier projection of `merchant`, and the only view that is a row of it',
    origins: ['id=merchant.id', 'title=merchant.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.merchant (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_invoice',
    about: 'the referencing side: `merchant_id` carries a real foreign key on `invoice`',
    origins: ['id=invoice.id', 'merchant_id=invoice.merchant_id'],
    notNull: ['id', 'merchant_id'],
    foreignKeys: ['(id) references lab.invoice (id)', '(merchant_id) references lab.merchant (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_ledger_by_code',
    about: 'a row of `ledger` by a unique index that is not its primary key',
    origins: ['code=ledger.code'],
    notNull: ['code'],
    foreignKeys: [],
    primaryKey: 'code'
  },
  {
    view: 'v_ledger_by_id',
    about: 'a row of the same table by the key no relation here points at',
    origins: ['id=ledger.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.ledger (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_entry',
    about: 'the referencing side of a foreign key that points at a unique index',
    origins: ['id=entry.id', 'ledger_code=entry.ledger_code'],
    notNull: ['id', 'ledger_code'],
    foreignKeys: ['(id) references lab.entry (id)', '(ledger_code) references lab.ledger (code)'],
    primaryKey: 'id'
  },
  {
    view: 'v_carrier_titled',
    about: 'one of two projections of `carrier` that are rows of it by the same key',
    origins: ['id=carrier.id', 'title=carrier.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.carrier (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_carrier_bare',
    about: 'and the other one',
    origins: ['id=carrier.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.carrier (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_parcel',
    about: 'the referencing side of the ambiguous case',
    origins: ['id=parcel.id', 'carrier_id=parcel.carrier_id'],
    notNull: ['id', 'carrier_id'],
    foreignKeys: ['(carrier_id) references lab.carrier (id)', '(id) references lab.parcel (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_depot_joined',
    about:
      'a view that carries `depot`\u2019s key and is not keyed by it: the join repeats ' +
      'every depot row once per crate, and the key the plan proves is the crate\u2019s',
    origins: ['id=depot.id', 'crate_id=crate.id'],
    notNull: ['id', 'crate_id'],
    foreignKeys: ['(crate_id) references lab.crate (id)', '(id) references lab.depot (id)'],
    primaryKey: 'crate_id'
  },
  {
    view: 'v_crate',
    about: 'the referencing side of the case with no keyed projection to lead to',
    origins: ['id=crate.id', 'depot_id=crate.depot_id'],
    notNull: ['id', 'depot_id'],
    foreignKeys: ['(depot_id) references lab.depot (id)', '(id) references lab.crate (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_node',
    about:
      'a projection of a self-referencing table: two relations at one key, one of ' +
      'them the row\u2019s own identity and the other the parent',
    origins: ['id=node.id', 'parent_id=node.parent_id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.node (id)', '(parent_id) references lab.node (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_crew',
    about:
      'a composite key carried under other names and in the other order: the key is ' +
      'matched as a set and each column is carried to the view column proxying it',
    origins: ['berth=crew.seat', 'vessel=crew.ship_code', 'name=crew.name'],
    notNull: ['berth', 'vessel', 'name'],
    foreignKeys: ['(vessel,berth) references lab.crew (ship_code,seat)'],
    primaryKey: 'vessel,berth'
  },
  {
    view: 'v_shift',
    about:
      'the referencing side of that composite key, whose own constraint spells it ' +
      'in a third order again',
    origins: ['id=shift.id', 'seat=shift.seat', 'ship_code=shift.ship_code'],
    notNull: ['id', 'seat', 'ship_code'],
    foreignKeys: [
      '(id) references lab.shift (id)',
      '(seat,ship_code) references lab.crew (seat,ship_code)'
    ],
    primaryKey: 'id'
  },

  // ── Non-nullness from the plan's own qualifiers ─────────────────────────────
  {
    view: 'v_joined_on_nullable',
    about:
      'a join on the column rejects a NULL in it, at the join or pushed into the ' +
      'inner scan of a nested loop',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id', 'bank_id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_filtered_to_literal',
    about: 'so does a filter to a literal',
    origins: ['id=slot.id', 'tag=slot.tag'],
    notNull: ['id', 'tag'],
    foreignKeys: ['(id) references lab.slot (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_semi_on_nullable',
    about: 'a semi join emits only rows that found a match',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id', 'bank_id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_partial_index_predicate',
    about:
      'a partial index on the predicate drops it from the scan; the predicate of ' +
      'the index the plan names is read instead',
    origins: ['id=ticket.id', 'code=ticket.code'],
    notNull: ['id', 'code'],
    foreignKeys: ['(id) references lab.ticket (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_union_both_filtered',
    about: 'every branch of the union rejects the NULL',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id', 'bank_id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_left_join_condition',
    about: 'an outer join keeps the rows its condition does not match',
    origins: ['id=tx.id', 'bank_id=tx.bank_id', 'title=bank.title'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_anti_on_nullable',
    about: 'an anti join keeps only those',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_disjunction_not_null',
    about: 'an arm of a disjunction holds of some rows, not of every row',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_subplan_condition',
    about:
      'a subplan\u2019s condition holds of the subplan\u2019s rows — and a `Gather` ' +
      'that computes the subplan itself is read where it prints the select list',
    origins: ['id=tx.id', 'bank_id=tx.bank_id', 'known=—'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_union_one_filtered',
    about: 'one branch rejects the NULL and the other does not',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: null
  },

  // ── Row identity: what keeps a key, what makes one, and what loses it ──────────
  {
    view: 'v_sale_store',
    about: 'a join by the other side’s own key multiplies no row of this one',
    origins: ['id=sale.id', 'store_code=store.code'],
    notNull: ['id', 'store_code'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_region',
    about: 'and a chain of such joins, through a relation the view does not show',
    origins: ['id=sale.id', 'title=region.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_right_store',
    about: 'the kept side is the preserved one, whichever side the view writes it on',
    origins: ['id=sale.id', 'code=store.code'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_slot',
    about:
      'a nullable unique index keys the other side of a join: the equality admits no ' +
      'NULL, so a row still meets at most one',
    origins: ['id=sale.id', 'slot_id=slot.id'],
    notNull: ['id', 'slot_id'],
    foreignKeys: ['(id) references lab.sale (id)', '(slot_id) references lab.slot (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_mooring_berth',
    about: 'a composite key of the other side, every column of it equated',
    origins: ['id=mooring.id', 'title=berth.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.mooring (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_mooring_first_slot',
    about: 'a column of that key equated to a literal is equated all the same',
    origins: ['id=mooring.id', 'title=berth.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.mooring (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_in_live_region',
    about:
      'a semi join emits each row once — and reads the same where the planner turns ' +
      'it into an inner join over a de-duplicated input',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_outside_regions',
    about: 'an anti join emits each row at most once',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_pairs',
    about:
      'two sides neither of which is unique given the other: the pair of their keys ' +
      'is a key, and it names no one row of either',
    origins: ['id=sale.id', 'other_id=sale.id'],
    notNull: ['id', 'other_id'],
    foreignKeys: ['(id) references lab.sale (id)', '(other_id) references lab.sale (id)'],
    primaryKey: 'id,other_id'
  },
  {
    view: 'v_barrier_sale',
    about: 'a barrier view over a many-to-one join',
    origins: ['id=sale.id', 'amount=sale.amount', 'code=store.code'],
    notNull: ['id', 'amount', 'code'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_over_barrier_sale',
    about: 'and a view narrowing it: the key crosses the boundary the way the value does',
    origins: ['id=sale.id', 'code=store.code'],
    notNull: ['id', 'code'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_distinct_region',
    about:
      'a de-duplicated subquery joined on every column it has: the shape the planner ' +
      'builds itself to turn a semi join into an inner one',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_store_totals',
    about:
      'a grouped subquery with an aggregate beside its key: whether a `Subquery Scan` ' +
      'hides its columns is the join method’s choice, so it pins nothing',
    origins: ['id=sale.id', 'n=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: null
  },
  {
    view: 'v_sale_in_shifted_store',
    about:
      'a semi join over an expression: its de-duplicated input groups by `st.id + 1`, ' +
      'emits `st.id`, and is pinned where the join equates that expression',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_lateral_grouping',
    about:
      'a lateral grouping tied to another relation: its filter holds of the rows it ' +
      'collapsed, so it determines nothing, and the key takes both relations',
    origins: ['id=sale.id', 'store_id=store.id'],
    notNull: ['id', 'store_id'],
    foreignKeys: ['(id) references lab.sale (id)', '(store_id) references lab.store (id)'],
    primaryKey: 'id,store_id'
  },
  {
    view: 'v_first_stores',
    about: 'a LIMIT keeps the key of what it limits',
    origins: ['id=store.id', 'code=store.code'],
    notNull: ['id', 'code'],
    foreignKeys: ['(id) references lab.store (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_sale_first_store',
    about:
      'a view that ends in a LIMIT is the top of a subquery under a join; the alias ' +
      'the plan gives it is resolved to the view, so its columns are read — the LIMIT ' +
      'alone makes no row identity, so the view still has no key',
    origins: ['id=sale.id', 'code=store.code'],
    notNull: ['id', 'code'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: null
  },
  {
    view: 'v_deferred_code',
    about: 'a deferrable unique constraint admits duplicates until commit: no key',
    origins: ['code=deferred_code.code'],
    notNull: ['code'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_mooring_dock',
    about: 'a join on part of the other side’s key multiplies',
    origins: ['id=mooring.id', 'title=berth.title'],
    notNull: ['id', 'title'],
    foreignKeys: ['(id) references lab.mooring (id)'],
    primaryKey: null
  },
  {
    view: 'v_sale_repeated',
    about: 'a one-to-many join repeats this side, and the key of the other is not shown',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: null
  },
  {
    view: 'v_sale_cast_join',
    about: 'a cast in the join condition equates the value to something else',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: null
  },
  {
    view: 'v_sale_or_join',
    about:
      'a disjunction equates nothing about any one row — not even where the planner ' +
      'splits it into the arms of a `BitmapOr`',
    origins: ['id=sale.id'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.sale (id)'],
    primaryKey: null
  },
  {
    view: 'v_group_store',
    about:
      'a group key of column references is a key, and the aggregate beside it is a ' +
      'value in every row of it: `sum` over a never-NULL column, grouped',
    origins: ['store_id=sale.store_id', 'code=store.code', 'amount=—'],
    notNull: ['store_id', 'code', 'amount'],
    foreignKeys: ['(store_id) references lab.store (id)'],
    primaryKey: 'store_id,code'
  },
  {
    view: 'v_distinct_code',
    about: 'so is what DISTINCT de-duplicates, planned as a `Unique` or as an `Aggregate`',
    origins: ['cur_code=tx.cur_code'],
    notNull: ['cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'cur_code'
  },
  {
    view: 'v_group_nullable',
    about:
      'a group key over a column that can be NULL is no row identity — but every row ' +
      'stands for a distinct combination, so the key is a proven @unique',
    origins: ['cur_code=tx.cur_code', 'bank_id=tx.bank_id', 'n=—'],
    notNull: ['cur_code', 'n'],
    foreignKeys: [
      '(bank_id) references lab.bank (id)',
      '(cur_code) references lab.currency (code)'
    ],
    primaryKey: null,
    unique: 'cur_code,bank_id'
  },
  {
    view: 'v_distinct_nullable',
    about: 'nor is a de-duplication over one — and it is a @unique all the same',
    origins: ['bank_id=tx.bank_id'],
    notNull: [],
    foreignKeys: ['(bank_id) references lab.bank (id)'],
    primaryKey: null,
    unique: 'bank_id'
  },
  {
    view: 'v_group_expression',
    about: 'a group key over an expression is a key of nothing the view can name',
    origins: ['loud=—', 'n=—'],
    notNull: ['n'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_union_discriminated',
    about:
      'a union whose branches each write their own text literal into one column: that ' +
      'column with a key of every branch is a key',
    origins: ['source=—', 'id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['source', 'id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'source,id'
  },
  {
    view: 'v_union_discriminated_joined',
    about: 'a branch keyed through a many-to-one join is keyed all the same',
    origins: ['source=—', 'id=sale.id|tx.id', 'code=store.code|tx.cur_code'],
    notNull: ['source', 'id', 'code'],
    foreignKeys: [],
    primaryKey: 'source,id'
  },
  {
    view: 'v_barrier_discriminated',
    about: 'the discriminated union inside a barrier view',
    origins: ['source=—', 'id=tx.id|wallet.id', 'cur_code=tx.cur_code|wallet.cur_code', 'amount=—'],
    notNull: ['source', 'id', 'cur_code', 'amount'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'source,id'
  },
  {
    view: 'v_over_barrier_discriminated',
    about: 'and across its boundary, branch by branch',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['source', 'id'],
    foreignKeys: [],
    primaryKey: 'source,id'
  },
  {
    view: 'v_barrier_discriminated_ordered',
    about: 'a discriminated union in a barrier view whose ORDER BY keeps its boundary',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['source', 'id'],
    foreignKeys: [],
    primaryKey: 'source,id'
  },
  {
    view: 'v_over_barrier_discriminated_cast',
    about: 'a cast over the discriminator across that boundary can make two literals one',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['source', 'id'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_union_varchar_lengths',
    about: 'one text in two lengths is one value, not two discriminators',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['source', 'id'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_union_same_literal',
    about: 'one literal in two branches tells them apart no more than none',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['source', 'id'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_union_numeric_literal',
    about: 'a numeric literal is no discriminator: two spellings can be one number',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['source', 'id'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_union_null_discriminator',
    about: 'a NULL is no literal of a branch of its own',
    origins: ['source=—', 'id=tx.id|wallet.id'],
    notNull: ['id'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_union_discriminated_unkeyed',
    about: 'the branches are told apart, and the rows of one branch are not',
    origins: ['source=—', 'cur_code=tx.cur_code|wallet.cur_code'],
    notNull: ['source', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
  },

  // ── Non-nullness of computed columns: what a select-list expression proves ────
  {
    view: 'v_expr_literal',
    about: 'a literal is never NULL, however cast',
    origins: ['id=tx.id', 'code=—', 'zero=—'],
    notNull: ['id', 'code', 'zero'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_coalesce',
    about:
      'a COALESCE with one never-NULL arm never is — a literal, or a nested COALESCE ' +
      'over a NULL literal and a literal',
    origins: ['id=tx.id', 'bank_id=—', 'nested=—'],
    notNull: ['id', 'bank_id', 'nested'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_coalesce_nullable',
    about: 'every arm nullable is a nullable COALESCE',
    origins: ['id=tx.id', 'b=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_case_else',
    about:
      'a complete CASE over never-NULL arms, the arms themselves CASE and COALESCE — ' +
      'the rules compose at any depth',
    origins: ['id=tx.id', 'filled=—'],
    notNull: ['id', 'filled'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_case_no_else',
    about: 'a CASE without ELSE answers NULL on its last arm',
    origins: ['id=tx.id', 'filled=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_case_nullable_arm',
    about: 'an ELSE over a nullable column does not repair the CASE',
    origins: ['id=tx.id', 'filled=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_group_count',
    about: 'count answers 0 over what it counted, however it counted',
    origins: ['cur_code=tx.cur_code', 'n=—', 'nb=—', 'nd=—'],
    notNull: ['cur_code', 'n', 'nb', 'nd'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'cur_code'
  },
  {
    view: 'v_expr_group_values',
    about:
      'min/max/sum/avg over a NOT NULL column answer a value in every row of a ' +
      'grouping: each row stands for a non-empty group',
    origins: ['cur_code=tx.cur_code', 'lo=—', 'hi=—', 'total=—', 'mean=—'],
    notNull: ['cur_code', 'lo', 'hi', 'total', 'mean'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'cur_code'
  },
  {
    view: 'v_expr_aggregate_whole_input',
    about: 'over the whole input they answer NULL when it is empty; count does not',
    origins: ['hi=—', 'total=—', 'n=—'],
    notNull: ['n'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_expr_group_nullable_argument',
    about: 'so do they over a nullable column, group or no group',
    origins: ['cur_code=tx.cur_code', 'hi=—'],
    notNull: ['cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'cur_code'
  },
  {
    view: 'v_expr_group_filtered',
    about: 'a FILTER can drop every row of the group the aggregate would have seen',
    origins: ['cur_code=tx.cur_code', 'hi=—'],
    notNull: ['cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'cur_code'
  },
  {
    view: 'v_expr_operators',
    about:
      'the whitelisted operators over never-NULL operands are a value or an error; ' +
      'the IS forms are a boolean whatever the operand',
    origins: ['id=tx.id', 'plus=—', 'twice=—', 'glued=—', 'absent=—', 'other=—'],
    notNull: ['id', 'plus', 'twice', 'glued', 'absent', 'other'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_operator_nullable',
    about: 'a nullable operand is a NULL result for the same operators',
    origins: ['id=tx.id', 'plus=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_function',
    about: 'a function’s name proves nothing, however strict the function',
    origins: ['id=tx.id', 'loud=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_window',
    about: 'a window function runs per frame, and a frame can be empty',
    origins: ['id=tx.id', 'rn=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_cast',
    about:
      'a cast hands its operand’s answer on — here the cast truncates, so the column ' +
      'has no origins at all, and is still never NULL',
    origins: ['id=tx.id', 'code=—'],
    notNull: ['id', 'code'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_nullif',
    about: 'NULLIF answers NULL whenever its arguments compare equal',
    origins: ['id=tx.id', 'code=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_union_literal',
    about:
      'a union column is never NULL only where every branch proves it — here a ' +
      'COALESCE in one and a literal in the other',
    origins: ['id=tx.id', 'bank_id=—'],
    notNull: ['id', 'bank_id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_expr_union_nullable_branch',
    about: 'one branch that can be NULL makes the union column nullable',
    origins: ['id=tx.id', 'bank_id=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_barrier_expr',
    about: 'a computed column asked for with the barrier’s whole list reads like the scan',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'bank_filled=—'],
    notNull: ['id', 'cur_code', 'bank_filled'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_over_barrier_expr',
    about: 'and across the boundary: the expression one step down proves it there',
    origins: ['id=tx.id', 'bank_filled=—'],
    notNull: ['id', 'bank_filled'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_ordered_aggregate',
    about:
      'an aggregate call with ORDER BY inside is still a call, and the literal arm ' +
      'of the COALESCE around it answers on its own',
    origins: ['cur_code=tx.cur_code', 'glued=—'],
    notNull: ['cur_code', 'glued'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: 'cur_code'
  },
  {
    view: 'v_expr_group_under_outer_join',
    about:
      'an outer join over a grouping pads the computed column with NULL the same way ' +
      'it pads a base column — the join equates a cast, so no key is carried either',
    origins: ['id=refund.id', 'n=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.refund (id)'],
    primaryKey: null
  },
  {
    view: 'v_expr_group_over_join',
    about:
      'an inner join over the same grouping pads nothing: the count crosses the ' +
      'boundary and is never NULL here',
    origins: ['id=refund.id', 'n=—'],
    notNull: ['id', 'n'],
    foreignKeys: ['(id) references lab.refund (id)'],
    primaryKey: null
  },

  // ── What a cast preserves, and what it does not ───────────────────────────────
  //
  // A cast is not a shape whose SQL definition is the claim: `jsonb` to `integer`
  // answers NULL for the `jsonb` null, and a user `CREATE CAST` may answer NULL
  // wherever its function likes. The plan prints the target type by name and
  // nothing of the operand's, so a cast is transparent only where both ends are
  // one family PostgreSQL defines to answer a value for every input.
  {
    view: 'v_cast_text_to_varchar',
    about: 'text to varchar is binary-coercible, so a NOT NULL column stays NOT NULL',
    origins: ['id=tx.id', 'cur_code=tx.cur_code'],
    notNull: ['id', 'cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_int_to_numeric',
    about:
      'bigint to numeric goes through a function, and that function answers a value ' +
      'for every input: the value is no longer proxied, but it is never NULL',
    origins: ['id=document.id', 'scaled=—'],
    notNull: ['id', 'scaled'],
    foreignKeys: ['(id) references lab.document (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_jsonb_to_int',
    about:
      'jsonb to integer answers NULL for the jsonb null: a NOT NULL column is not ' +
      'NOT NULL through it',
    origins: ['id=document.id', 'payload=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.document (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_user_defined',
    about:
      'a user-defined cast whose function answers NULL for a non-NULL input proves ' +
      'nothing about the column',
    origins: ['id=document.id', 'mystery_id=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.document (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_is_tests',
    about:
      'the IS TRUE/FALSE/UNKNOWN tests answer a boolean whatever the operand, however ' +
      'NULL it is — the deparser prints their targets in upper case',
    origins: [
      'id=document.id',
      'is_true=—',
      'is_not_true=—',
      'is_false=—',
      'is_not_false=—',
      'is_unknown=—',
      'is_not_unknown=—'
    ],
    notNull: [
      'id',
      'is_true',
      'is_not_true',
      'is_false',
      'is_not_false',
      'is_unknown',
      'is_not_unknown'
    ],
    foreignKeys: ['(id) references lab.document (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_expr_group_by_empty',
    about:
      'GROUP BY () groups the whole input into one group that may be empty, so an ' +
      'aggregate over it answers NULL when the input is empty',
    origins: ['lo=—', 'mean=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_name_shadowed',
    about:
      'a WITH name two query levels share cannot be told apart in the plan, so neither ' +
      '`live` is read: a reader that took the first subplan would call `inner_x.y` — ' +
      'really `need.nul` — never NULL',
    origins: ['x=—', 'y=—'],
    notNull: [],
    foreignKeys: ['(x) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_name_shadowed_fk',
    about:
      'and a reader that took the first subplan would lead `inner_x.inner_v` — really ' +
      '`need.nn`, no key — to `need` over `need_ref.need_id`’s foreign key',
    origins: ['v=—', 'inner_v=—'],
    notNull: [],
    foreignKeys: ['(v) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_where_false',
    about:
      'a constant array in the stored tree (what `WHERE false` writes) does not break ' +
      'the walk: the WITH query is read into the map and the columns’ origins resolve, ' +
      'while the plan carries no scan a constant-false qualifier removed',
    origins: ['id=—', 'cur_code=—'],
    notNull: [],
    foreignKeys: ['(cur_code) references lab.currency (code)', '(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_src',
    about: 'the source view of the cross-view clash: its own `live` reads as usual',
    origins: ['k=need.id', 'x=need.nul'],
    notNull: ['k'],
    foreignKeys: ['(k) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_src_fk',
    about: 'and the source of the key variant: `x` is `child.plain`, no key',
    origins: ['k=child.id', 'x=child.plain'],
    notNull: ['k', 'x'],
    foreignKeys: ['(k) references lab.child (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_view',
    about:
      'the analysed view and its source both define `live`; the plan spells the ' +
      'source’s `CTE Scan` `live` and never says which view’s query it is, so `sx` is ' +
      'refused rather than read off the source’s subplan — really `need.nul`, the wrong ' +
      '`live` would call it never NULL',
    origins: ['oy=need.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_view_fk',
    about:
      'the same with a key in play: the wrong `live` would lead `sx` — really ' +
      '`child.plain` — to `parent` over `child.ref`’s foreign key',
    origins: ['oy=child.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.child (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_mid',
    about: 'a source reached through two views, so the clash is not direct to the asked one',
    origins: ['k=need.id', 'x=need.nul'],
    notNull: ['k'],
    foreignKeys: ['(k) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_src2',
    about:
      'a view over a materialized `WITH` query it does not define reads no column off ' +
      'it: its own tree names no such query, and the source’s is not its to read',
    origins: ['k=—', 'x=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_view_two',
    about:
      'the clash reached through two views: the name is dropped from the closure, so the ' +
      'column is refused all the same',
    origins: ['oy=need.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_cross_src_once',
    about: 'a source whose `live` is inlined reads its base column directly',
    origins: ['k=need.id', 'x=need.nul'],
    notNull: ['k'],
    foreignKeys: ['(k) references lab.need (id)'],
    primaryKey: 'k'
  },
  {
    view: 'v_cte_cross_view_inlined',
    about:
      'both `live` queries inlined: the plan carries no subplan of that name, so `sx` is ' +
      'the base `need.nul` read directly and stays nullable',
    origins: ['oy=need.id', 'sx=need.nul'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: 'oy'
  },
  {
    view: 'v_cte_foreign_view',
    about:
      'the source `live` stands in a view outside the surface, whose tree is never read: ' +
      'the one `CTE live` subplan prints three columns where the analysed view’s has two, ' +
      'so it is not proved to be its own and `sx` — really the foreign `need.nul` — is refused',
    origins: ['oy=need.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_foreign_view_fk',
    about:
      'and with a key: the unproved subplan would lead `sx` — really `child.plain` — to ' +
      '`parent` over the foreign `child.ref`',
    origins: ['oy=child.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.child (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_coinciding',
    about:
      'a foreign subplan whose every column’s origin lines up is still another query’s: ' +
      'its scan carries that query’s range-table alias, not this view’s, so `sx` is refused',
    origins: ['oy=need.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_swap_src',
    about: 'the source of the swap: its own `live` reads as usual',
    origins: ['q=need.nul', 'p=need.nn'],
    notNull: ['p'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_swap',
    about:
      'the foreign `live` matches the view’s own by origin — `[nul, nn]` both ways — but ' +
      'carries its columns as `q, p` where the view’s are `p, q`: the foreign scan is not ' +
      'this view’s range-table entry, so `sq` and `sp` are refused, not read off the wrong ' +
      'positions',
    origins: ['op=need.nul', 'sq=—', 'sp=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_swap_src_fk',
    about: 'the swap’s key variant source: its own `live` reads as usual',
    origins: ['q=child.plain', 'p=child.ref'],
    notNull: ['q', 'p'],
    foreignKeys: ['(p) references lab.parent (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_swap_fk',
    about:
      'and with a key: the swapped foreign scan would read `ref` where the view means ' +
      '`plain`, leading a foreign key the rows do not carry — refused',
    origins: ['op=child.plain', 'sq=—', 'sp=—'],
    notNull: ['op'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_function_lateral',
    about:
      'an inlined SQL function with its own `live` reached through `LATERAL`: nothing is ' +
      'read off the unproved subplan, and the function’s scan is not crossed either',
    origins: ['oy=need.id', 'sy=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_function',
    about: 'and the same function in the FROM list rather than after `LATERAL`',
    origins: ['oy=need.id', 'sy=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_function_fk',
    about: 'the function variant with a key in play',
    origins: ['oy=child.id', 'sx=—'],
    notNull: ['oy'],
    foreignKeys: ['(oy) references lab.child (id)'],
    primaryKey: null
  },
  {
    view: 'v_cte_alias_src',
    about: 'the same-alias source: its own `live` is referenced twice and reads as usual',
    origins: ['q=need.nul', 'p=need.nn'],
    notNull: ['p'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_alias',
    about:
      'the view’s own `live` is referenced once, so the default inlines it and it has no ' +
      'scan; the only `CTE live` is the source’s, whose columns are `q, p` where the ' +
      'view’s are `p, q` — the alias matches but proves nothing, so `sq` and `sp` are refused',
    origins: ['op=need.nul', 'sq=—', 'sp=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_ab_src',
    about: 'the twice-referenced source `live` is materialized and reads as usual',
    origins: ['q=need.nul', 'p=need.nn'],
    notNull: ['p'],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_ab',
    about:
      'both `live` queries are referenced twice, so both materialize: the plan carries ' +
      'two `CTE live` subplans, nothing says which a scan reads, and the columns are refused',
    origins: ['op=—', 'oq=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_ref_once',
    about:
      'a `WITH` query referenced once is inlined, so its columns come off the base ' +
      'relation directly and read as usual',
    origins: ['p=need.id', 'q=need.nn'],
    notNull: ['p', 'q'],
    foreignKeys: ['(p) references lab.need (id)'],
    primaryKey: 'p'
  },
  {
    view: 'v_cte_not_materialized',
    about: 'and `NOT MATERIALIZED` inlines even a repeated `WITH` query',
    origins: ['p=need.id', 'q=need.nn'],
    notNull: ['p', 'q'],
    foreignKeys: ['(p) references lab.need (id)'],
    primaryKey: 'p'
  },
  {
    view: 'v_cte_volatile',
    about:
      'a `WITH` query the tree reads as inlined, but a volatile body materializes: the ' +
      'reader refuses rather than trust the prediction',
    origins: ['p=—', 'q=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_recursive',
    about: 'a recursive `WITH` reads its own output as one tagged stream',
    origins: null,
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_oj_expr_src',
    about:
      'the source of the outer-join cases: a literal, a cast, an `IS` test, a `CASE` and a ' +
      '`COALESCE` over a NOT NULL column are all never NULL where they are computed',
    origins: ['id=need.id', 'c=—', 'n=—', 'f=—', 'g=—', 'cs=—', 'co=—', 'gr=—'],
    notNull: ['id', 'c', 'n', 'f', 'g', 'cs', 'co', 'gr'],
    foreignKeys: ['(id) references lab.need (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_oj_expr',
    about:
      'a LEFT join nulls its inner side in every padded row, so each computed column of ' +
      'that side — literal, cast, `IS NULL`, `IS DISTINCT FROM`, `CASE`, `COALESCE`, ' +
      '`GREATEST` — is refused, not claimed never NULL',
    origins: ['aid=need.id', 'c=—', 'n=—', 'f=—', 'g=—', 'cs=—', 'co=—', 'gr=—'],
    notNull: ['aid'],
    foreignKeys: ['(aid) references lab.need (id)'],
    primaryKey: 'aid'
  },
  {
    view: 'v_oj_full',
    about: 'and a FULL join leaves either side nullable the same way',
    origins: ['aid=need.id', 'c=—', 'n=—'],
    notNull: [],
    foreignKeys: ['(aid) references lab.need (id)'],
    primaryKey: null
  },
  {
    view: 'v_oj_above',
    about: 'a literal computed at the join, above the nulling of its inputs, is not nulled by it',
    origins: ['aid=need.id', 'lit=—'],
    notNull: ['aid', 'lit'],
    foreignKeys: ['(aid) references lab.need (id)'],
    primaryKey: 'aid'
  },
  {
    view: 'v_oj_preserved',
    about: 'so is an expression over a column of the preserved side',
    origins: ['aid=need.id', 'preserved=—'],
    notNull: ['aid', 'preserved'],
    foreignKeys: ['(aid) references lab.need (id)'],
    primaryKey: 'aid'
  },
  {
    view: 'v_oj_union_src',
    about: 'the discrimination source: its `UNION ALL` discriminator is a key of its rows',
    origins: ['src=—', 'id=need.id', 'nn=need.nn'],
    notNull: ['src', 'id', 'nn'],
    foreignKeys: ['(id) references lab.need (id)'],
    primaryKey: 'src,id'
  },
  {
    view: 'v_oj_union',
    about:
      'a `UNION ALL` discriminator read from the nulled side is no discriminator and its ' +
      'column is refused',
    origins: ['aid=need.id', 'src=—'],
    notNull: ['aid'],
    foreignKeys: ['(aid) references lab.need (id)'],
    primaryKey: null
  }
]

for (const testCase of CASES) {
  test(`${testCase.view}: ${testCase.about}`, () => {
    const derived = derive(testCase.view)
    // A plan shape the running major builds differently may refuse the view whole; the
    // expectations are for the major the fixture here was built on.
    if (
      testCase.alsoPlanRefusal !== undefined &&
      derived.planRefusal === testCase.alsoPlanRefusal
    ) {
      return
    }
    assert.deepEqual(derived.origins, testCase.origins)
    assert.deepEqual(derived.notNull, testCase.notNull)
    assert.deepEqual(derived.foreignKeys, testCase.foreignKeys)
    assert.equal(derived.primaryKey, testCase.primaryKey)
    assert.equal(derived.unique, testCase.unique ?? null)
  })
}

test('every view in the fixture is a case, and every case is in the fixture', () => {
  assert.deepEqual(
    CASES.map((testCase) => testCase.view).sort(),
    [
      ...new Set(
        fixture.views.filter((view) => view.regime === DEFAULT_REGIME).map((view) => view.view)
      )
    ].sort()
  )
})

// The one property that makes the derivation a contract rather than a reading of
// today's plan. Which plan the planner hands back is its judgement of cost, and the
// regimes in the fixture move that judgement: a `UNION ALL` arrives as an `Append` at
// the root, as a `Gather` over a parallel one, as a `MergeAppend`, or as a `Sort`
// over an `Append`, and `SELECT DISTINCT` arrives as a hashed `Aggregate` or as a
// `Unique` over a `Sort`. None of it may change the answer — including the cases
// where the answer is "nothing", which have to be nothing every time rather than
// nothing on the days the plan is shaped wrong.
// The contract is what reaches the published schema — the origins a column has, the
// relations and keys derived, and whether the plan was read at all — and it is what
// `invariance.ts` holds across regimes. The per-column refusal *text* and the notes are
// diagnostics, and the same shape of plan may name a different reason for the same
// outcome (a column with no source either way); they are left out of the comparison.
const contractOf = (derived: ReturnType<typeof derive>): unknown => ({
  origins: derived.origins,
  notNull: derived.notNull,
  foreignKeys: derived.foreignKeys,
  primaryKey: derived.primaryKey,
  unique: derived.unique,
  planRefusal: derived.planRefusal
})
for (const regime of REGIMES.filter((name) => name !== DEFAULT_REGIME)) {
  test(`the derivation of every lab view is the same under ${regime}`, () => {
    for (const testCase of CASES) {
      assert.deepEqual(
        contractOf(derive(testCase.view, regime)),
        contractOf(derive(testCase.view)),
        `${testCase.view} derives differently under ${regime}`
      )
    }
  })
}

test('a key whose columns are never NULL is a @primaryKey and never also a @unique', () => {
  // The two are one reading of the plan at different strengths: where a never-null
  // key exists it is the `@primaryKey`, and `PgFakeConstraintsPlugin` already makes
  // that key's rows unique, so a second `@unique` over the same columns would publish
  // a second constraint saying nothing new.
  assert.equal(derive('v_bare').primaryKey, 'id')
  assert.equal(derive('v_bare').unique, null)
})

test('uniqueness derivation can be turned off, and the refusal of a key is named again', () => {
  const view = fixture.views.find(
    (candidate) => candidate.view === 'v_nullable_unique' && candidate.regime === DEFAULT_REGIME
  )
  assert.ok(view)
  const deriveWith = (deriveUnique: boolean) =>
    deriveViewConstraints(
      view.schema,
      view.view,
      view.relkind,
      view.columns,
      readPlanOrigins(
        view.plan,
        view.columns.length,
        subqueryViewCandidates(fixture.viewSources, view.schema, view.view),
        planCatalog
      ),
      catalog,
      coercions,
      deriveUnique
    )
  assert.equal(deriveWith(true).unique?.tag, 'tag')
  const off = deriveWith(false)
  assert.equal(off.unique, null)
  assert.ok(
    off.notes.some((note) => note.startsWith('no key:')),
    'with uniqueness off the key is named as a refusal again'
  )
})

test('where the plan and the stored tree name different base columns, the column is refused', () => {
  const view = fixture.views.find(
    (candidate) => candidate.view === 'v_bare' && candidate.regime === DEFAULT_REGIME
  )
  assert.ok(view)
  const plan = readPlanOrigins(view.plan, view.columns.length, new Map(), planCatalog)
  const derived = deriveViewConstraints(
    view.schema,
    view.view,
    view.relkind,
    view.columns,
    plan,
    catalog,
    coercions,
    true,
    // The tree traces column 0 to a different base table than the plan did.
    new Map([[0, { schema: 'lab', relation: 'currency', column: 'code', relkind: 'r' }]])
  )
  assert.equal(derived.columns[0], 'id')
  assert.equal(derived.origins?.[0], null)
  assert.equal(derived.columnRefusals[0], 'plan-and-tree-disagree')
  // The column is refused whole: the tree side, which named `currency.code` for it, is
  // not read for a foreign key either, and the column is not non-null.
  assert.deepEqual(
    derived.foreignKeys.map((foreignKey) => foreignKey.tag),
    ['(cur_code) references lab.currency (code)']
  )
  assert.deepEqual(derived.notNullColumns, ['cur_code'])
  // A column with no tree entry is left exactly as the plan read it.
  assert.ok(derived.origins?.[1])
})

test('a user object anywhere in the database stands its rule spelling down for every view', () => {
  // A plan prints a name, not the object the name stands for, so a user `count` is
  // printed exactly like the built-in. The stand-down is taken over the whole database
  // rather than over one view's dependencies: a user object a view reaches only through
  // an inlined function's body leaves no dependency edge on the view, and a per-view set
  // would miss it and trust the built-in's rule for someone else's object. So every
  // view loses the rule the moment any user object takes the spelling.
  assert.ok(derive('v_expr_group_count').notNull.includes('n'))
  const shadowed = new Set(['count'])
  assert.equal(derive('v_expr_group_count', DEFAULT_REGIME, shadowed).notNull.includes('n'), false)
  // `count(bank_id)` and `count(distinct bank_id)` read the same spelling and stand down
  // with it; nothing else in the view moves.
  assert.deepEqual(derive('v_expr_group_count', DEFAULT_REGIME, shadowed).notNull, ['cur_code'])
  // The lab itself holds no object under a spelling the rules lean on, so every view
  // above keeps its rules in force.
  assert.deepEqual([...shadowedNames], [])
})

test('a bare built-in spelling reached through an inlined function’s body is refused, not trusted', () => {
  // The form a per-view set falls for: a view calls a user function that PostgreSQL
  // inlines, whose body calls a user object under a built-in spelling. The plan for the
  // view prints that name bare, and the view's own dependencies name only the function,
  // so a per-view set is empty where the plan really prints a user object. The global
  // stand-down closes it: the same spelling stands down for every view, table and schema,
  // so no view is left trusting the built-in for the user's object.
  // A qualified call names the object itself and keeps the rule: `pg_catalog.count` is
  // the built-in wherever it is printed, whatever spelling a user object took.
  const asker = (shadowed: (name: string) => boolean) => ({
    column: () => 'never-null' as const,
    hasGroupKey: false,
    shadowed
  })
  assert.equal(
    evaluateExpression(
      parseExpression('count((x)::integer)'),
      asker((name) => name === 'count')
    ),
    'unknown'
  )
  assert.equal(
    evaluateExpression(
      parseExpression('pg_catalog.count((x)::integer)'),
      asker((name) => name === 'count')
    ),
    'never-null'
  )
})

test('the shadow set is read once over the whole catalog, not per view', async () => {
  // The set is one answer for the database, so it is asked once from the functions,
  // operators and types themselves and never from a view's dependencies (`pg_rewrite`).
  const issued: string[] = []
  const query: RunQuery = async <Row>(text: string) => {
    issued.push(text)
    return [{ name: 'count' }, { name: 'integer' }] as Row[]
  }
  const names = await readShadowedNames(query)
  assert.deepEqual([...names].sort(), ['count', 'integer'])
  assert.equal(issued.length, 1)
  assert.match(issued[0] ?? '', /pg_proc/)
  assert.match(issued[0] ?? '', /pg_operator/)
  assert.match(issued[0] ?? '', /pg_type/)
  assert.doesNotMatch(issued[0] ?? '', /pg_rewrite/)
})

test('a view’s stored tree is read by field name, and a format it does not know yields nothing', () => {
  // `view-tree.ts` walks `pg_node_tree`, not SQL. This hand-written tree holds the
  // fields it reads; the lab fixture is the real guard, a case per version, since a
  // major-version change to the format would leave the CTE lab views unread.
  const action =
    '({QUERY :targetList ({TARGETENTRY :expr <> :resno 1 :resname id :resorigtbl 99 :resorigcol 3}' +
    ' {TARGETENTRY :expr <> :resno 2 :resname nm :resorigtbl 0 :resorigcol 0})' +
    ' :cteList ({COMMONTABLEEXPR :ctename live :ctecolnames ("a" "b")})})'
  const tree = readViewTree(action)
  assert.equal(tree.ok, true)
  assert.deepEqual(Object.fromEntries(tree.cteColumns), { live: ['a', 'b'] })
  assert.deepEqual([...tree.treeOrigins.entries()], [[0, { tableId: 99, attnum: 3 }]])
  // A range-table alias resolves to the relation it stands for, wherever in the tree
  // the entry stands; an entry that is not a relation names none.
  assert.deepEqual(
    Object.fromEntries(
      readViewTree(
        '({QUERY :cteList <> :targetList <> :rtable' +
          ' ({RANGETBLENTRY :alias {ALIAS :aliasname bank_range :colnames <>}' +
          ' :rtekind 0 :relid 42} {RANGETBLENTRY :alias {ALIAS :aliasname s :colnames <>}' +
          ' :rtekind 1 :relid 0})})'
      ).relationAliases
    ),
    { bank_range: 42 }
  )
  // An identifier with a space is one escaped token, not two.
  assert.deepEqual(
    Object.fromEntries(
      readViewTree(
        '({QUERY :targetList <> :cteList ({COMMONTABLEEXPR :ctename *S*\\ 1 :ctecolnames ("x")})})'
      ).cteColumns
    ),
    { '*S* 1': ['x'] }
  )
  // A `WITH` name at two query levels is ambiguous: the plan spells both by it and
  // cannot say which a `CTE Scan` reads, so neither is taken.
  const shadowed = readViewTree(
    '({QUERY :targetList <> :cteList ({COMMONTABLEEXPR :ctename live :ctecolnames ("a")})' +
      ' :rtable ({RANGETBLENTRY :rtekind 1 :alias <> :subquery {QUERY :cteList' +
      ' ({COMMONTABLEEXPR :ctename live :ctecolnames ("b")}) :targetList <>}})})'
  )
  assert.deepEqual(Object.fromEntries(shadowed.cteColumns), {})
  assert.deepEqual([...shadowed.cteAmbiguous], ['live'])
  // A constant array (`:constvalue […]`) is read, not treated as a format break.
  assert.equal(
    readViewTree(
      '({QUERY :cteList <> :targetList <> :jointree {FROMEXPR :quals {CONST :constvalue 1 [ 0 0 ]}}})'
    ).ok,
    true
  )
  // A field the reader needs on a node it reads, missing, is a format change: the whole
  // tree fails rather than hand back a partial answer.
  assert.equal(readViewTree('({QUERY :cteList <> :targetList <>})').ok, true)
  assert.equal(readViewTree('({QUERY :nonesuch 1})').ok, false)
  assert.equal(
    readViewTree('({QUERY :cteList ({COMMONTABLEEXPR :ctename live}) :targetList <>})').ok,
    false
  )
  for (const garbage of ['', 'not a tree', '({QUERY])', '({QUERY :x (unclosed}']) {
    const broken = readViewTree(garbage)
    assert.equal(broken.ok, false, JSON.stringify(garbage))
    assert.deepEqual(Object.fromEntries(broken.cteColumns), {})
    assert.deepEqual([...broken.treeOrigins], [])
  }
})

test('the lab holds the stored-tree shapes the reader must survive', () => {
  const facts = (view: string) =>
    fixture.views.find(
      (candidate) => candidate.view === view && candidate.regime === DEFAULT_REGIME
    )
  assert.equal(facts('v_cte_where_false')?.treeOk, true)
  assert.deepEqual(facts('v_cte_where_false')?.cteColumns, { live: ['id', 'cur_code'] })
  assert.deepEqual(facts('v_cte_name_shadowed')?.cteAmbiguous, ['live'])
  assert.deepEqual(facts('v_cte_name_shadowed')?.cteColumns, {})
})

test('a built-in the deparser qualified pg_catalog is the built-in; another schema is a user function', () => {
  // Where a same-named function shadows the built-in in the search path, the deparser
  // prints the built-in qualified — `pg_catalog.count(...)` — precisely because the bare
  // spelling no longer resolves to it. That qualified call is the built-in, so its rule
  // holds; a call under another schema is that schema's own function and holds nothing.
  const asker = (shadowed: (name: string) => boolean) => ({
    column: () => 'never-null' as const,
    hasGroupKey: false,
    shadowed
  })
  assert.equal(
    evaluateExpression(
      parseExpression('pg_catalog.count((x)::integer)'),
      asker(() => false)
    ),
    'never-null'
  )
  // The rule holds even where the view took a user `count` elsewhere: the qualified
  // spelling is the built-in regardless.
  assert.equal(
    evaluateExpression(
      parseExpression('pg_catalog.count((x)::integer)'),
      asker((name) => name === 'count')
    ),
    'never-null'
  )
  assert.equal(
    evaluateExpression(
      parseExpression('adv.count((x)::integer)'),
      asker(() => false)
    ),
    'unknown'
  )
  assert.equal(
    evaluateExpression(
      parseExpression('count((x)::integer)'),
      asker((name) => name === 'count')
    ),
    'unknown'
  )
})

test('a reference parses; anything with structure does not', () => {
  assert.deepEqual(parseReference('b1.cur_id'), {
    alias: 'b1',
    column: 'cur_id',
    coerced: false
  })
  assert.deepEqual(parseReference('"odd name"."odd column"'), {
    alias: 'odd name',
    column: 'odd column',
    coerced: false
  })
  assert.deepEqual(parseReference('(b1.amount)::text'), {
    alias: 'b1',
    column: 'amount',
    coerced: true
  })
  // One range table entry, so the planner drops the prefix and this is still a column.
  assert.deepEqual(parseReference('cur_id'), { alias: null, column: 'cur_id', coerced: false })
  for (const entry of [
    '7',
    "'example.event'::text",
    '(b1.cur_id + 0)',
    'COALESCE(b1.cur_id, 0)',
    'count(*)',
    'row_number() OVER w1',
    '(SubPlan 1)',
    '(InitPlan 1).col1',
    // A second cast is a second question, and this reader answers only the first.
    '((b1.cur_id)::character varying(4))::text',
    'b1.*'
  ]) {
    assert.equal(parseReference(entry), null, entry)
  }
})

test('an unqualified name is a column only where the plan reads exactly one relation', () => {
  const twoSources: ExplainPlanNode = {
    'Node Type': 'Nested Loop',
    'Join Type': 'Inner',
    Output: ['id', 'code'],
    Plans: [
      {
        'Node Type': 'Seq Scan',
        Schema: 'lab',
        'Relation Name': 'tx',
        Alias: 'tx',
        Output: ['id']
      },
      {
        'Node Type': 'Seq Scan',
        Schema: 'lab',
        'Relation Name': 'currency',
        Alias: 'currency',
        Output: ['code']
      }
    ]
  }
  assert.deepEqual(read(twoSources, 2).columns, [null, null])
  assert.deepEqual(read(twoSources, 2).refusals, [
    'unqualified-name-without-a-sole-relation',
    'unqualified-name-without-a-sole-relation'
  ])
})

test('a condition equates a column to a column or a literal, conjunct by conjunct', () => {
  const context = { reference: parseReference, soleAlias: null }
  const COLUMN = (alias: string, column: string): string => `${alias}\u0001${column}`
  assert.deepEqual(
    conditionEqualities("((s.store_id = st.id) AND (st.code = 'a = b AND c'::text))", context),
    [
      [COLUMN('s', 'store_id'), COLUMN('st', 'id')],
      [COLUMN('st', 'code'), '\u0002constant']
    ]
  )
  // Anything but a bare column or a literal is kept as an expression operand, by its
  // text, which pins nothing but a de-duplicated input's own column of that text.
  const EXPRESSION = (text: string): string => `\u0003${text}`
  assert.deepEqual(conditionEqualities('((st.id)::text = s.region_code)', context), [
    [EXPRESSION('(st.id)::text'), COLUMN('s', 'region_code')]
  ])
  assert.deepEqual(conditionEqualities('(st.id = (s.store_id + 1))', context), [
    [COLUMN('st', 'id'), EXPRESSION('s.store_id + 1')]
  ])
  for (const condition of ['((st.id = s.store_id) OR (st.id = 0))', '(st.id > s.store_id)']) {
    assert.deepEqual(conditionEqualities(condition, context), [], condition)
  }
})

test('below a Gather, a de-duplication is unique only among one worker\u2019s rows', () => {
  // A worker sees a share of the input, so a `Unique` it runs de-duplicates that
  // share. Only the `Unique` above the `Gather` makes the whole unique; the keys of
  // the scan under it are keys of the whole, because each row reaches one worker.
  const scan: ExplainPlanNode = {
    'Node Type': 'Seq Scan',
    Schema: 'lab',
    'Relation Name': 'tx',
    Alias: 'tx',
    Output: ['tx.cur_code']
  }
  const perWorker: ExplainPlanNode = {
    'Node Type': 'Gather Merge',
    Output: ['tx.cur_code'],
    Plans: [{ 'Node Type': 'Unique', Output: ['tx.cur_code'], Plans: [scan] }]
  }
  assert.deepEqual(read(perWorker, 1).rowIdentities, [])
  const whole: ExplainPlanNode = {
    'Node Type': 'Unique',
    Output: ['tx.cur_code'],
    Plans: [perWorker]
  }
  assert.deepEqual(
    read(whole, 1).rowIdentities.map((key) => key.columns),
    [[0]]
  )
})

test('a right semi or anti join emits its inner side, which it neither nulls nor repeats', () => {
  // The planner states `WHERE x IN (…)` as a `Right Semi` join whenever it hashes the
  // outer side instead; the side it emits is then the inner one, and reading it as
  // nulled would make the answer move with that choice.
  for (const joinType of ['Right Semi', 'Right Anti']) {
    const plan: ExplainPlanNode = {
      'Node Type': 'Hash Join',
      'Join Type': joinType,
      'Hash Cond': '(wallet.cur_code = tx.cur_code)',
      Output: ['tx.id'],
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Parent Relationship': 'Outer',
          Schema: 'lab',
          'Relation Name': 'wallet',
          Alias: 'wallet',
          Output: ['wallet.cur_code']
        },
        {
          'Node Type': 'Hash',
          'Parent Relationship': 'Inner',
          Output: ['tx.id', 'tx.cur_code'],
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Parent Relationship': 'Outer',
              Schema: 'lab',
              'Relation Name': 'tx',
              Alias: 'tx',
              Output: ['tx.id', 'tx.cur_code']
            }
          ]
        }
      ]
    }
    const origins = read(plan, 1)
    assert.deepEqual(origins.nullIntroduced, [false], joinType)
    assert.deepEqual(
      origins.rowIdentities.map((key) => key.columns),
      [[0]],
      joinType
    )
  }
})

test('a binary-coercible cast keeps the value; a function cast and a modifier do not', () => {
  const text = { typeId: 25, typeMod: -1, notNull: true }
  const varchar8 = { typeId: 1043, typeMod: 12, notNull: true }
  const asText: ViewColumn = { name: 'c', typeId: 25, typeMod: -1 }
  const asVarchar4: ViewColumn = { name: 'c', typeId: 1043, typeMod: 8 }
  const asNumeric: ViewColumn = { name: 'c', typeId: 1700, typeMod: -1 }
  assert.equal(valuePreservingCast(varchar8, asText, coercions), true)
  assert.equal(valuePreservingCast(text, asVarchar4, coercions), false)
  assert.equal(valuePreservingCast(text, asNumeric, coercions), false)
})

test('a truncating cast kills the value but not the non-nullness; a null-answering one kills both', () => {
  // Whether a cast may answer NULL is weaker than whether it hands the datum on: a
  // binary coercion under a type modifier truncates and never NULLs, and the
  // widening integer casts `pg_cast` runs through a function never NULL either.
  // Everything else may — `jsonb` to `integer` for the `jsonb` null, a user cast for
  // whatever its function likes — and there the non-nullness is not preserved.
  const text = { typeId: 25, typeMod: -1, notNull: true }
  const bigint = { typeId: 20, typeMod: -1, notNull: true }
  const jsonb = { typeId: 3802, typeMod: -1, notNull: true }
  const asVarchar4: ViewColumn = { name: 'c', typeId: 1043, typeMod: 8 }
  const asNumeric: ViewColumn = { name: 'c', typeId: 1700, typeMod: -1 }
  const asInteger: ViewColumn = { name: 'c', typeId: 23, typeMod: -1 }
  // Binary-coercible, modifier ignored.
  assert.equal(castPreservesNonNull(text, asVarchar4, coercions), true)
  // Through a function, but a widening that answers a value for every input.
  assert.equal(castPreservesNonNull(bigint, asNumeric, coercions), true)
  // `jsonb` to `integer` answers NULL for the `jsonb` null, and `text` to `numeric`
  // is a function cast none of the families authorises.
  assert.equal(castPreservesNonNull(jsonb, asInteger, coercions), false)
  assert.equal(castPreservesNonNull(text, asNumeric, coercions), false)
})

test('a cast to a shadowed type name answers NULL whatever the operand proves', () => {
  // The cast rule reads the target type by the name the plan prints it under, and a
  // user-defined type may take a built-in type's name and be printed with it. Then
  // the name is no promise the cast keeps, and the column stays nullable.
  const asker = (shadowed: (name: string) => boolean) => ({
    column: () => 'never-null' as const,
    hasGroupKey: true,
    shadowed
  })
  const cast = parseExpression('(CASE WHEN (x) THEN 1 ELSE 2 END)::integer')
  assert.equal(
    evaluateExpression(
      cast,
      asker(() => false)
    ),
    'never-null'
  )
  assert.equal(
    evaluateExpression(
      cast,
      asker((name) => name === 'integer')
    ),
    'nullable'
  )
})

test('a join type this reader does not know nulls both of its sides', () => {
  // Every join type PostgreSQL prints today is in the map; one it does not print
  // today would otherwise be read as nulling neither side, which is the reading that
  // claims NOT NULL over emptiness.
  const exotic: ExplainPlanNode = {
    'Node Type': 'Hash Sideways Join',
    'Join Type': 'Sideways',
    Output: ['tx.id', 'currency.code'],
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Outer',
        Schema: 'lab',
        'Relation Name': 'tx',
        Alias: 'tx',
        Output: ['tx.id']
      },
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Inner',
        Schema: 'lab',
        'Relation Name': 'currency',
        Alias: 'currency',
        Output: ['currency.code']
      }
    ]
  }
  assert.deepEqual(read(exotic, 2).nullIntroduced, [true, true])
})

test('an InitPlan beside a join is not an input of it, so no outer join nulls it', () => {
  // A subplan hangs off whichever node owns it, and that node can be a join. It is
  // computed beside the join, not joined by it, so the outer join over it nulls the
  // join's own inner input and nothing else.
  const beside: ExplainPlanNode = {
    'Node Type': 'Nested Loop',
    'Join Type': 'Left',
    Output: ['tx.id', 'bank.title', 'currency.code'],
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'InitPlan',
        Schema: 'lab',
        'Relation Name': 'currency',
        Alias: 'currency',
        Output: ['currency.code']
      },
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Outer',
        Schema: 'lab',
        'Relation Name': 'tx',
        Alias: 'tx',
        Output: ['tx.id']
      },
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Inner',
        Schema: 'lab',
        'Relation Name': 'bank',
        Alias: 'bank',
        Output: ['bank.title']
      }
    ]
  }
  assert.deepEqual(read(beside, 3).nullIntroduced, [false, true, false])
})

// Which connection each `EXPLAIN` is issued on. The two are not interchangeable: a
// materialized view's defining query names relations the surface's role is precisely
// the one not to be able to read, while a plain view needs nothing beyond the
// surface's own rights, and handing it the privileged connection would widen this
// reader's reach over the sources for no question it has.
function runnerRecording(
  issued: string[],
  label: string,
  answers: Record<string, unknown[]>
): RunQuery {
  return async <Row>(text: string) => {
    issued.push(`${label}: ${text.split('\n')[0]?.trim()}`)
    for (const [needle, rows] of Object.entries(answers)) {
      if (text.includes(needle)) return rows as Row[]
    }
    return [] as Row[]
  }
}

const ONE_COLUMN_PLAN = [
  {
    'QUERY PLAN': [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          Schema: 'lab',
          'Relation Name': 'currency',
          Alias: 'currency',
          Output: ['currency.code']
        }
      }
    ]
  }
]

const TWO_VIEWS = [
  {
    schema: 'lab',
    view: 'plain',
    relkind: 'v',
    definition: null,
    columns: [{ name: 'code', type_id: 25, type_mod: -1 }]
  },
  {
    schema: 'lab',
    view: 'stored',
    relkind: 'm',
    definition: 'SELECT code FROM lab.currency;',
    columns: [{ name: 'code', type_id: 25, type_mod: -1 }]
  }
]

test('a materialized view is planned on the privileged connection, a plain view is not', async () => {
  const issued: string[] = []
  const surface = runnerRecording(issued, 'surface', {
    'FROM pg_class class': TWO_VIEWS,
    EXPLAIN: ONE_COLUMN_PLAN
  })
  const privileged = runnerRecording(issued, 'privileged', {
    EXPLAIN: ONE_COLUMN_PLAN
  })
  const collected = await collectViewConstraints(surface, ['lab'], privileged)
  assert.deepEqual(
    issued.filter((entry) => entry.includes('EXPLAIN')),
    [
      'surface: EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) SELECT code FROM lab.plain',
      'privileged: EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) SELECT code FROM lab.currency'
    ]
  )
  assert.deepEqual(
    collected.derivations.map((derived) => `${derived.view}/${derived.relkind}`),
    ['plain/v', 'stored/m']
  )
  assert.deepEqual(collected.skipped, [])
})

test('with no privileged connection the materialized view is named, not passed over', async () => {
  const issued: string[] = []
  const surface = runnerRecording(issued, 'surface', {
    'FROM pg_class class': TWO_VIEWS,
    EXPLAIN: ONE_COLUMN_PLAN
  })
  const collected = await collectViewConstraints(surface, ['lab'], null)
  assert.deepEqual(
    issued.filter((entry) => entry.includes('EXPLAIN')),
    ['surface: EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) SELECT code FROM lab.plain']
  )
  assert.deepEqual(
    collected.derivations.map((derived) => derived.view),
    ['plain']
  )
  assert.deepEqual(collected.skipped, [
    {
      schema: 'lab',
      view: 'stored',
      relkind: 'm',
      reason: NO_PRIVILEGED_CONNECTION_REASON
    }
  ])
})

test('the report names the built-in spellings a user object has taken over', async () => {
  // The rules a shadowed spelling carries stand down for every view, so the set is
  // carried on the result: a surface that derives less than expected is read against it
  // rather than taken for one with nothing to derive.
  const issued: string[] = []
  const surface = runnerRecording(issued, 'surface', {
    'FROM pg_class class': TWO_VIEWS,
    EXPLAIN: ONE_COLUMN_PLAN,
    'FROM pg_proc': [{ name: 'count' }, { name: 'integer' }]
  })
  const collected = await collectViewConstraints(surface, ['lab'], null)
  assert.deepEqual(collected.shadowedNames, ['count', 'integer'])
  // The fake connection answers no version, so the stored tree is left unread and the
  // view says so rather than looking like one with no `WITH` query at all.
  assert.deepEqual(
    collected.derivations[0]?.notes.filter((note) => note.includes('stored rewrite tree')),
    [TREE_FORMAT_UNCHECKED_REASON]
  )
})

test('the stored rewrite tree is read only on a major the format is checked against', async () => {
  const asked = (version: number) => {
    const issued: string[] = []
    const query: RunQuery = async <Row>(text: string) => {
      issued.push(text)
      if (text.includes('server_version_num')) return [{ version }] as Row[]
      return [{ schema: 'lab', view: 'v', action: '({QUERY :targetList <> :cteList <>})' }] as Row[]
    }
    return { issued, read: readViewTrees(query, ['lab']) }
  }
  const checked = asked(180000)
  assert.equal((await checked.read).supported, true)
  assert.ok(checked.issued.some((text) => text.includes('ev_action')))
  // A major outside the range is not read at all: the stored action is never queried,
  // so the plan's own refusals stand where the tree's facts would have and the format is
  // a missed derivation rather than a guessed one.
  const unchecked = asked(190000)
  assert.equal((await unchecked.read).supported, false)
  assert.deepEqual((await unchecked.read).trees.size, 0)
  assert.ok(!unchecked.issued.some((text) => text.includes('ev_action')))
})

// ── The refusals are a closed list, and every one of them has a case ─────────────
//
// A view that derives nothing has to say which refusal it is, or "nothing derived"
// and "nothing looked at" become the same answer and the diff against the hand-written
// tags stops meaning anything. So the list is closed, and nothing may be added to it
// without a case that produces it.
//
// Two of them answer a plan shape no lab view produces: PostgreSQL prints an
// unqualified name only where the flattened range table has one entry, and prints an
// `Output` for every node that carries a select list. They are kept because a reader
// that had no answer for those would have to invent one, and their cases are plans
// built by hand here — the same way the join type this reader does not know is held.
const REFUSAL_CASES: Record<PlanRefusal | ColumnRefusal, string> = {
  'unreadable-set-operation': 'v_recursive',
  'set-operation-not-a-select-list': 'v_union_nested',
  'output-not-positional': 'a plan built by hand, below',
  'not-a-column-reference': 'v_coalesce',
  'unqualified-name-without-a-sole-relation': 'a plan built by hand, above',
  'no-value-from-any-branch': 'v_null_column',
  'through-a-materialized-with': 'a plan built by hand, below',
  'through-an-unpinned-subquery': 'v_sale_store_totals',
  'through-a-row-source-the-catalog-does-not-name': 'v_function_scan',
  'cast-not-value-preserving': 'v_over_barrier_narrowing',
  'plan-and-tree-disagree': 'a plan and a tree built by hand, below'
}

test('the closed list of refusals is exactly the list with cases', () => {
  assert.deepEqual(
    Object.keys(REFUSAL_CASES).sort(),
    [...Object.keys(PLAN_REFUSALS), ...Object.keys(COLUMN_REFUSALS)].sort()
  )
})

test('every refusal a lab view stands for is the refusal that view gives', () => {
  const labViews = new Set(CASES.map((testCase) => testCase.view))
  for (const [refusal, view] of Object.entries(REFUSAL_CASES)) {
    if (!labViews.has(view)) continue
    const derived = derive(view)
    const given = derived.planRefusal ?? derived.refusals.find((entry) => entry !== null)
    assert.equal(given, refusal, `lab.${view} was to stand for ${refusal}`)
  }
})

test('every refusal of a lab view is one of the closed list', () => {
  const named = new Set([...Object.keys(PLAN_REFUSALS), ...Object.keys(COLUMN_REFUSALS)])
  for (const testCase of CASES) {
    const derived = derive(testCase.view)
    if (derived.planRefusal) assert.ok(named.has(derived.planRefusal), derived.planRefusal)
    for (const refusal of derived.refusals) {
      if (refusal) assert.ok(named.has(refusal), refusal)
    }
    // And a column with no sources always says why, rather than going quiet.
    for (const [index, sources] of (derived.origins ?? []).entries()) {
      const said = derived.refusals[index] !== null && derived.refusals[index] !== undefined
      assert.equal(
        sources.endsWith('=—'),
        said,
        `${testCase.view} column ${index}: a column with no sources must name its refusal`
      )
    }
  }
})

test('an Output that does not line up with the view’s columns is refused whole', () => {
  // No lab view produces this: every node that carries a select list prints an
  // `Output`, and a union's branches print the set operation's column count. A reader
  // without an answer for it would read two columns off three entries by position.
  const short: ExplainPlanNode = {
    'Node Type': 'Seq Scan',
    Schema: 'lab',
    'Relation Name': 'tx',
    Alias: 'tx',
    Output: ['tx.id']
  }
  assert.equal(readPlanOrigins(short, 2, new Map(), planCatalog), 'output-not-positional')
  assert.equal(
    readPlanOrigins({ 'Node Type': 'Hash Join', 'Join Type': 'Inner' }, 2, new Map(), planCatalog),
    'output-not-positional'
  )
})

test('a Subquery Scan is crossed only where the catalog pins it to one view', () => {
  // The plan offers the alias and nothing else. `v_barrier` is a view `v_over_barrier`
  // is built on; a node calling itself anything else is some other subquery, and a
  // node calling itself `v_barrier` while printing a name `v_barrier` does not have is
  // some other subquery too.
  const shape = (alias: string, column: string): ExplainPlanNode => ({
    'Node Type': 'Subquery Scan',
    Alias: alias,
    Output: [`${alias}.id`, `${alias}.${column}`],
    Plans: [
      {
        'Node Type': 'Seq Scan',
        'Parent Relationship': 'Subquery',
        Schema: 'lab',
        'Relation Name': 'tx',
        Alias: 'tx',
        Output: ['tx.id', 'tx.cur_code', 'NULL::bigint', 'NULL::numeric']
      }
    ]
  })
  const candidates = subqueryViewCandidates(fixture.viewSources, 'lab', 'v_over_barrier')
  assert.deepEqual(
    read(shape('v_barrier', 'cur_code'), 2, candidates).columns.map(
      (sources) => sources?.map((origin) => `${origin.relation}.${origin.column}`).join('|') ?? '—'
    ),
    ['tx.id', 'tx.cur_code']
  )
  // A name `v_barrier` does not carry: the node is not that view.
  assert.deepEqual(read(shape('v_barrier', 'nonesuch'), 2, candidates).refusals, [
    'through-an-unpinned-subquery',
    'through-an-unpinned-subquery'
  ])
  // A view this relation is not built on is not a candidate at all.
  assert.deepEqual(read(shape('v_bare', 'cur_code'), 2, candidates).refusals, [
    'through-an-unpinned-subquery',
    'through-an-unpinned-subquery'
  ])
})

test('a CTE Scan is read only where the stored tree names the query’s columns and its subplan is proved', () => {
  // The plan prints `live.<col>` and the subplan prints the query's select list in
  // order, but the map from the names to the positions is not in the plan — it comes
  // from the view's stored rewrite tree. Without it the scan is refused, as before, and
  // so is a subplan whose columns' origins do not line up with the query's own.
  const cte: ExplainPlanNode = {
    'Node Type': 'Seq Scan',
    'Subplan Name': 'CTE live',
    Alias: 't',
    Schema: 'lab',
    'Relation Name': 'tx',
    Output: ['t.id', 't.cur_code']
  }
  const scan: ExplainPlanNode = {
    'Node Type': 'CTE Scan',
    'CTE Name': 'live',
    Alias: 'live',
    Output: ['live.cur_code']
  }
  const plan: ExplainPlanNode = {
    'Node Type': 'Result',
    Output: ['live.cur_code'],
    Plans: [scan, cte]
  }
  const without = readPlanOrigins(plan, 1, new Map(), planCatalog)
  assert.ok(typeof without !== 'string')
  assert.deepEqual(without.refusals, ['through-a-materialized-with'])
  // The query's own columns are `lab.tx.id` and `lab.tx.cur_code`, it is materialized so
  // its own scan is expected, and the one subplan prints those origins position for
  // position: it is proved and read.
  const withMap = planCatalogFrom(
    catalog,
    fixture.strictEquality,
    new Set(),
    new Map([['live', ['id', 'cur_code']]]),
    new Map([
      [
        'live',
        [
          { schema: 'lab', relation: 'tx', column: 'id' },
          { schema: 'lab', relation: 'tx', column: 'cur_code' }
        ]
      ]
    ]),
    new Map([['live', true]]),
    new Map([['live', 1]])
  )
  const origins = readPlanOrigins(plan, 1, new Map(), withMap)
  assert.ok(typeof origins !== 'string')
  assert.deepEqual(
    origins.columns.map(
      (sources) => sources?.map((origin) => `${origin.relation}.${origin.column}`).join('|') ?? '—'
    ),
    ['tx.cur_code']
  )
  // A subplan whose columns' origins are not the query's own is not proved: refused.
  const mismatched = planCatalogFrom(
    catalog,
    fixture.strictEquality,
    new Set(),
    new Map([['live', ['id', 'cur_code']]]),
    // The query's second column is an expression where the subplan names a base column.
    new Map([['live', [{ schema: 'lab', relation: 'tx', column: 'id' }, null]]]),
    new Map([['live', true]]),
    new Map([['live', 1]])
  )
  const refused = readPlanOrigins(plan, 1, new Map(), mismatched)
  assert.ok(typeof refused !== 'string')
  assert.deepEqual(refused.refusals, ['through-a-materialized-with'])
  // And a `WITH` query this view inlines has no scan of its own, so a `CTE Scan` of the
  // name is another query's and is refused even where the map and the origins both fit.
  const inlined = planCatalogFrom(
    catalog,
    fixture.strictEquality,
    new Set(),
    new Map([['live', ['id', 'cur_code']]]),
    new Map([
      [
        'live',
        [
          { schema: 'lab', relation: 'tx', column: 'id' },
          { schema: 'lab', relation: 'tx', column: 'cur_code' }
        ]
      ]
    ]),
    new Map([['live', false]]),
    new Map([['live', 1]])
  )
  const inlinedRefused = readPlanOrigins(plan, 1, new Map(), inlined)
  assert.ok(typeof inlinedRefused !== 'string')
  assert.deepEqual(inlinedRefused.refusals, ['through-a-materialized-with'])
})

// ── A relation led to a projection ──────────────────────────────────────────────
//
// The pass that leads a relation to another view is an answer over a whole surface:
// which view is a row of a base key is not a question one view can be asked. So it
// runs over every derivation of the lab at once, and these cases read what it did to
// each of them — against the same fixture, regime by regime, because a pass over
// answers that do not move with the plan may not move with the plan either.

/** Every lab view derived under one regime, before any pass over the surface. */
function labDerivations(regime: string = DEFAULT_REGIME): ViewDerivation[] {
  return fixture.views
    .filter((view) => view.regime === regime)
    .map((view) =>
      deriveViewConstraints(
        view.schema,
        view.view,
        view.relkind,
        view.columns,
        readPlanOrigins(
          view.plan,
          view.columns.length,
          subqueryViewCandidates(fixture.viewSources, view.schema, view.view),
          planCatalog
        ),
        catalog,
        coercions
      )
    )
}

/** Every lab table, before any pass over the surface. */
function labTables(): TableDerivation[] {
  return fixture.tables.map((table) => ({
    schema: table.schema,
    table: table.table,
    foreignKeys: [],
    declinedViewTargets: [],
    notes: []
  }))
}

/**
 * Every lab view and table derived under one regime, with the projection pass
 * applied, by name: a table and a view share no name in one schema.
 */
function labSurface(
  regime: string = DEFAULT_REGIME,
  publishedAsEnumeration?: (schema: string, view: string) => boolean,
  declaredRowIdentity?: (schema: string, view: string) => string | null
): Map<string, ViewDerivation | TableDerivation> {
  const derivations = labDerivations(regime)
  const tables = labTables()
  deriveProjectionRelations(
    derivations,
    catalog,
    publishedAsEnumeration,
    declaredRowIdentity,
    tables
  )
  return new Map<string, ViewDerivation | TableDerivation>([
    ...derivations.map((derivation) => [derivation.view, derivation] as const),
    ...tables.map((table) => [table.table, table] as const)
  ])
}

function relationsOf(
  surface: Map<string, ViewDerivation | TableDerivation>,
  view: string
): string[] {
  const derivation = surface.get(view)
  assert.ok(derivation, `no derivation for lab.${view}`)
  return derivation.foreignKeys.map((foreignKey) => foreignKey.tag)
}

function declinedBy(
  surface: Map<string, ViewDerivation | TableDerivation>,
  view: string
): { key: string; refusal: string; candidates: string[] }[] {
  const derivation = surface.get(view)
  assert.ok(derivation, `no derivation for lab.${view}`)
  return derivation.declinedViewTargets.map((declined) => ({
    key: declined.key,
    refusal: declined.refusal,
    candidates: declined.candidates
  }))
}

test('a relation is led to the one projection that is a row of the key it points at', () => {
  const surface = labSurface()
  // The relation to the table is left exactly where it was; the one to the
  // projection stands beside it, because a table row and a projection row are
  // different objects and choosing between them is not a derivation's choice.
  assert.deepEqual(relationsOf(surface, 'v_invoice'), [
    '(id) references lab.invoice (id)',
    '(merchant_id) references lab.merchant (id)',
    '(merchant_id) references lab.v_merchant (id)'
  ])
  assert.deepEqual(declinedBy(surface, 'v_invoice'), [])
})

test('the key led to may be a unique index rather than a primary key', () => {
  const surface = labSurface()
  // `entry.ledger_code` references `ledger(code)`, so the projection keyed by `code`
  // is where it is led. `v_ledger_by_id` is a row of the same table by a key this
  // relation does not point at, and is no candidate for it.
  assert.deepEqual(relationsOf(surface, 'v_entry'), [
    '(id) references lab.entry (id)',
    '(ledger_code) references lab.ledger (code)',
    '(ledger_code) references lab.v_ledger_by_code (code)'
  ])
  assert.deepEqual(relationsOf(surface, 'v_ledger_by_id'), ['(id) references lab.ledger (id)'])
})

test('a view is not led to its own row', () => {
  const surface = labSurface()
  // `v_merchant` is the one row of `merchant(id)`, and it is also the view asking.
  // The relation would be the row's identity with its own row, which its own
  // `@primaryKey` already says — so it is dropped, and nothing is reported about it.
  assert.deepEqual(relationsOf(surface, 'v_merchant'), ['(id) references lab.merchant (id)'])
  assert.deepEqual(declinedBy(surface, 'v_merchant'), [])
})

test('a view is led to another of its own rows: the parent of a hierarchy', () => {
  const surface = labSurface()
  // Both relations of `v_node` point at `node(id)` and the only projection of that
  // key is `v_node` itself, but they are not the same statement. `(id) → (id)` is
  // the row's identity with its own row and is dropped; `(parent_id) → (id)` reaches
  // the parent row, which no `@primaryKey` says anything about, and is led.
  assert.deepEqual(relationsOf(surface, 'v_node'), [
    '(id) references lab.node (id)',
    '(parent_id) references lab.node (id)',
    '(parent_id) references lab.v_node (id)'
  ])
  assert.deepEqual(declinedBy(surface, 'v_node'), [])
})

test('a composite key is carried by column, not by order or by name', () => {
  const surface = labSurface()
  // `shift`'s constraint spells the key `(seat, ship_code)`, `crew`'s index spells it
  // `(ship_code, seat)`, and `v_crew` spells it `berth`/`vessel` in a third order
  // again. Each column is carried to the view column that proxies it, so the led
  // relation pairs `seat → berth` and `ship_code → vessel`.
  assert.deepEqual(relationsOf(surface, 'v_shift'), [
    '(id) references lab.shift (id)',
    '(seat,ship_code) references lab.crew (seat,ship_code)',
    '(seat,ship_code) references lab.v_crew (berth,vessel)'
  ])
  // And the composite identity of `v_crew` with its own row is dropped the way the
  // single-column one is: every column of the reference names the column it is led
  // from, whatever order the base key is spelled in.
  assert.deepEqual(relationsOf(surface, 'v_crew'), [
    '(vessel,berth) references lab.crew (ship_code,seat)'
  ])
})

test('a projection keyed by hand over other columns is no place to lead a relation', () => {
  // Both keys are right: `v_merchant` is a row of `merchant(id)` by derivation, and
  // an author who wrote `@primaryKey title` publishes it under `title` instead —
  // the plugin declares what it derives only where the view states nothing. A
  // relation to `v_merchant (id)` would then reference a key the view does not
  // publish, and `PgFakeConstraintsPlugin` fails the build over it.
  const byHand = labSurface(DEFAULT_REGIME, undefined, (schema, view) =>
    schema === 'lab' && view === 'v_merchant' ? 'title' : null
  )
  assert.deepEqual(relationsOf(byHand, 'v_invoice'), [
    '(id) references lab.invoice (id)',
    '(merchant_id) references lab.merchant (id)'
  ])
  assert.deepEqual(declinedBy(byHand, 'v_invoice'), [])
  // A hand tag naming the derived key is the same key, so it changes nothing. The
  // spelling is read the way `PgFakeConstraintsPlugin` reads it: an unquoted
  // identifier is lower-cased, and the `|@behavior …` tail is not part of the key.
  const sameKey = labSurface(DEFAULT_REGIME, undefined, (schema, view) =>
    schema === 'lab' && view === 'v_merchant' ? 'ID|@behavior -update' : null
  )
  assert.deepEqual(relationsOf(sameKey, 'v_invoice'), [
    '(id) references lab.invoice (id)',
    '(merchant_id) references lab.merchant (id)',
    '(merchant_id) references lab.v_merchant (id)'
  ])
  // A composite hand tag is compared as a set, because that is how the referenced
  // attributes are matched.
  const composite = labSurface(DEFAULT_REGIME, undefined, (schema, view) =>
    schema === 'lab' && view === 'v_crew' ? 'berth,vessel' : null
  )
  assert.deepEqual(relationsOf(composite, 'v_shift'), [
    '(id) references lab.shift (id)',
    '(seat,ship_code) references lab.crew (seat,ship_code)',
    '(seat,ship_code) references lab.v_crew (berth,vessel)'
  ])
})

test('the pass answers the same however often it is run, and in whatever order', () => {
  const rendering = (surface: Map<string, ViewDerivation | TableDerivation>): string[] =>
    [...surface.keys()]
      .sort()
      .flatMap((view) => [
        `${view} fk ${relationsOf(surface, view).join(' ')}`,
        `${view} declined ${JSON.stringify(declinedBy(surface, view))}`,
        `${view} notes ${JSON.stringify(surface.get(view)?.notes)}`
      ])
  const byName = (
    views: ViewDerivation[],
    tables: TableDerivation[]
  ): Map<string, ViewDerivation | TableDerivation> =>
    new Map<string, ViewDerivation | TableDerivation>([
      ...views.map((d) => [d.view, d] as const),
      ...tables.map((t) => [t.table, t] as const)
    ])
  const once = labDerivations()
  const onceTables = labTables()
  deriveProjectionRelations(once, catalog, undefined, undefined, onceTables)
  const expected = rendering(byName(once, onceTables))

  // Run twice over the same derivations: a relation already led is one of the tags
  // the pass reads back, and a target already declined is not declined twice, so
  // neither the relations, nor the declined targets, nor the notes double.
  const twice = labDerivations()
  const twiceTables = labTables()
  deriveProjectionRelations(twice, catalog, undefined, undefined, twiceTables)
  deriveProjectionRelations(twice, catalog, undefined, undefined, twiceTables)
  assert.deepEqual(rendering(byName(twice, twiceTables)), expected)

  // And the order the derivations arrive in is not part of the answer: which view is
  // a row of a base key is read off the whole surface before any view is led.
  const reversed = labDerivations().reverse()
  const reversedTables = labTables().reverse()
  deriveProjectionRelations(reversed, catalog, undefined, undefined, reversedTables)
  assert.deepEqual(rendering(byName(reversed, reversedTables)), expected)
})

test('more than one projection of a key is declined by name, not guessed between', () => {
  const surface = labSurface()
  assert.deepEqual(relationsOf(surface, 'v_parcel'), [
    '(carrier_id) references lab.carrier (id)',
    '(id) references lab.parcel (id)'
  ])
  assert.deepEqual(declinedBy(surface, 'v_parcel'), [
    {
      key: 'lab.carrier(id)',
      refusal: 'more-than-one-projection-carries-the-key',
      candidates: ['lab.v_carrier_bare', 'lab.v_carrier_titled']
    }
  ])
})

test('a view that carries a key without being keyed by it is no candidate', () => {
  const surface = labSurface()
  // `v_depot_joined` proxies `depot.id` and repeats it once per crate, so `depot`'s
  // key is not a key of the view. Nothing is led to it by `depot(id)`, and `v_crate`
  // says nothing about that key either: no projection of `depot(id)` is not a
  // refusal, it is the ordinary state of a surface that publishes none.
  const joined = surface.get('v_depot_joined')
  assert.ok(joined && 'primaryKey' in joined)
  assert.equal(joined.primaryKey?.tag, 'crate_id')
  assert.deepEqual(relationsOf(surface, 'v_crate'), [
    '(depot_id) references lab.depot (id)',
    '(id) references lab.crate (id)'
  ])
  // The key it is keyed by is `crate`'s: every crate meets one depot, so every crate
  // row appears once. That makes it a second projection of `crate(id)` beside
  // `v_crate`, and a relation to that key is declined between the two.
  assert.deepEqual(declinedBy(surface, 'v_crate'), [
    {
      key: 'lab.crate(id)',
      refusal: 'more-than-one-projection-carries-the-key',
      candidates: ['lab.v_crate', 'lab.v_depot_joined']
    }
  ])
})

test('leading a relation to a projection does not move with the plan', () => {
  const rendering = (regime: string): string[] => {
    const surface = labSurface(regime)
    return [...surface.keys()]
      .sort()
      .flatMap((view) => [
        `${view} fk ${relationsOf(surface, view).join(' ')}`,
        `${view} declined ${JSON.stringify(declinedBy(surface, view))}`
      ])
  }
  const expected = rendering(DEFAULT_REGIME)
  for (const regime of REGIMES) {
    assert.deepEqual(rendering(regime), expected, regime)
  }
})

// The third closed list, held exactly as the other two are. A relation the catalog
// authorises and this reader did not lead has to say so, or "no projection is a row
// of this key" and "several are" become one silence.
const TARGET_REFUSAL_CASES: Record<TargetRefusal, string> = {
  'more-than-one-projection-carries-the-key': 'v_parcel'
}

test('the closed list of target refusals is exactly the list with cases', () => {
  assert.deepEqual(Object.keys(TARGET_REFUSAL_CASES).sort(), Object.keys(TARGET_REFUSALS).sort())
})

test('every target refusal a lab view stands for is the one that view gives', () => {
  const surface = labSurface()
  for (const [refusal, view] of Object.entries(TARGET_REFUSAL_CASES)) {
    const declined = declinedBy(surface, view)
    assert.ok(declined.length > 0, `lab.${view} declined nothing`)
    assert.equal(declined[0]?.refusal, refusal, `lab.${view} was to stand for ${refusal}`)
  }
})

test('every target refusal of a lab view is one of the closed list', () => {
  const surface = labSurface()
  const named = new Set(Object.keys(TARGET_REFUSALS))
  for (const view of surface.keys()) {
    for (const declined of declinedBy(surface, view)) {
      assert.ok(named.has(declined.refusal), declined.refusal)
      assert.ok(declined.candidates.length > 1, `${view}: ${declined.key}`)
    }
  }
})

test('a view published as an enumeration is no place to lead a relation to', () => {
  // `PgEnumTablesPlugin` "converts columns that reference `@enum` tables into enums":
  // the relation would not lead anywhere, it would retype `v_invoice.merchant_id` in
  // the published schema. So such a view is not a candidate, and the relation to the
  // table stands alone.
  const surface = labSurface(
    DEFAULT_REGIME,
    (schema, view) => schema === 'lab' && view === 'v_merchant'
  )
  assert.deepEqual(relationsOf(surface, 'v_invoice'), [
    '(id) references lab.invoice (id)',
    '(merchant_id) references lab.merchant (id)'
  ])
  assert.deepEqual(declinedBy(surface, 'v_invoice'), [])
  // And it is left out of the count, not declined: with one of the two projections of
  // `carrier` published as an enumeration, the other one is the sole candidate.
  const carriers = labSurface(
    DEFAULT_REGIME,
    (schema, view) => schema === 'lab' && view === 'v_carrier_bare'
  )
  assert.deepEqual(relationsOf(carriers, 'v_parcel'), [
    '(carrier_id) references lab.carrier (id)',
    '(carrier_id) references lab.v_carrier_titled (id)',
    '(id) references lab.parcel (id)'
  ])
  assert.deepEqual(declinedBy(carriers, 'v_parcel'), [])
})

// ── A table's own foreign key led to a projection ────────────────────────────────
//
// The referencing half need not be derived at all: a table's foreign key is the
// `pg_constraint` row a view's relation is derived down to. The pass leads it by the
// same count over the same projections, and only the relation to the projection is
// the pass's to declare — the foreign key reaches the schema as the constraint it is.

test('a table’s foreign key is led to the one projection that is a row of its key', () => {
  const surface = labSurface()
  assert.deepEqual(relationsOf(surface, 'invoice'), [
    '(merchant_id) references lab.v_merchant (id)'
  ])
  assert.deepEqual(declinedBy(surface, 'invoice'), [])
  // Through a unique index rather than a primary key, to the projection keyed by it.
  assert.deepEqual(relationsOf(surface, 'entry'), [
    '(ledger_code) references lab.v_ledger_by_code (code)'
  ])
  // A composite key, carried by column across three spellings.
  assert.deepEqual(relationsOf(surface, 'shift'), [
    '(seat,ship_code) references lab.v_crew (berth,vessel)'
  ])
  // A self-referencing table reaches the parent's projection; the table is not the
  // projection, so nothing of it is its own row.
  assert.deepEqual(relationsOf(surface, 'node'), ['(parent_id) references lab.v_node (id)'])
  // Every relation led names both halves: the table's constraint and the key the
  // projection is a row of.
  const invoice = surface.get('invoice')
  assert.deepEqual(invoice?.foreignKeys[0]?.via, [
    { schema: 'lab', relation: 'invoice', constraintName: 'invoice_merchant_id_fkey' },
    { schema: 'lab', relation: 'merchant', constraintName: 'merchant_pkey' }
  ])
})

test('a table’s foreign key to a key a projection repeats is led nowhere', () => {
  const surface = labSurface()
  // `v_depot_joined` proxies `depot.id` once per crate and is keyed by the crate.
  assert.deepEqual(relationsOf(surface, 'crate'), [])
  assert.deepEqual(declinedBy(surface, 'crate'), [])
})

test('a table’s foreign key between two projections of its key is declined by name', () => {
  const surface = labSurface()
  assert.deepEqual(relationsOf(surface, 'parcel'), [])
  assert.deepEqual(declinedBy(surface, 'parcel'), [
    {
      key: 'lab.carrier(id)',
      refusal: 'more-than-one-projection-carries-the-key',
      candidates: ['lab.v_carrier_bare', 'lab.v_carrier_titled']
    }
  ])
})

test('a foreign key added NOT VALID is no referencing half', () => {
  // The catalog reads only `convalidated` foreign keys, so `consignment` has none to
  // lead, though `v_merchant` is the one projection of the key it names.
  assert.deepEqual(catalog.get('lab.consignment')?.foreignKeys, [])
  const surface = labSurface()
  assert.deepEqual(relationsOf(surface, 'consignment'), [])
  assert.deepEqual(declinedBy(surface, 'consignment'), [])
})

test('a table’s foreign key is not led to a projection published as an enumeration', () => {
  const surface = labSurface(
    DEFAULT_REGIME,
    (schema, view) => schema === 'lab' && view === 'v_merchant'
  )
  assert.deepEqual(relationsOf(surface, 'invoice'), [])
  assert.deepEqual(declinedBy(surface, 'invoice'), [])
})
