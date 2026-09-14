// Turns "this view column proxies that base column" into "this view has that
// relation", but only where the catalog already says the base columns carry the key.
//
// The origin side comes from the planner (see `plan-origins.ts`); the key side comes
// from the catalog. Neither is taken on trust from the other: a column that proxies
// `asset.currency_id` yields a relation only because a real foreign key on
// `<base>.currency_id` says where it points, and the relation is declared to point
// exactly there.
//
// Two more things the catalog authorises, beyond an outgoing foreign key:
//
//   * A column that proxies a table's own primary key is a key of that table by
//     identity — every value it can hold is a row of it — so the view relates to it
//     exactly as a foreign key would.
//   * A unique index is as good a key of the base table as the primary key, so a
//     view that carries one carries a row identity. It is only a row identity when
//     the base columns are NOT NULL: a unique index admits nulls, and a null key
//     identifies nothing.
//
// And one thing the plan alone cannot settle: a cast. `(route.currency_id)::text`
// proxies the value only if the cast leaves it alone, which is a question about the
// two types, answered here from `pg_cast` and the domain chain.
//
// Non-nullness is the two sides meeting over one column rather than over a key. A
// view column is NOT NULL when it proxies a base column `pg_attribute.attnotnull`
// calls NOT NULL and the plan puts no NULL of its own into it. Both halves are
// structural: no expression is examined, so `COALESCE(a, b)`, `count(*)`, a constant,
// a strict function of non-null arguments and a `col IS NOT NULL` qualifier are all
// nullable here, each of them derivable in principle and none of them derived. The
// asymmetry is deliberate. A relation claimed wrongly costs an empty related object;
// a `notNull` claimed wrongly puts a NULL in a non-null GraphQL field, and the rules
// of GraphQL then null the whole parent object — so the answer is destroyed rather
// than thinned. Where there is a doubt, the column is nullable.

import { COLUMN_REFUSALS, PLAN_REFUSALS } from './plan-origins.ts'
import type {
  ColumnOrigin,
  ColumnRefusal,
  ColumnSources,
  PlanOrigins,
  PlanRefusal
} from './plan-origins.ts'

export interface CatalogForeignKey {
  constraintName: string
  /** Referencing columns of the base relation, in key order. */
  columns: string[]
  foreignSchema: string
  foreignRelation: string
  /** Referenced columns of the foreign relation, in the same key order. */
  foreignColumns: string[]
}

/**
 * A unique key of a base relation, read from `pg_index` rather than `pg_constraint`:
 * a foreign key may reference any unique index, a `UNIQUE` constraint's `conkey`
 * carries its `INCLUDE` columns as if they were key columns, and a unique index
 * without a constraint is a key all the same.
 */
export interface CatalogUniqueKey {
  /** The index's name. */
  name: string
  isPrimary: boolean
  columns: string[]
}

export interface CatalogColumn {
  typeId: number
  typeMod: number
  notNull: boolean
}

export interface CatalogRelation {
  schema: string
  relation: string
  foreignKeys: CatalogForeignKey[]
  uniqueKeys: CatalogUniqueKey[]
  columns: Map<string, CatalogColumn>
}

/** What `pg_cast` and the domain chain say about leaving a value alone. */
export interface TypeCoercions {
  /** Domain type oid → the type it is a domain over. */
  domainBase: ReadonlyMap<number, number>
  /** `${source}>${target}` for every `pg_cast` row with `castmethod = 'b'`. */
  binary: ReadonlySet<string>
}

/** One column of the relation whose relations are being derived. */
export interface ViewColumn {
  name: string
  typeId: number
  typeMod: number
}

export interface DerivedForeignKey {
  kind: 'foreignKey'
  /** View columns carrying the key, in the constraint's own key order. */
  viewColumns: string[]
  foreignSchema: string
  foreignRelation: string
  foreignColumns: string[]
  /** The catalog objects that authorise this relation, one per branch read. */
  via: { schema: string; relation: string; constraintName: string }[]
  /** The `@foreignKey` smart tag this relation is equivalent to. */
  tag: string
}

export interface DerivedPrimaryKey {
  kind: 'primaryKey'
  viewColumns: string[]
  via: { schema: string; relation: string; constraintName: string }
  /** The `@primaryKey` smart tag this key is equivalent to. */
  tag: string
}

export interface ViewDerivation {
  schema: string
  view: string
  /** `m` for a materialized view, `v` for a plain one. */
  relkind: 'v' | 'm'
  /** Column names in attribute order, as handed to `EXPLAIN`. */
  columns: string[]
  /** `null` when the plan could not be read positionally at all. */
  origins: ColumnSources[] | null
  /** Why the plan as a whole was not read, `null` where it was. */
  planRefusal: PlanRefusal | null
  /** Per column, why it has no sources; `null` where it has them. */
  columnRefusals: (ColumnRefusal | null)[]
  /** View columns that proxy a NOT NULL base column with no NULL introduced on the way. */
  notNullColumns: string[]
  foreignKeys: DerivedForeignKey[]
  primaryKey: DerivedPrimaryKey | null
  /**
   * Relations to a projection of this surface the catalog authorises and this reader
   * declined to lead, with the reason. Filled by `deriveProjectionRelations`.
   */
  declinedViewTargets: DeclinedViewTarget[]
  /** Why something a reader might expect was not derived. */
  notes: string[]
}

const BARE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/

function quoteIdentifier(name: string): string {
  return BARE_IDENTIFIER.test(name) ? name : `"${name.replaceAll('"', '""')}"`
}

/** The type a domain is ultimately a domain over, or the type itself. */
function baseTypeOf(typeId: number, coercions: TypeCoercions): number {
  let current = typeId
  for (let step = 0; step < 16; step++) {
    const next = coercions.domainBase.get(current)
    if (next === undefined) return current
    current = next
  }
  return current
}

/**
 * Whether the cast from the base column to the view column leaves the value alone.
 *
 * `castmethod = 'b'` is PostgreSQL's own word for it: the two types share a
 * representation and the datum is passed through untouched — `varchar` to `text`, a
 * domain to the type it is over. A cast through a function (`castmethod = 'f'` or
 * `'i'`) builds a new value: `bigint` to `numeric` is a different datum for the same
 * number, and a relation over it would join nothing.
 *
 * A type modifier on the target is a second coercion after the first, and it is the
 * one that truncates: `text` to `varchar(4)` is binary-coercible and still changes
 * `'usdt'` into something else for a longer value. It is accepted only where the
 * target imposes no modifier, or exactly the one the source already carries.
 */
export function valuePreservingCast(
  source: { typeId: number; typeMod: number },
  target: { typeId: number; typeMod: number },
  coercions: TypeCoercions
): boolean {
  const from = baseTypeOf(source.typeId, coercions)
  const to = baseTypeOf(target.typeId, coercions)
  if (from !== to && !coercions.binary.has(`${from}>${to}`)) return false
  return target.typeMod === -1 || target.typeMod === source.typeMod
}

/** A relation a single base column authorises on its own: a one-column key. */
interface SingleColumnTarget {
  foreignSchema: string
  foreignRelation: string
  foreignColumns: string[]
  via: { schema: string; relation: string; constraintName: string }
}

function targetKey(target: SingleColumnTarget): string {
  return `${target.foreignSchema}.${target.foreignRelation}(${target.foreignColumns.join(',')})`
}

function singleColumnTargets(
  origin: ColumnOrigin,
  catalog: ReadonlyMap<string, CatalogRelation>
): SingleColumnTarget[] {
  const base = catalog.get(`${origin.schema}.${origin.relation}`)
  if (!base) return []
  const targets: SingleColumnTarget[] = []
  for (const foreignKey of base.foreignKeys) {
    if (foreignKey.columns.length !== 1 || foreignKey.columns[0] !== origin.column) continue
    targets.push({
      foreignSchema: foreignKey.foreignSchema,
      foreignRelation: foreignKey.foreignRelation,
      foreignColumns: foreignKey.foreignColumns,
      via: {
        schema: origin.schema,
        relation: origin.relation,
        constraintName: foreignKey.constraintName
      }
    })
  }
  const primaryKey = base.uniqueKeys.find((key) => key.isPrimary)
  if (primaryKey?.columns.length === 1 && primaryKey.columns[0] === origin.column) {
    targets.push({
      foreignSchema: origin.schema,
      foreignRelation: origin.relation,
      foreignColumns: [origin.column],
      via: { schema: origin.schema, relation: origin.relation, constraintName: primaryKey.name }
    })
  }
  return targets
}

/**
 * The single view column that proxies `alias.column`, or `null` when no column
 * does, or more than one does. More than one is refused rather than resolved: a
 * key spread over two spellings of the same base column has no one right answer,
 * and picking the first would be a guess.
 */
function soleProxyOf(
  origins: ColumnSources[],
  columns: string[],
  alias: string,
  column: string
): string | null {
  let found: string | null = null
  for (let i = 0; i < origins.length; i++) {
    const sources = origins[i]
    if (sources?.length !== 1) continue
    const origin = sources[0]
    if (!origin || origin.alias !== alias || origin.column !== column) continue
    if (found !== null) return null
    found = columns[i] ?? null
  }
  return found
}

/**
 * The view columns carrying `keyColumns` of one scan instance, in key order, or
 * `null` if any of them is not proxied exactly once. The alias is part of the
 * match: a view that joins one table to itself proxies `t.a` from one row and
 * `t.b` from another, and a composite key assembled across the two would be a
 * key of no row that exists.
 */
function keyColumnsOf(
  origins: ColumnSources[],
  columns: string[],
  alias: string,
  keyColumns: string[]
): string[] | null {
  const carried: string[] = []
  for (const keyColumn of keyColumns) {
    const viewColumn = soleProxyOf(origins, columns, alias, keyColumn)
    if (viewColumn === null) return null
    carried.push(viewColumn)
  }
  return carried
}

function foreignKeyTag(
  viewColumns: string[],
  foreignSchema: string,
  foreignRelation: string,
  foreignColumns: string[]
): string {
  const local = viewColumns.map(quoteIdentifier).join(',')
  const foreign = foreignColumns.map(quoteIdentifier).join(',')
  const target = `${quoteIdentifier(foreignSchema)}.${quoteIdentifier(foreignRelation)}`
  return `(${local}) references ${target} (${foreign})`
}

/**
 * Every relation the catalog authorises for one view, given how the planner
 * resolved that view's columns.
 */
export function deriveViewConstraints(
  schema: string,
  view: string,
  relkind: 'v' | 'm',
  viewColumns: ViewColumn[],
  plan: PlanOrigins | PlanRefusal,
  catalog: ReadonlyMap<string, CatalogRelation>,
  coercions: TypeCoercions
): ViewDerivation {
  const notes: string[] = []
  const columns = viewColumns.map((column) => column.name)
  if (typeof plan === 'string') {
    return {
      schema,
      view,
      relkind,
      columns,
      origins: null,
      planRefusal: plan,
      columnRefusals: columns.map(() => null),
      notNullColumns: [],
      foreignKeys: [],
      primaryKey: null,
      declinedViewTargets: [],
      notes: [`plan not read — ${plan}: ${PLAN_REFUSALS[plan]}`]
    }
  }

  const columnRefusals: (ColumnRefusal | null)[] = [...plan.refusals]

  // A cast is a proxy only where it leaves the value alone, and the value may have
  // been cast at every view it passed through: a barrier view that narrows a column
  // and a view over it that casts the narrowed value back to the base type would
  // otherwise read as the base column itself. So the whole chain of types the value
  // took — the base column, each crossed view's own column, the view column being
  // derived — is walked step by step, and every step must hand the datum on untouched.
  const origins: ColumnSources[] = plan.columns.map((sources, index) => {
    const viewColumn = viewColumns[index]
    if (!sources || !viewColumn) return null
    for (const origin of sources) {
      if (!origin.coerced && origin.via.length === 0) continue
      const chain: ({ typeId: number; typeMod: number } | undefined)[] = [
        catalog.get(`${origin.schema}.${origin.relation}`)?.columns.get(origin.column),
        ...origin.via.map((step) =>
          catalog.get(`${step.schema}.${step.relation}`)?.columns.get(step.column)
        ),
        viewColumn
      ]
      const broken = chain.slice(0, -1).some((step, at) => {
        const next = chain[at + 1]
        return !step || !next || !valuePreservingCast(step, next, coercions)
      })
      if (broken) {
        columnRefusals[index] = 'cast-not-value-preserving'
        return null
      }
    }
    return sources
  })

  // Non-nullness, column by column: the base column is NOT NULL and the plan puts no
  // NULL of its own over it. A materialized view is left out — its stored row
  // outlives the row it was copied from, and the copy is the only thing this reader
  // ever sees of it.
  const notNullColumns: string[] = []
  for (const [index, sources] of origins.entries()) {
    const viewColumn = columns[index]
    if (viewColumn === undefined) continue
    if (relkind !== 'v') continue
    if (!sources || sources.length === 0) continue
    if (plan.nullIntroduced[index] !== false) continue
    const everyBranchNotNull = sources.every(
      (origin) =>
        catalog.get(`${origin.schema}.${origin.relation}`)?.columns.get(origin.column)?.notNull ===
        true
    )
    if (everyBranchNotNull) notNullColumns.push(viewColumn)
  }

  // Scan instances the columns actually came from, in first-appearance order. Only
  // a column with one source belongs to an instance; a column assembled out of a
  // union's branches belongs to none of them.
  const aliases: { alias: string; schema: string; relation: string }[] = []
  for (const sources of origins) {
    if (sources?.length !== 1) continue
    const origin = sources[0]
    if (!origin) continue
    if (aliases.some((seen) => seen.alias === origin.alias)) continue
    aliases.push({ alias: origin.alias, schema: origin.schema, relation: origin.relation })
  }

  const foreignKeys: DerivedForeignKey[] = []
  const emitted = new Set<string>()
  const emit = (
    viewColumns_: string[],
    target: Omit<SingleColumnTarget, 'via'>,
    via: DerivedForeignKey['via']
  ): void => {
    const tag = foreignKeyTag(
      viewColumns_,
      target.foreignSchema,
      target.foreignRelation,
      target.foreignColumns
    )
    if (emitted.has(tag)) return
    emitted.add(tag)
    foreignKeys.push({
      kind: 'foreignKey',
      viewColumns: viewColumns_,
      foreignSchema: target.foreignSchema,
      foreignRelation: target.foreignRelation,
      foreignColumns: target.foreignColumns,
      via,
      tag
    })
  }

  for (const instance of aliases) {
    const base = catalog.get(`${instance.schema}.${instance.relation}`)
    if (!base) continue
    for (const foreignKey of base.foreignKeys) {
      const carried = keyColumnsOf(origins, columns, instance.alias, foreignKey.columns)
      if (!carried) continue
      emit(
        carried,
        {
          foreignSchema: foreignKey.foreignSchema,
          foreignRelation: foreignKey.foreignRelation,
          foreignColumns: foreignKey.foreignColumns
        },
        [
          {
            schema: instance.schema,
            relation: instance.relation,
            constraintName: foreignKey.constraintName
          }
        ]
      )
    }
    // Identity: carrying a table's primary key is carrying a key of that table.
    const primaryKey = base.uniqueKeys.find((key) => key.isPrimary)
    if (primaryKey) {
      const carried = keyColumnsOf(origins, columns, instance.alias, primaryKey.columns)
      if (carried) {
        emit(
          carried,
          {
            foreignSchema: instance.schema,
            foreignRelation: instance.relation,
            foreignColumns: primaryKey.columns
          },
          [
            {
              schema: instance.schema,
              relation: instance.relation,
              constraintName: primaryKey.name
            }
          ]
        )
      }
    }
  }

  // A column a union assembles out of several base columns. Its value is one of
  // them per row, so only a relation every one of them authorises is true of the
  // column — the intersection, never the union, of what the branches allow.
  for (let index = 0; index < origins.length; index++) {
    const sources = origins[index]
    const viewColumn = columns[index]
    if (!sources || sources.length < 2 || viewColumn === undefined) continue
    let shared = new Map<string, SingleColumnTarget[]>()
    for (const [branch, origin] of sources.entries()) {
      const targets = new Map<string, SingleColumnTarget>()
      for (const target of singleColumnTargets(origin, catalog)) {
        targets.set(targetKey(target), target)
      }
      const kept = new Map<string, SingleColumnTarget[]>()
      for (const [key, target] of targets) {
        const carried = branch === 0 ? [] : shared.get(key)
        if (carried === undefined) continue
        kept.set(key, [...carried, target])
      }
      shared = kept
      if (shared.size === 0) break
    }
    if (shared.size === 0) {
      notes.push(
        `${viewColumn}: the union's branches proxy ${sources.length} different base columns with no key in common`
      )
      continue
    }
    for (const candidates of shared.values()) {
      const first = candidates[0]
      if (!first) continue
      emit(
        [viewColumn],
        {
          foreignSchema: first.foreignSchema,
          foreignRelation: first.foreignRelation,
          foreignColumns: first.foreignColumns
        },
        candidates.map((candidate) => candidate.via)
      )
    }
  }

  foreignKeys.sort((left, right) => left.tag.localeCompare(right.tag))

  // A key of the base table identifies a row of the view only when the view emits at
  // most one row per base row and never nulls its columns. One scan, no
  // set-returning projection and no outer join is the only shape where the plan
  // itself proves that; a join, even one the planner marks unique, is left to a
  // human.
  let primaryKey: DerivedPrimaryKey | null = null
  const soleInstance = aliases.length === 1 ? aliases[0] : undefined
  if (soleInstance) {
    const base = catalog.get(`${soleInstance.schema}.${soleInstance.relation}`)
    const candidates = (base?.uniqueKeys ?? []).filter(
      (key) =>
        // A unique index admits nulls where the primary key cannot; a null key
        // identifies no row, so only an all-NOT NULL one is a row identity.
        key.isPrimary || key.columns.every((column) => base?.columns.get(column)?.notNull === true)
    )
    const carriedCandidates = candidates
      .map((key) => ({
        key,
        viewColumns: keyColumnsOf(origins, columns, soleInstance.alias, key.columns)
      }))
      .filter((candidate) => candidate.viewColumns !== null)
    const chosen =
      carriedCandidates.find((candidate) => candidate.key.isPrimary) ?? carriedCandidates[0]
    if (!chosen) {
      if (candidates.length > 0) {
        notes.push(
          `no key carried: none of ${candidates.map((key) => key.name).join(', ')} is proxied exactly once`
        )
      }
    } else if (!plan.identityPreserving) {
      notes.push(
        `key ${chosen.key.name} declined: the plan does not prove one view row per ${soleInstance.schema}.${soleInstance.relation} row`
      )
    } else {
      primaryKey = {
        kind: 'primaryKey',
        viewColumns: chosen.viewColumns ?? [],
        via: {
          schema: soleInstance.schema,
          relation: soleInstance.relation,
          constraintName: chosen.key.name
        },
        tag: (chosen.viewColumns ?? []).map(quoteIdentifier).join(',')
      }
    }
  } else if (aliases.length > 1) {
    notes.push('key declined: the view proxies more than one relation')
  }

  for (const [index, refusal] of columnRefusals.entries()) {
    const viewColumn = columns[index]
    if (!refusal || viewColumn === undefined) continue
    notes.push(`${viewColumn}: ${refusal} — ${COLUMN_REFUSALS[refusal]}`)
  }

  return {
    schema,
    view,
    relkind,
    columns,
    origins,
    planRefusal: null,
    columnRefusals,
    notNullColumns,
    foreignKeys,
    primaryKey,
    declinedViewTargets: [],
    notes
  }
}

// ── A relation from one view to another ───────────────────────────────────────
//
// Everything above leads a view's relations to tables. A surface made of projections
// needs them led to projections too: where the table a relation points at is gone
// from the surface and a view of it is published instead, the only way from one
// projection to the next is a relation between the two.
//
// The catalog authorises such a relation out of the same two facts the derivation
// already stands on, and nothing else:
//
//   * the referencing half is a relation already derived above — a real
//     `convalidated` foreign key on the base column a view column proxies, or the
//     identity of a base table's own key that a view column carries;
//   * the referenced half is a view whose **row identity** is that very key. Row
//     identity is the claim made under `@primaryKey` above: the plan reads exactly
//     one row source, cannot multiply its rows and cannot null-extend them, so a
//     unique key of the base relation is unique in the view as well.
//
// Proxying the key is not by itself the referenced half. A view that joins its base
// to another relation proxies the key and repeats it, and a relation pointing at a
// repeated key is a relation to several rows. It is the row identity, not the proxy,
// that makes the key a key of the view — which is also what `PgFakeConstraintsPlugin`
// demands of the referenced side, and refuses the `@foreignKey` tag without.
//
// Both halves are read out of `pg_constraint` and `pg_index`, and the row identity
// under the referenced key is the same derivation this reader publishes as the
// referenced view's own `@primaryKey` — so a key asserted by hand over the referenced
// view is not a key this pass may point at. Which key actually reaches the schema is
// a question about the referenced view's tags rather than about the catalog, and
// `declaredRowIdentity` below is how the caller answers it.
//
// The relation is nullable, and cannot be anything else. A view carries qualifiers of
// its own, so the row the key names may not be in it, and the traversal comes back
// empty — exactly as it does for a table under a row-level security policy that hides
// the row. PostGraphile lives with that everywhere else, and nothing here may derive a
// relation's own non-nullness, for a view or for a table.
//
// The candidates are the views of **this surface** and no others, and that is a
// policy rather than a thing the tooling forces. `PgFakeConstraintsPlugin` resolves
// the referenced name against the whole database — the introspection query reads
// every namespace and `getClassByName` searches the whole list — so a name outside
// the published schemas resolves perfectly well. It just leads nowhere: `PgTablesPlugin`
// builds a resource only for the schemas the service names, and `PgRelationsPlugin`
// drops a constraint whose foreign class has none, so the relation would reach no
// field. The policy is the reason to begin with: what is published together is what
// is meant to be traversed together, and a projection of another surface is not a
// place this one can go.

/**
 * Why a relation the catalog authorises was not led to a projection. Closed like
 * `PLAN_REFUSALS` and `COLUMN_REFUSALS`, and for the same reason: a relation that
 * could have been led somewhere and was not has to say so, or "no projection carries
 * this key" and "several do" become one silence.
 */
export const TARGET_REFUSALS = {
  'more-than-one-projection-carries-the-key':
    'the key this relation points at is the row identity of more than one view of ' +
    'this surface, and nothing in the catalog says which of them was meant'
} as const

export type TargetRefusal = keyof typeof TARGET_REFUSALS

/** A relation to a projection this reader declined to lead, and why. */
export interface DeclinedViewTarget {
  /** The view columns that would have carried it. */
  viewColumns: string[]
  /** `schema.relation(columns)` — the base key the projections are keyed by. */
  key: string
  refusal: TargetRefusal
  /** `schema.name` of every projection keyed by it. */
  candidates: string[]
}

/** A view whose row identity is one named key of one base relation. */
interface KeyedProjection {
  schema: string
  view: string
  /** The unique key of the base relation this view is one row of. */
  key: { schema: string; relation: string; constraintName: string }
  /** Base column name → the view column proxying it. */
  columns: ReadonlyMap<string, string>
}

/**
 * The key a relation points at, as a name independent of the order the two catalog
 * objects spell it in: a foreign key's `confkey` and the unique index it references
 * are the same set of columns, and PostgreSQL matches them as a set.
 */
function keyName(schema: string, relation: string, columns: readonly string[]): string {
  return `${schema}.${relation}(${[...columns].sort().join(',')})`
}

/**
 * Whether a view reaches the published schema as an enumeration rather than as an
 * object — the `@enum` smart tag. Such a view is no place to lead a relation to.
 */
export type PublishedAsEnumeration = (schema: string, view: string) => boolean

/**
 * The `@primaryKey` a human wrote on a view, or `null` where none is written. Like
 * `@enum`, this lives in the surface's smart tags rather than in the catalog, so the
 * caller answers it and this reader is handed the answer.
 *
 * It is asked because a hand-written `@primaryKey` is the one that reaches the
 * schema: the plugin declares what it derives only where the view states nothing, so
 * a view whose author named another key of the same table is published under that
 * key and not under the derived one. Both keys can be right at once — a projection of
 * `t(id, code)` keyed by `code` by hand and by `id` by derivation — and a relation
 * led to the derived one would then reference a key the view does not publish.
 * `PgFakeConstraintsPlugin` checks exactly that: it requires a `p` or `u` constraint
 * on the referenced class whose attributes are the referenced ones, and throws
 * `referenced non-unique combination of attributes` when there is none, which fails
 * the whole build rather than thinning one field.
 */
export type DeclaredRowIdentity = (schema: string, view: string) => string | null

/**
 * The columns a `@primaryKey` tag names, read the way `PgFakeConstraintsPlugin`
 * reads it: the spec is everything before the first `|`, a quoted identifier is
 * taken literally and an unquoted one is lower-cased, as PostgreSQL does. Compared
 * as a set, because that plugin matches the referenced attributes as a set too.
 */
function rowIdentityColumns(tag: string): string {
  const [spec = ''] = tag.split('|')
  return spec
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
        ? trimmed.slice(1, -1)
        : trimmed.toLowerCase()
    })
    .sort()
    .join(',')
}

/**
 * Every view of this surface that is a row of one base relation, indexed by the key
 * it is a row of. A view with no derived row identity is in no entry: without it the
 * key it proxies is not a key of the view.
 *
 * A view whose author wrote a `@primaryKey` of their own naming other columns is in
 * no entry either. The derived key is not declared where a hand-written one stands,
 * so it is not the key the view is published under, and a relation may only point at
 * the key that reaches the schema.
 *
 * A view published as an enumeration is in no entry either. `PgEnumTablesPlugin`
 * "converts columns that reference `@enum` tables into enums": a relation to such a
 * view is not a traversal at all — there is no object to arrive at — it retypes the
 * referencing column of the published schema. The relation is not derived rather
 * than derived and hidden, because a constraint pointing at an enum table retypes
 * the column whoever wrote it.
 */
function projectionsByKey(
  derivations: readonly ViewDerivation[],
  catalog: ReadonlyMap<string, CatalogRelation>,
  publishedAsEnumeration: PublishedAsEnumeration,
  declaredRowIdentity: DeclaredRowIdentity
): Map<string, KeyedProjection[]> {
  const index = new Map<string, KeyedProjection[]>()
  for (const derivation of derivations) {
    const identity = derivation.primaryKey
    if (!identity) continue
    if (publishedAsEnumeration(derivation.schema, derivation.view)) continue
    const declared = declaredRowIdentity(derivation.schema, derivation.view)
    if (declared !== null && rowIdentityColumns(declared) !== rowIdentityColumns(identity.tag)) {
      continue
    }
    const base = catalog.get(`${identity.via.schema}.${identity.via.relation}`)
    const key = base?.uniqueKeys.find((candidate) => candidate.name === identity.via.constraintName)
    if (!key || key.columns.length !== identity.viewColumns.length) continue
    const columns = new Map<string, string>()
    key.columns.forEach((column, position) => {
      const viewColumn = identity.viewColumns[position]
      if (viewColumn !== undefined) columns.set(column, viewColumn)
    })
    const name = keyName(identity.via.schema, identity.via.relation, key.columns)
    const carried = index.get(name)
    const projection: KeyedProjection = {
      schema: derivation.schema,
      view: derivation.view,
      key: {
        schema: identity.via.schema,
        relation: identity.via.relation,
        constraintName: identity.via.constraintName
      },
      columns
    }
    if (carried) carried.push(projection)
    else index.set(name, [projection])
  }
  for (const projections of index.values()) {
    projections.sort((left, right) =>
      `${left.schema}.${left.view}`.localeCompare(`${right.schema}.${right.view}`)
    )
  }
  return index
}

/**
 * Leads every relation already derived for these views to the projection of this
 * surface that is keyed by the same base key, where exactly one view is.
 *
 * Exactly one, counted over every view of the surface, the asking view included. The
 * discipline is the one already taken for descending through a `Subquery Scan`: one
 * candidate is an answer, several are a guess, and a guess would publish a relation
 * to a projection nobody chose.
 *
 * The one relation dropped rather than led is the row's identity with **its own
 * row**: the candidate is the asking view and every column of the reference names
 * the column it is led from, so the relation says a row is itself, which the view's
 * `@primaryKey` already says and a relation would only repeat. It is dropped rather
 * than refused, that being the ordinary shape of a surface with one projection per
 * table rather than a case anybody has to be told about.
 *
 * A relation that points at the asking view over *other* columns is a different
 * statement and is led like any other. `(parent_id) references v_node (id)` is the
 * hierarchy a self-referencing table has, and it reaches another row — the parent —
 * about which `@primaryKey` says nothing at all. The two are told apart column by
 * column, not by the name of the view, because a composite key spelled in the other
 * order — `(a,b) references v (b,a)` — reaches another row as well.
 *
 * The relation to the base table is left exactly as it was. Two relations then stand
 * on a column whose table and whose projection are both published, and they are two
 * different traversals — a table row and a projection row are different objects, with
 * different fields and different qualifiers over them — so choosing between them
 * would be choosing which object a caller reaches, which is the surface author's
 * choice and not a derivation's. Suppressing one would also make the answer
 * non-local: publishing a projection would silently delete a relation the schema
 * already had, and a derivation that removes what it did not add is not one anybody
 * can read back.
 *
 * The pass answers the same thing however often it is run over the same derivations:
 * a relation it already led is one of the declared tags it reads, and a target it
 * already declined is not declined a second time. One call per surface is the only
 * call there is, and a reader who writes a second one gets the same answer rather
 * than a doubled one.
 */
export function deriveProjectionRelations(
  derivations: ViewDerivation[],
  catalog: ReadonlyMap<string, CatalogRelation>,
  publishedAsEnumeration: PublishedAsEnumeration = () => false,
  declaredRowIdentity: DeclaredRowIdentity = () => null
): void {
  const index = projectionsByKey(derivations, catalog, publishedAsEnumeration, declaredRowIdentity)
  for (const derivation of derivations) {
    const declared = new Set(derivation.foreignKeys.map((foreignKey) => foreignKey.tag))
    const alreadyDeclined = new Set(
      derivation.declinedViewTargets.map(
        (target) => `${target.viewColumns.join(',')} → ${target.key}`
      )
    )
    const declinedHere: DeclinedViewTarget[] = []
    const led: DerivedForeignKey[] = []
    for (const foreignKey of derivation.foreignKeys) {
      const name = keyName(
        foreignKey.foreignSchema,
        foreignKey.foreignRelation,
        foreignKey.foreignColumns
      )
      const candidates = index.get(name) ?? []
      if (candidates.length === 0) continue
      if (candidates.length > 1) {
        if (alreadyDeclined.has(`${foreignKey.viewColumns.join(',')} → ${name}`)) continue
        declinedHere.push({
          viewColumns: foreignKey.viewColumns,
          key: name,
          refusal: 'more-than-one-projection-carries-the-key',
          candidates: candidates.map((candidate) => `${candidate.schema}.${candidate.view}`)
        })
        continue
      }
      const [projection] = candidates
      if (!projection) continue
      const foreignColumns = foreignKey.foreignColumns.map((column) =>
        projection.columns.get(column)
      )
      if (foreignColumns.some((column) => column === undefined)) continue
      const carried = foreignColumns as string[]
      // The row's identity with its own row: the asking view, reached over the very
      // columns the relation is led from. Anything else on the asking view — a
      // parent, a predecessor, a key spelled in another order — reaches another row.
      if (
        projection.schema === derivation.schema &&
        projection.view === derivation.view &&
        carried.every((column, position) => column === foreignKey.viewColumns[position])
      ) {
        continue
      }
      const tag = foreignKeyTag(foreignKey.viewColumns, projection.schema, projection.view, carried)
      if (declared.has(tag)) continue
      declared.add(tag)
      led.push({
        kind: 'foreignKey',
        viewColumns: foreignKey.viewColumns,
        foreignSchema: projection.schema,
        foreignRelation: projection.view,
        foreignColumns: carried,
        // Both halves, named: the constraint that authorises the reference and the
        // unique key of the same base relation the projection is a row of.
        via: [...foreignKey.via, projection.key],
        tag
      })
    }
    derivation.foreignKeys.push(...led)
    derivation.foreignKeys.sort((left, right) => left.tag.localeCompare(right.tag))
    derivation.declinedViewTargets.push(...declinedHere)
    for (const declined of declinedHere) {
      derivation.notes.push(
        `(${declined.viewColumns.join(',')}) → ${declined.key}: ` +
          `${declined.refusal} — ${TARGET_REFUSALS[declined.refusal]}; ` +
          `${declined.candidates.join(', ')}`
      )
    }
  }
}
