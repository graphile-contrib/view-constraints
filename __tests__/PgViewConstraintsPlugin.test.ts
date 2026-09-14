// What the planner says about a view column, case by case.
//
// `view-constraints.fixture.json` is PostgreSQL 18's own answer — the plans, the
// constraints, the unique indexes, the column types and the binary-coercible casts —
// for the schema in `view-constraints.lab.sql`, read through the plugin's own catalog
// queries. Nothing here is written by hand except the expectations. To rebuild it,
// create a database, apply that file, and run the collector's `readCatalogRelations`,
// `readTypeCoercions` and `explainStatement` against it (see the file's header).
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
  deriveProjectionRelations,
  deriveViewConstraints,
  TARGET_REFUSALS,
  valuePreservingCast
} from '../src/PgViewConstraintsPlugin/derive.ts'
import type {
  CatalogRelation,
  TargetRefusal,
  TypeCoercions,
  ViewColumn,
  ViewDerivation
} from '../src/PgViewConstraintsPlugin/derive.ts'
import {
  collectViewConstraints,
  NO_PRIVILEGED_CONNECTION_REASON,
  subqueryViewCandidates
} from '../src/PgViewConstraintsPlugin/collect.ts'
import type { ViewSourceRow } from '../src/PgViewConstraintsPlugin/collect.ts'
import type { RunQuery } from '../src/PgViewConstraintsPlugin/collect.ts'
import {
  COLUMN_REFUSALS,
  PLAN_REFUSALS,
  parseReference,
  readPlanOrigins
} from '../src/PgViewConstraintsPlugin/plan-origins.ts'
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
  /** Every lab view's select-list order and the views it is built on. */
  viewSources: ViewSourceRow[]
  views: {
    schema: string
    view: string
    relkind: 'v' | 'm'
    /** The planner regime the plan was taken under; see scripts/view-constraints-fixture.ts. */
    regime: string
    columns: ViewColumn[]
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
  const origins = readPlanOrigins(plan, columnCount, candidates)
  assert.ok(typeof origins !== 'string', `plan refused: ${String(origins)}`)
  return origins
}

/** The regime the cases below are written against. */
const DEFAULT_REGIME = 'default'

const REGIMES = [...new Set(fixture.views.map((view) => view.regime))]

/** What one lab view's derivation reduces to, in the shape the cases are written in. */
function derive(
  name: string,
  regime: string = DEFAULT_REGIME
): {
  origins: string[] | null
  notNull: string[]
  foreignKeys: string[]
  primaryKey: string | null
  planRefusal: PlanRefusal | null
  refusals: (ColumnRefusal | null)[]
  notes: string[]
} {
  const view = fixture.views.find(
    (candidate) => candidate.view === name && candidate.regime === regime
  )
  assert.ok(view, `no fixture for lab.${name} under ${regime}`)
  const derivation = deriveViewConstraints(
    view.schema,
    view.view,
    view.relkind,
    view.columns,
    readPlanOrigins(
      view.plan,
      view.columns.length,
      subqueryViewCandidates(fixture.viewSources, view.schema, view.view)
    ),
    catalog,
    coercions
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
    // Two relations, so no row identity.
    primaryKey: null
  },
  {
    view: 'v_group',
    about: 'a grouping key proxies; the aggregate beside it does not',
    origins: ['cur_code=tx.cur_code', 'n=—'],
    notNull: ['cur_code'],
    foreignKeys: ['(cur_code) references lab.currency (code)'],
    primaryKey: null
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
      'a WITH query referenced twice is materialized, and the wall it puts up is not ' +
      'crossed: the plan holds no map from its column names to its select list',
    origins: ['id=—', 'cur_code=—', 'top_amount=—'],
    notNull: [],
    foreignKeys: [],
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
      'table entry EXPLAIN prints unqualified',
    origins: ['id=tx.id', 'cur_code=tx.cur_code', 'amount=tx.amount'],
    notNull: [],
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
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_constant',
    about: 'a literal is nobody’s column',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cast_truncating',
    about: 'text to varchar(4) is binary-coercible and still truncates',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id'],
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
      'the trap: DISTINCT over a UNION prints a Unique whose Output names one branch ' +
      'of two, so the plan is refused whole rather than read as a single scan',
    origins: null,
    notNull: [],
    foreignKeys: [],
    primaryKey: null
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
    about: 'a unique index over a nullable column identifies no row and is no key',
    origins: ['tag=slot.tag'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
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
    primaryKey: null
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
    primaryKey: null
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
      'grouping column is NULL in it, and it is not a row of the table either',
    origins: ['id=tx.id', 'n=—'],
    notNull: [],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: null
  },
  {
    view: 'v_not_null_predicate',
    about:
      'WHERE bank_id IS NOT NULL leaves no NULL in the column and is not read: the ' +
      'rule is about the shape of the plan, never about an expression in it',
    origins: ['id=tx.id', 'bank_id=tx.bank_id'],
    notNull: ['id'],
    foreignKeys: ['(bank_id) references lab.bank (id)', '(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_cte_nulled_scan',
    about:
      'a column read through a materialized WITH query is unknown however plainly ' +
      'the query reads it; the columns beside it are read as usual',
    origins: ['id=refund.id', 'a_code=—', 'b_code=—'],
    notNull: ['id'],
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
      'de-duplication over a union is refused both ways the planner implements it: ' +
      'a hashed `Aggregate` computes, and a `Unique` is what the same query becomes ' +
      'when hashing is off, so accepting one would answer by cost',
    origins: null,
    notNull: [],
    foreignKeys: [],
    primaryKey: null
  },
  {
    view: 'v_cte_reordered_scans',
    about:
      'two scans of one WITH query print its columns in two different orders, and ' +
      'which of the two orders is the query’s own is the very thing the plan does ' +
      'not say — so neither is read',
    origins: ['id=refund.id', 'cur_code=—', 'b_cur_code=—'],
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
    notNull: ['id', 'cur_code'],
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
    notNull: ['id', 'cur_code'],
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
    about: 'the inner view truncates the value, so it is not the base column’s any more',
    origins: ['id=tx.id', 'cur_code=—', 'amount=tx.amount'],
    notNull: ['id', 'amount'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_over_barrier_narrowing',
    about:
      'and the outer view casting it back to the base type does not undo that: each ' +
      'step is binary-coercible on its own, and the chain of them is not',
    origins: ['id=tx.id', 'cur_code=—'],
    notNull: ['id'],
    foreignKeys: ['(id) references lab.tx (id)'],
    primaryKey: 'id'
  },
  {
    view: 'v_aliased_barrier',
    about:
      'the plan gives a Subquery Scan an alias and nothing else, so an aliased barrier ' +
      'view is a boundary with no name to pin it to a view by, and is not crossed',
    origins: ['id=—', 'cur_code=—'],
    notNull: [],
    foreignKeys: [],
    primaryKey: null
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
    about: 'EXCEPT reads its inputs as one tagged stream: there is no branch to read',
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
      'list still spells the relation that is not read',
    origins: ['id=—', 'cur_code=—'],
    notNull: [],
    foreignKeys: [],
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
      'every depot row once per crate, so the plan proves no row identity',
    origins: ['id=depot.id', 'crate_id=crate.id'],
    notNull: ['id', 'crate_id'],
    foreignKeys: ['(crate_id) references lab.crate (id)', '(id) references lab.depot (id)'],
    primaryKey: null
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
  }
]

for (const testCase of CASES) {
  test(`${testCase.view}: ${testCase.about}`, () => {
    const derived = derive(testCase.view)
    assert.deepEqual(derived.origins, testCase.origins)
    assert.deepEqual(derived.notNull, testCase.notNull)
    assert.deepEqual(derived.foreignKeys, testCase.foreignKeys)
    assert.equal(derived.primaryKey, testCase.primaryKey)
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
for (const regime of REGIMES.filter((name) => name !== DEFAULT_REGIME)) {
  test(`the derivation of every lab view is the same under ${regime}`, () => {
    for (const testCase of CASES) {
      assert.deepEqual(
        derive(testCase.view, regime),
        derive(testCase.view),
        `${testCase.view} derives differently under ${regime}`
      )
    }
  })
}

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
  'unreadable-set-operation': 'v_except',
  'set-operation-not-a-select-list': 'v_union_distinct',
  'output-not-positional': 'a plan built by hand, below',
  'not-a-column-reference': 'v_coalesce',
  'unqualified-name-without-a-sole-relation': 'a plan built by hand, above',
  'no-value-from-any-branch': 'v_null_column',
  'through-a-materialized-with': 'v_cte',
  'through-an-unpinned-subquery': 'v_aliased_barrier',
  'through-a-row-source-the-catalog-does-not-name': 'v_function_scan',
  'cast-not-value-preserving': 'v_over_barrier_narrowing'
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
  assert.equal(readPlanOrigins(short, 2), 'output-not-positional')
  assert.equal(
    readPlanOrigins({ 'Node Type': 'Hash Join', 'Join Type': 'Inner' }, 2),
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
          subqueryViewCandidates(fixture.viewSources, view.schema, view.view)
        ),
        catalog,
        coercions
      )
    )
}

/** Every lab view derived under one regime, with the projection pass applied. */
function labSurface(
  regime: string = DEFAULT_REGIME,
  publishedAsEnumeration?: (schema: string, view: string) => boolean,
  declaredRowIdentity?: (schema: string, view: string) => string | null
): Map<string, ViewDerivation> {
  const derivations = labDerivations(regime)
  deriveProjectionRelations(derivations, catalog, publishedAsEnumeration, declaredRowIdentity)
  return new Map(derivations.map((derivation) => [derivation.view, derivation]))
}

function relationsOf(surface: Map<string, ViewDerivation>, view: string): string[] {
  const derivation = surface.get(view)
  assert.ok(derivation, `no derivation for lab.${view}`)
  return derivation.foreignKeys.map((foreignKey) => foreignKey.tag)
}

function declinedBy(
  surface: Map<string, ViewDerivation>,
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
  const rendering = (surface: Map<string, ViewDerivation>): string[] =>
    [...surface.keys()]
      .sort()
      .flatMap((view) => [
        `${view} fk ${relationsOf(surface, view).join(' ')}`,
        `${view} declined ${JSON.stringify(declinedBy(surface, view))}`,
        `${view} notes ${JSON.stringify(surface.get(view)?.notes)}`
      ])
  const once = labDerivations()
  deriveProjectionRelations(once, catalog)
  const expected = rendering(new Map(once.map((d) => [d.view, d])))

  // Run twice over the same derivations: a relation already led is one of the tags
  // the pass reads back, and a target already declined is not declined twice, so
  // neither the relations, nor the declined targets, nor the notes double.
  const twice = labDerivations()
  deriveProjectionRelations(twice, catalog)
  deriveProjectionRelations(twice, catalog)
  assert.deepEqual(rendering(new Map(twice.map((d) => [d.view, d]))), expected)

  // And the order the derivations arrive in is not part of the answer: which view is
  // a row of a base key is read off the whole surface before any view is led.
  const reversed = labDerivations().reverse()
  deriveProjectionRelations(reversed, catalog)
  assert.deepEqual(rendering(new Map(reversed.map((d) => [d.view, d]))), expected)
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
  // `v_depot_joined` proxies `depot.id` and repeats it once per crate, so the plan
  // proves no row identity and the key is not a key of the view. Nothing is led to
  // it, and `v_crate` says nothing either: no projection of `depot(id)` is not a
  // refusal, it is the ordinary state of a surface that publishes none.
  assert.equal(surface.get('v_depot_joined')?.primaryKey, null)
  assert.deepEqual(relationsOf(surface, 'v_crate'), [
    '(depot_id) references lab.depot (id)',
    '(id) references lab.crate (id)'
  ])
  assert.deepEqual(declinedBy(surface, 'v_crate'), [])
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
