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
  readStrictEquality,
  readTypeCoercions,
  readViews,
  readViewSources
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
const views = await readViews(runQueryOn(lab), ['lab'])
// The views each lab view is built on: the map a `Subquery Scan` over one of them is
// crossed by, and a fact about the schema rather than about any plan.
const viewSources = (await readViewSources(runQueryOn(lab))).filter((view) => view.schema === 'lab')

const planned: unknown[] = []
for (const regime of REGIMES) {
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
    planned.push({
      schema: view.schema,
      view: view.view,
      relkind: view.relkind,
      regime: regime.name,
      columns,
      plan: prune(plan)
    })
  }
  await session.end()
}
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
  `view-constraints fixture: ${labCatalog.length} relations, ${views.length} views × ${REGIMES.length} regimes\n`
)
