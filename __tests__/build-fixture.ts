// Rebuilds `PgViewConstraintsPlugin.fixture.json` from a real PostgreSQL.
//
// The fixture is PostgreSQL's own answer for the schema in
// `PgViewConstraintsPlugin.lab.sql` — the plans, the constraints, the unique
// indexes, the column types and the binary-coercible casts — read back through the
// plugin's own catalog queries, so that a case in the unit test is a case the
// database really produces rather than a plan somebody typed.
//
// Every view is planned once per planner regime. The plan of a view is the planner's
// judgement of cost, and a reader whose answer moved with that judgement would
// publish a different contract against an empty database than against a full one; the
// regimes force the plans apart so the unit test can hold every reading of one view
// against the others.
//
// Usage: PGHOST=… PGPORT=… yarn fixture
// It creates and drops its own database (VIEW_CONSTRAINTS_LAB_DB, default
// `view_constraints_lab`) as PGUSER (default `postgres`).

import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import pg from 'pg'
import {
  explainStatement,
  readCatalogRelations,
  readRelationOids,
  readShadowedNames,
  readStrictEquality,
  readTables,
  readTypeCoercions,
  readViewTrees,
  readViews,
  readViewSources,
  resolveCteOrigins,
  resolveTreeColumns
} from '../src/PgViewConstraintsPlugin/collect.ts'
import type { RunQuery } from '../src/PgViewConstraintsPlugin/collect.ts'
import type { ExplainPlanNode } from '../src/PgViewConstraintsPlugin/plan-origins.ts'
import { PLANNER_REGIMES } from '../src/PgViewConstraintsPlugin/invariance.ts'

const PGHOST = process.env['PGHOST'] ?? '127.0.0.1'
const PGPORT = process.env['PGPORT'] ?? '5432'
const PGUSER = process.env['PGUSER'] ?? 'postgres'
const LAB = process.env['VIEW_CONSTRAINTS_LAB_DB'] ?? 'view_constraints_lab'
const ADMIN = process.env['PGDATABASE'] ?? 'postgres'

const LAB_SQL = new URL('./PgViewConstraintsPlugin.lab.sql', import.meta.url)
const FIXTURE = new URL('./PgViewConstraintsPlugin.fixture.json', import.meta.url)

/**
 * The regimes the lab views are planned under, named out of the plugin's own list.
 * `default` is what the test's own cases are written against; the rest exist so that
 * the test can check every one of them derives what `default` derives. Fewer than the
 * invariance proof runs, because each one is a copy of every lab plan in the fixture.
 */
const LAB_REGIMES = [
  'default',
  'serial',
  'parallel-forced',
  'no-hashagg',
  'no-sort',
  'no-seqscan',
  'nestloop-only',
  'genetic-join-order'
]
const REGIMES = LAB_REGIMES.map((name) => {
  const regime = PLANNER_REGIMES.find((candidate) => candidate.name === name)
  if (!regime) throw new Error(`no planner regime named ${name}`)
  return regime
})

// The statistics the planner reads are its other input, and a shape can move with them
// alone: whether a `WITH` query this view inlines is pulled up is a cost decision, and
// the row counts are what it costs. The regimes the contract was seen to move on are
// read again from production-scale counts — the two that meet a grouping flattened and a
// grouping kept — rather than every one of them, which would double the fixture for the
// same axis. `ANALYZE` puts the counts back before the database is dropped.
const PRODUCTION_REGIMES = ['default', 'nestloop-only']
const STATISTICS_STATES: { name: string; sql: string | null; regimes: string[] }[] = [
  { name: '', sql: null, regimes: LAB_REGIMES },
  {
    name: 'production/',
    regimes: PRODUCTION_REGIMES,
    sql: `
      UPDATE pg_class SET reltuples = 5e6, relpages = 200000
      WHERE relkind IN ('r', 'm', 'i')
        AND relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)`
  }
]
const REGIME_COUNT = STATISTICS_STATES.reduce((total, state) => total + state.regimes.length, 0)

// Only the fields `plan-origins.ts` and `plan-keys.ts` read are kept, so that the
// fixture is the reader's input and not a transcript of everything EXPLAIN happens to
// print.
const PLAN_FIELDS = [
  'Node Type',
  'Output',
  'Schema',
  'Relation Name',
  'Alias',
  'Join Type',
  'Parent Relationship',
  'Grouping Sets',
  'Index Name',
  'Group Key',
  'Partial Mode',
  'CTE Name',
  'Subplan Name',
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Filter',
  'Index Cond',
  'Recheck Cond',
  'TID Cond'
] as const

function prune(node: Record<string, unknown>): ExplainPlanNode {
  const kept: Record<string, unknown> = {}
  for (const field of PLAN_FIELDS) {
    if (node[field] !== undefined) kept[field] = node[field]
  }
  const children = node['Plans']
  if (Array.isArray(children)) {
    kept['Plans'] = children.map((child) => prune(child as Record<string, unknown>))
  }
  return kept as unknown as ExplainPlanNode
}

function runQueryOn(client: pg.Client): RunQuery {
  return async <Row>(text: string, values?: unknown[]) => {
    const result = await client.query({ text, values })
    return result.rows as Row[]
  }
}

async function open(database: string, settings: string[] = []): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: `postgres://${PGUSER}@${PGHOST}:${PGPORT}/${database}`
  })
  await client.connect()
  for (const statement of settings) await client.query(statement)
  return client
}

const admin = await open(ADMIN)
await admin.query(`DROP DATABASE IF EXISTS ${LAB} WITH (FORCE)`)
await admin.query(`CREATE DATABASE ${LAB}`)
await admin.end()

const lab = await open(LAB)
await lab.query(readFileSync(LAB_SQL, 'utf8'))
// The lab schema is written unqualified, and `pg_get_viewdef` deparses against the
// search path, so every session below reads and plans it with the same one.

const catalog = await readCatalogRelations(runQueryOn(lab))
const coercions = await readTypeCoercions(runQueryOn(lab))
const strictEquality = await readStrictEquality(runQueryOn(lab))
// The rule spellings a user object has taken over in the lab: the names whose rule
// stands down database-wide.
const shadowedNames = [...(await readShadowedNames(runQueryOn(lab)))].sort()
// Each view's stored rewrite tree: its CTE columns and the base column each of its own
// columns came from. Read only on a major the format is checked against — the fixture
// is the lab for those majors, and one built without its trees would carry empty CTE
// maps that look like a database with no `WITH` query at all.
const treeRead = await readViewTrees(runQueryOn(lab), ['lab'])
if (!treeRead.supported) {
  throw new Error(
    'the lab fixture is built on a PostgreSQL major outside the range the stored ' +
      'rewrite tree is read against (15–18); build it on one of those'
  )
}
const viewTrees = treeRead.trees
const relationOids = await readRelationOids(runQueryOn(lab))
const views = await readViews(runQueryOn(lab), ['lab'])
// The tables of the lab, each a referencing half of a relation to a projection.
const tables = await readTables(runQueryOn(lab), ['lab'])
// The views each lab view is built on: the map a `Subquery Scan` over one of them is
// crossed by, and a fact about the schema rather than about any plan.
const viewSources = (await readViewSources(runQueryOn(lab))).filter((view) => view.schema === 'lab')

const planned: unknown[] = []
for (const state of STATISTICS_STATES) {
  if (state.sql !== null) await lab.query(state.sql)
  for (const name of state.regimes) {
    const regime = REGIMES.find((candidate) => candidate.name === name)
    if (!regime) throw new Error(`no planner regime named ${name}`)
    const session = await open(LAB, ['SET search_path = lab', ...regime.settings])
    for (const view of views) {
      const columns = (view.columns ?? []).map((column) => ({
        name: column.name,
        typeId: column.type_id,
        typeMod: column.type_mod
      }))
      if (columns.length === 0) continue
      const rows = await session.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(
        explainStatement({ ...view, columns })
      )
      const plan = rows.rows[0]?.['QUERY PLAN']?.[0]?.Plan
      if (!plan) throw new Error(`${view.view}: EXPLAIN returned no plan`)
      const facts = viewTrees.get(`lab.${view.view}`)
      // Each range-table alias the view's stored tree names, resolved to the relation it
      // stands for, so a `Subquery Scan` spelled with an explicit alias is crossable.
      const viewAliases = Object.fromEntries(
        [...(facts?.relationAliases ?? [])].flatMap(([alias, relid]) => {
          const relation = relationOids.get(relid)
          return relation ? [[alias, relation.relation]] : []
        })
      )
      planned.push({
        schema: view.schema,
        view: view.view,
        relkind: view.relkind,
        regime: `${state.name}${regime.name}`,
        columns,
        treeOk: facts?.ok ?? false,
        cteColumns: Object.fromEntries(facts?.cteColumns ?? new Map()),
        cteOrigins: Object.fromEntries(
          resolveCteOrigins(relationOids, facts?.cteOrigins ?? new Map())
        ),
        cteAmbiguous: [...(facts?.cteAmbiguous ?? [])].sort(),
        cteMaterialized: Object.fromEntries(facts?.cteMaterialized ?? new Map()),
        cteRefCount: Object.fromEntries(facts?.cteRefCount ?? new Map()),
        treeColumns: Object.fromEntries(
          resolveTreeColumns(relationOids, facts?.treeOrigins ?? new Map())
        ),
        inlinedWithColumns: [...(facts?.inlinedWithColumns ?? [])].sort(
          (left, right) => left - right
        ),
        viewAliases,
        plan: prune(plan)
      })
    }
    await session.end()
  }
}
await lab.query('ANALYZE')
await lab.end()

// Only the lab's own relations: the fixture is about this schema, and the catalog of
// a whole database would bury it.
const labCatalog = [...catalog.values()]
  .filter((relation) => relation.schema === 'lab')
  .sort((left, right) => left.relation.localeCompare(right.relation))
  .map((relation) => ({
    schema: relation.schema,
    relation: relation.relation,
    foreignKeys: relation.foreignKeys,
    uniqueKeys: relation.uniqueKeys,
    partialIndexes: relation.partialIndexes,
    columns: Object.fromEntries(relation.columns)
  }))

// Only the coercions the lab's own column types can reach, for the same reason.
const labTypes = new Set<number>()
for (const relation of labCatalog) {
  for (const column of Object.values(relation.columns)) labTypes.add(column.typeId)
}
for (const entry of planned) {
  for (const column of (entry as { columns: { typeId: number }[] }).columns) {
    labTypes.add(column.typeId)
  }
}
const reachable = new Set(labTypes)
for (const [domain, base] of coercions.domainBase) {
  if (reachable.has(domain)) reachable.add(base)
}

writeFileSync(
  FIXTURE,
  JSON.stringify(
    {
      catalog: labCatalog,
      coercions: {
        binary: [...coercions.binary]
          .filter((pair) => {
            const [source, target] = pair.split('>').map(Number)
            return reachable.has(source ?? -1) && reachable.has(target ?? -1)
          })
          .sort(),
        domainBase: Object.fromEntries(
          [...coercions.domainBase].filter(([domain]) => reachable.has(domain))
        )
      },
      strictEquality,
      shadowedNames,
      tables,
      viewSources,
      views: planned
    },
    null,
    2
  ) + '\n'
)

const adminAgain = await open(ADMIN)
await adminAgain.query(`DROP DATABASE IF EXISTS ${LAB} WITH (FORCE)`)
await adminAgain.end()

process.stdout.write(
  `view-constraints fixture: ${labCatalog.length} relations, ${views.length} views × ${REGIME_COUNT} regimes\n`
)
