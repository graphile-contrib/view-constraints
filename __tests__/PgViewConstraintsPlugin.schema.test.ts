// The parts meet only in a real schema build: the derivation's `indexBacked` answer,
// the codec extensions this plugin writes, `PgIndexBehaviorsPlugin`'s behavior callback
// and the backward-relation mark; and the derived keys a schema needs to build at all,
// which `reportingPreset`'s reporting instance has to declare. That build needs a live
// PostgreSQL, so this file is run by `yarn test:lab` in the CI `lab` job (PostgreSQL
// 15-18) and is not part of `yarn test`: a job without a server would otherwise report
// a skipped test, which is not a green result.

import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { isEnumType, isInputObjectType, isInterfaceType, isObjectType, printSchema } from 'graphql'
import type { GraphQLSchema } from 'graphql'
import pg from 'pg'
import { makeSchema } from 'postgraphile'
import { defaultPreset as graphileBuildPreset } from 'graphile-build'
import { defaultPreset as graphileBuildPgPreset } from 'graphile-build-pg'
import { makePgService } from '@dataplan/pg/adaptors/pg'
import { PgViewConstraintsPlugin } from '../src/PgViewConstraintsPlugin/index.ts'
import type { ViewConstraintsReport } from '../src/PgViewConstraintsPlugin/index.ts'
import {
  reportingPreset,
  ViewConstraintsReportRenderer
} from '../src/PgViewConstraintsPlugin/report.ts'

/**
 * Creates `database`, runs `setup` in it, and hands `run` a PostGraphile service over
 * it; the database is dropped afterwards, whatever `run` did.
 */
async function withLabDatabase(
  database: string,
  schema: string,
  setup: string,
  run: (service: ReturnType<typeof makePgService>) => Promise<void>
): Promise<void> {
  const host = process.env['PGHOST'] ?? '127.0.0.1'
  const port = process.env['PGPORT'] ?? '5432'
  const user = process.env['PGUSER'] ?? 'postgres'
  const adminDatabase = process.env['PGDATABASE'] ?? 'postgres'
  const adminUrl = `postgres://${user}@${host}:${port}/${adminDatabase}`
  const labUrl = `postgres://${user}@${host}:${port}/${database}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  let service: ReturnType<typeof makePgService> | undefined
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${database}`)
    const lab = new pg.Client({ connectionString: labUrl })
    await lab.connect()
    try {
      await lab.query(setup)
    } finally {
      await lab.end()
    }
    service = makePgService({ connectionString: labUrl, schemas: [schema] })
    await run(service)
  } finally {
    await service?.release?.()
    await backendsGone(admin, database)
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined)
    await admin.end()
  }
}

/**
 * `release()` returns when the pool has sent its goodbyes, not when the server has reaped
 * the backends; `DROP DATABASE … WITH (FORCE)` would then terminate them under a client
 * that logs the termination as an error. Waits (for two seconds at most) until none is left.
 */
async function backendsGone(admin: pg.Client, database: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rowCount } = await admin.query('select 1 from pg_stat_activity where datname = $1', [
      database
    ])
    if (rowCount === 0) return
    await sleep(20)
  }
}

test('a built schema withholds filter and order on an unbacked view column', async () => {
  await withLabDatabase(
    'view_constraints_hook',
    'hook_lab',
    `
      create schema hook_lab;
      create table hook_lab.target (id bigint primary key, title text not null);
      create table hook_lab.ref (
        id bigint primary key,
        target_id bigint not null references hook_lab.target(id),
        unindexed_id bigint not null references hook_lab.target(id),
        payload text not null
      );
      create index ref_target_id_idx on hook_lab.ref (target_id);
      create view hook_lab.v_hook as
        select target_id, unindexed_id, payload from hook_lab.ref;
    `,
    async (service) => {
      const { schema } = await makeSchema({
        extends: [graphileBuildPreset, graphileBuildPgPreset],
        pgServices: [service],
        plugins: [PgViewConstraintsPlugin({ indexes: true })]
      })
      const fields = (name: string): string[] => {
        const type = schema.getType(name)
        assert.ok(type, name)
        return Object.keys((type as { getFields(): Record<string, unknown> }).getFields())
      }
      const values = (name: string): string[] => {
        const type = schema.getType(name)
        assert.ok(type, name)
        const getValues = (type as { getValues?(): { name: string }[] }).getValues
        return (getValues?.call(type) ?? []).map((value) => value.name)
      }
      // The indexed view column is filterable and sortable; the columns with no index are
      // in neither input.
      assert.ok(fields('VHookCondition').includes('targetId'))
      assert.ok(!fields('VHookCondition').includes('unindexedId'))
      assert.ok(!fields('VHookCondition').includes('payload'))
      assert.ok(values('VHookOrderBy').includes('TARGET_ID_ASC'))
      assert.ok(!values('VHookOrderBy').includes('UNINDEXED_ID_ASC'))
      assert.ok(!values('VHookOrderBy').includes('PAYLOAD_ASC'))
      // The backward relation through the indexed referencing column is present; the one
      // through the unindexed column has lost its list and connection behaviors.
      const targetFields = fields('Target')
      assert.ok(targetFields.includes('vHooksByTargetId'))
      assert.ok(!targetFields.includes('vHooksByUnindexedId'))
    }
  )
})

// A relational interface names its variants by `@type … references:`, and
// `PgPolymorphismPlugin` throws while the schema is built unless the referenced relation
// has a primary key and a foreign key to the root. A variant that is a view has neither
// until `PgViewConstraintsPlugin` declares what it derives, so the reporting instance
// that `reportingPreset` swaps in has to declare too: a schema that cannot be built has
// nothing to report on. The variant's own table lies in a schema the service does not
// publish, as a door's does, so the view is the only variant the surface has. A table of
// the surface (`bonus_note`) holds a real foreign key to that table, which the plugin
// leads to the view.
const REPORTING_FIXTURE = `
  create schema preset_lab;
  create schema preset_base;
  create table preset_lab.tx (id bigint primary key, kind_code text not null);
  create table preset_base.tx__kind__bonus (
    id bigint primary key references preset_lab.tx(id),
    amount bigint not null
  );
  create view preset_lab.v_tx__kind__bonus as
    select id, amount from preset_base.tx__kind__bonus;
  create table preset_lab.bonus_note (
    id bigint primary key,
    bonus_id bigint not null references preset_base.tx__kind__bonus(id)
  );
  comment on table preset_lab.tx is E'@interface mode:relational type:kind_code\\n@type bonus references:preset_lab.v_tx__kind__bonus';
  comment on column preset_lab.v_tx__kind__bonus.amount is '@notNull';
`

/** `Type.member` of every field, input field and enum value of the schema. */
function members(schema: GraphQLSchema): Set<string> {
  const names = new Set<string>()
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__')) continue
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
      for (const name of Object.keys(type.getFields())) names.add(`${type.name}.${name}`)
    } else if (isEnumType(type)) {
      for (const value of type.getValues()) names.add(`${type.name}.${value.name}`)
    }
  }
  return names
}

/** What `left` has and `right` has not, sorted. */
function without(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((name) => !right.has(name)).sort()
}

test('reportingPreset builds the schema of a consumer with its options and reports it without counting its own tags', async () => {
  await withLabDatabase(
    'view_constraints_preset',
    'preset_lab',
    REPORTING_FIXTURE,
    async (service) => {
      const preset = {
        extends: [graphileBuildPreset, graphileBuildPgPreset],
        pgServices: [service]
      }
      const consumer = { ...preset, plugins: [PgViewConstraintsPlugin({ indexes: true })] }

      // The fixture needs the derived keys: without them the schema cannot be built.
      await assert.rejects(
        makeSchema({
          ...preset,
          plugins: [PgViewConstraintsPlugin({ indexes: true, declare: false })]
        }),
        /missing primary key/
      )

      const built = await makeSchema(consumer)
      const reports: ViewConstraintsReport[] = []
      const reporting = await makeSchema(
        reportingPreset(consumer, (report) => {
          reports.push(report)
        })
      )
      assert.equal(printSchema(reporting.schema), printSchema(built.schema))
      const root = reporting.schema.getType('Tx')
      assert.ok(isInterfaceType(root), 'the root is published as an interface')
      assert.deepEqual(
        reporting.schema.getImplementations(root).objects.map((type) => type.name),
        ['VTxKindBonus']
      )

      // The tally compares the derivation to what a human wrote: the reporting instance
      // declares what it derives, and none of that is a hand tag. The view's first.
      assert.equal(reports.length, 1)
      const [reported] = reports
      assert.ok(reported)
      const view = reported.views.find((entry) => entry.derived.view === 'v_tx__kind__bonus')
      assert.ok(view)
      assert.equal(view.derived.primaryKey?.tag, 'id')
      assert.ok(
        view.derived.foreignKeys.some((key) => key.tag === '(id) references preset_lab.tx (id)')
      )
      assert.equal(view.declaredPrimaryKey, null)
      assert.deepEqual(view.declaredForeignKeys, [])
      assert.deepEqual(view.declaredUnique, [])
      assert.deepEqual(view.declaredNotNullColumns, ['amount'])
      assert.deepEqual([...view.derived.notNullColumns].sort(), ['amount', 'id'])
      const lines = new ViewConstraintsReportRenderer().service('lab', reported)
      for (const expected of ['     nn both         amount', '     nn DERIVED-ONLY id']) {
        assert.ok(lines.includes(expected), `${expected}\n${lines.join('\n')}`)
      }
      assert.ok(lines.some((line) => line.startsWith('     pk DERIVED-ONLY ')))
      assert.ok(lines.some((line) => line.startsWith('     fk DERIVED-ONLY ')))
      assert.ok(
        lines.some((line) => line.includes('1 hand tags confirmed, 1 derived where no hand tag'))
      )

      // The same for a table of the surface: the foreign key it is led to the view by is
      // the instance's, not a hand tag.
      const note = reported.tables.find((entry) => entry.derived.table === 'bonus_note')
      assert.ok(note)
      const led = '(bonus_id) references preset_lab.v_tx__kind__bonus (id)'
      assert.deepEqual(
        note.derived.foreignKeys.map((key) => key.tag),
        [led]
      )
      assert.deepEqual(note.declaredForeignKeys, [])
      const heading = lines.findIndex((line) => line.includes('preset_lab.bonus_note  (table)'))
      assert.ok(heading >= 0, lines.join('\n'))
      assert.ok(
        lines[heading + 1]?.startsWith(`     fk DERIVED-ONLY ${led}`),
        lines.slice(heading, heading + 3).join('\n')
      )
    }
  )
})

// The reporting instance runs with its own options. A consumer that does not derive
// indexes publishes the filter and order of every view column, and the reporting build
// withholds them from a view column no index backs: the README states that difference,
// and this is its size.
test('a consumer without indexes differs from the reporting build by the unindexed view columns', async () => {
  await withLabDatabase(
    'view_constraints_options',
    'preset_lab',
    REPORTING_FIXTURE,
    async (service) => {
      const consumer = {
        extends: [graphileBuildPreset, graphileBuildPgPreset],
        pgServices: [service],
        plugins: [PgViewConstraintsPlugin()]
      }
      const built = members((await makeSchema(consumer)).schema)
      const reporting = members((await makeSchema(reportingPreset(consumer, () => {}))).schema)
      // `amount` has no index; `id` is the primary key of the table the view reads.
      assert.deepEqual(without(built, reporting), [
        'VTxKindBonusCondition.amount',
        'VTxKindBonusOrderBy.AMOUNT_ASC',
        'VTxKindBonusOrderBy.AMOUNT_DESC'
      ])
      assert.deepEqual(without(reporting, built), [])
    }
  )
})

// The other option the reporting instance does not take from the consumer. A view whose
// only key is a nullable unique column has no row lookup unless its `@unique` is derived.
test('a consumer without deriveUnique differs from the reporting build by the lookups of a derived unique', async () => {
  await withLabDatabase(
    'view_constraints_unique',
    'unique_lab',
    `
      create schema unique_lab;
      create schema unique_base;
      create table unique_base.coded (code text unique, label text not null);
      create view unique_lab.v_coded as select code, label from unique_base.coded;
    `,
    async (service) => {
      const consumer = {
        extends: [graphileBuildPreset, graphileBuildPgPreset],
        pgServices: [service],
        plugins: [PgViewConstraintsPlugin({ deriveUnique: false, indexes: true })]
      }
      const built = members((await makeSchema(consumer)).schema)
      const reporting = members((await makeSchema(reportingPreset(consumer, () => {}))).schema)
      assert.deepEqual(without(built, reporting), [])
      assert.ok(
        without(reporting, built).includes('Query.vCodedByCode'),
        without(reporting, built).join('\n')
      )
    }
  )
})
