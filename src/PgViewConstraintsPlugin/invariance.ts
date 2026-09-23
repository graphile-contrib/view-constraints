// Proves that what `PgViewConstraintsPlugin` derives does not depend on the
// shape of the plan the planner happened to choose.
//
// The plugin reads the planner's answer, and the planner answers with whatever plan
// it costed cheapest: statistics, parallelism and the `enable_*` switches all move
// that choice. A contract that moved with it would differ between an empty CI
// database and production, which is not a contract at all. So the derivation is run
// over every view of every service once per planner regime below, and the four
// things that reach the published schema — the foreign keys, the primary key, the
// non-null columns, and whether the view was read at all — are compared byte for
// byte across the regimes.
//
// Fixing the planner is exactly what the plugin must not do; it is what this module
// does, on purpose, to force the plans apart.

import { collectViewConstraints } from './collect.ts'
import type { RunQuery } from './collect.ts'

/**
 * Opens a session on one connection string with the caller's driver; the plugin
 * carries none of its own.
 */
export type OpenSession = (connectionString: string) => Promise<{
  query: RunQuery
  end(): Promise<void>
}>

/** A set of planner settings, applied with `SET` before anything is read. */
export interface PlannerRegime {
  name: string
  settings: string[]
}

/**
 * Planner regimes. Between them they move the plan of a view through parallel and
 * serial shapes, through every join method, through sequential and index access,
 * through the join orders `join_collapse_limit` forces and the genetic optimizer
 * finds, and through both implementations of grouping and de-duplication.
 */
export const PLANNER_REGIMES: readonly PlannerRegime[] = [
  { name: 'default', settings: [] },
  { name: 'serial', settings: ['SET max_parallel_workers_per_gather = 0'] },
  {
    name: 'parallel-forced',
    settings: [
      'SET max_parallel_workers_per_gather = 4',
      'SET parallel_setup_cost = 0',
      'SET parallel_tuple_cost = 0',
      'SET min_parallel_table_scan_size = 0',
      'SET min_parallel_index_scan_size = 0'
    ]
  },
  { name: 'no-seqscan', settings: ['SET enable_seqscan = off'] },
  {
    name: 'no-index-access',
    settings: ['SET enable_indexscan = off', 'SET enable_bitmapscan = off']
  },
  // A nested loop pushes a join's condition down into its inner index scan, where a
  // hash join keeps it at the join.
  {
    name: 'nestloop-only',
    settings: ['SET enable_hashjoin = off', 'SET enable_mergejoin = off']
  },
  { name: 'no-nestloop', settings: ['SET enable_nestloop = off'] },
  {
    name: 'no-hashagg',
    settings: ['SET enable_hashagg = off', 'SET enable_incremental_sort = off']
  },
  { name: 'no-sort', settings: ['SET enable_sort = off'] },
  {
    name: 'no-collapse',
    settings: ['SET from_collapse_limit = 1', 'SET join_collapse_limit = 1']
  },
  {
    name: 'no-material',
    settings: ['SET enable_material = off', 'SET enable_memoize = off']
  },
  { name: 'tiny-memory', settings: ['SET work_mem = 64', 'SET hash_mem_multiplier = 1.0'] },
  { name: 'huge-memory', settings: ['SET work_mem = 1048576'] },
  { name: 'random-page-expensive', settings: ['SET random_page_cost = 1000'] },
  {
    name: 'random-page-cheap',
    settings: ['SET random_page_cost = 0.05', 'SET cpu_tuple_cost = 0.5']
  },
  // The genetic optimizer arrives at a join order by a different algorithm entirely,
  // and can pair two relations with nothing between them first.
  { name: 'genetic-join-order', settings: ['SET geqo = on', 'SET geqo_threshold = 2'] }
]

/** One PostGraphile service whose views are derived, as the plugin derives them. */
export interface InvarianceTarget {
  name: string
  /** The service's own connection: the role its schema is built as. */
  connectionString: string
  schemas: string[]
}

/** The part of a derivation that reaches the published schema. */
interface Contract {
  view: string
  relkind: string
  planReadable: boolean
  foreignKeys: string[]
  primaryKey: string | null
  notNull: string[]
}

interface TargetContract {
  target: string
  views: Contract[]
  failures: string[]
  skipped: string[]
}

async function openWith(
  open: OpenSession,
  url: string,
  settings: readonly string[]
): ReturnType<OpenSession> {
  const session = await open(url)
  for (const statement of settings) await session.query(statement)
  return session
}

async function contractOf(
  open: OpenSession,
  target: InvarianceTarget,
  ownerConnectionString: string,
  settings: readonly string[]
): Promise<TargetContract> {
  const targetSession = await openWith(open, target.connectionString, settings)
  const ownerSession = await openWith(open, ownerConnectionString, settings)
  try {
    const collected = await collectViewConstraints(
      targetSession.query,
      target.schemas,
      ownerSession.query
    )
    return {
      target: target.name,
      views: collected.derivations.map((derived) => ({
        view: `${derived.schema}.${derived.view}`,
        relkind: derived.relkind,
        planReadable: derived.origins !== null,
        foreignKeys: derived.foreignKeys.map((key) => key.tag).sort(),
        primaryKey: derived.primaryKey?.tag ?? null,
        notNull: [...derived.notNullColumns].sort()
      })),
      failures: collected.failures
        .map((failure) => `${failure.schema}.${failure.view}: ${failure.error}`)
        .sort(),
      skipped: collected.skipped.map((skip) => `${skip.schema}.${skip.view}: ${skip.reason}`).sort()
    }
  } finally {
    await targetSession.end()
    await ownerSession.end()
  }
}

/** One line per view, so a difference names the view that moved. */
function indexed(contracts: TargetContract[]): Map<string, string> {
  const lines = new Map<string, string>()
  for (const target of contracts) {
    for (const view of target.views) {
      lines.set(
        `${target.target} ${view.view}`,
        `readable=${view.planReadable} fk=[${view.foreignKeys.join('; ')}] pk=${view.primaryKey ?? '-'} nn=[${view.notNull.join(',')}]`
      )
    }
    for (const failure of target.failures) {
      lines.set(`${target.target} !! ${failure.split(':')[0] ?? ''}`, `failure: ${failure}`)
    }
    for (const skip of target.skipped) {
      lines.set(`${target.target} ?? ${skip.split(':')[0] ?? ''}`, `skipped: ${skip}`)
    }
  }
  return lines
}

function differences(left: Map<string, string>, right: Map<string, string>): string[] {
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort()
  const found: string[] = []
  for (const key of keys) {
    const before = left.get(key)
    const after = right.get(key)
    if (before === after) continue
    found.push(
      `    ${key}\n      baseline: ${before ?? '<absent>'}\n      regime:   ${after ?? '<absent>'}`
    )
  }
  return found
}

async function asOwner(
  open: OpenSession,
  ownerConnectionString: string,
  statement: string
): Promise<void> {
  const session = await open(ownerConnectionString)
  try {
    await session.query(statement)
  } finally {
    await session.end()
  }
}

/**
 * The planner's other input, in three states: the statistics the database was found
 * with, the statistics `ANALYZE` writes, and invented production-scale row counts.
 * Every regime is run again in each of them.
 */
const PASSES = ['as found', 'after ANALYZE', 'production-scale row counts'] as const

// The database a schema is generated against in CI is empty, and the one the
// contract has to hold over is not. An empty relation makes the planner's choice
// easy in one direction every time, so the row counts it reads are overwritten here
// with production-scale ones — the only way, short of loading the data, to ask it
// the question production asks. Writing `pg_class` needs rights the services do not
// have; where the owner does not have them either, this pass says so and stands down
// rather than passing quietly.
const PRODUCTION_SCALE_STATISTICS = `
  UPDATE pg_class
  SET reltuples = 5e6, relpages = 200000
  WHERE relkind IN ('r', 'm', 'i')
    AND relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)`

/**
 * Derives every view of every target under every regime, in each state of the
 * statistics, and reports each rendering that differs from the first. Returns whether
 * all of them were byte-identical.
 *
 * `ownerConnectionString` is a role that may read what materialized views were
 * copied from and write `pg_class` — ordinarily the owner of the schemas. The
 * database is `ANALYZE`d when the run ends, so the invented row counts do not stay.
 */
export async function proveInvariance(
  targets: readonly InvarianceTarget[],
  ownerConnectionString: string,
  open: OpenSession,
  write: (line: string) => void
): Promise<boolean> {
  const renderAll = async (settings: readonly string[]): Promise<string> => {
    const contracts: TargetContract[] = []
    for (const target of targets) {
      contracts.push(await contractOf(open, target, ownerConnectionString, settings))
    }
    return JSON.stringify(contracts, null, 2)
  }

  let baseline: string | null = null
  let baselineIndex = new Map<string, string>()
  let failed = false
  try {
    for (const pass of PASSES) {
      if (pass === 'after ANALYZE') await asOwner(open, ownerConnectionString, 'ANALYZE')
      if (pass === 'production-scale row counts') {
        try {
          await asOwner(open, ownerConnectionString, PRODUCTION_SCALE_STATISTICS)
        } catch (error) {
          write(`skip ${pass}: ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
      for (const regime of PLANNER_REGIMES) {
        const rendering = await renderAll(regime.settings)
        if (baseline === null) {
          baseline = rendering
          baselineIndex = indexed(JSON.parse(rendering) as TargetContract[])
          write(`ok   ${pass} · ${regime.name} (baseline)`)
          continue
        }
        if (rendering === baseline) {
          write(`ok   ${pass} · ${regime.name}`)
          continue
        }
        failed = true
        const moved = differences(baselineIndex, indexed(JSON.parse(rendering) as TargetContract[]))
        write(`FAIL ${pass} · ${regime.name}: ${moved.length} views moved`)
        for (const line of moved) write(line)
      }
    }
  } finally {
    await asOwner(open, ownerConnectionString, 'ANALYZE').catch(() => undefined)
  }
  return !failed
}
