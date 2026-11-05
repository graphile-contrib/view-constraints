// The parts meet only in a real schema build: the derivation's `indexBacked` answer,
// the codec extensions this plugin writes, `PgIndexBehaviorsPlugin`'s behavior callback
// and the backward-relation mark. That build needs a live PostgreSQL, so this file is
// run by `yarn test:lab` in the CI `lab` job (PostgreSQL 15-18) and is not part of
// `yarn test`: a job without a server would otherwise report a skipped test, which is
// not a green result.

import assert from 'node:assert/strict'
import process from 'node:process'
import { test } from 'node:test'
import pg from 'pg'
import { makeSchema } from 'postgraphile'
import { defaultPreset as graphileBuildPreset } from 'graphile-build'
import { defaultPreset as graphileBuildPgPreset } from 'graphile-build-pg'
import { makePgService } from '@dataplan/pg/adaptors/pg'
import { PgViewConstraintsPlugin } from '../src/PgViewConstraintsPlugin/index.ts'

test('a built schema withholds filter and order on an unbacked view column', async () => {
  const host = process.env['PGHOST'] ?? '127.0.0.1'
  const port = process.env['PGPORT'] ?? '5432'
  const user = process.env['PGUSER'] ?? 'postgres'
  const adminDatabase = process.env['PGDATABASE'] ?? 'postgres'
  const database = 'view_constraints_hook'
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
      await lab.query(`
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
      `)
    } finally {
      await lab.end()
    }
    service = makePgService({ connectionString: labUrl, schemas: ['hook_lab'] })
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
  } finally {
    await service?.release?.()
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined)
    await admin.end()
  }
})
