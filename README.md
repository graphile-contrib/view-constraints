# @graphile-contrib/view-constraints

An opt-in PostGraphile v5 plugin that derives a view's foreign keys, primary
key, and non-null columns from PostgreSQL's query plan and system catalogs.

## Install

```sh
npm install @graphile-contrib/view-constraints
```

## Use

```ts
import { PgViewConstraintsPlugin } from '@graphile-contrib/view-constraints'

export default {
  plugins: [PgViewConstraintsPlugin()]
}
```

The plugin runs before `PgFakeConstraintsPlugin`, which turns the derived tags
into relations in the generated schema.

Pass `declare: false` only to inspect a `report` without changing the schema.

## Row identity

A view's `@primaryKey` is a set of its columns that no two rows share and that is
never `NULL` (`PgFakeConstraintsPlugin` makes every key column non-null). Keys are
worked out bottom-up over the plan:

| Node                                                          | Its unique column sets                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a relation scan                                               | its primary key and unique indexes (`pg_index`; not partial, expression or deferrable ones)                                                                     |
| a block of inner joins                                        | a key of each of the fewest row sources whose rows determine every other source's through the `column = column` / `column = literal` equalities the plan prints |
| a `Left` / `Right` join                                       | the preserved side's keys where it determines the other side                                                                                                    |
| a `Semi` / `Anti` join                                        | the keys of the side it emits                                                                                                                                   |
| `Aggregate` / `Group` with a `Group Key` of columns, `Unique` | the group key or every column, and the input's keys it contains                                                                                                 |
| a `UNION ALL`                                                 | a key of every branch plus a column each branch fills with its own non-`NULL` text literal                                                                      |
| anything else                                                 | none                                                                                                                                                            |

Below a join, what a grouping, a de-duplication, a `LIMIT` or a window makes unique
is only used to show the join does not multiply rows: whether the planner keeps a
`Subquery Scan` over such a subquery depends on the join method. A key is never
read across a cast. Only a key that is one base relation's own can be the target
of a relation to a projection.

## Non-nullness

A column is `@notNull` when it proxies a base column that is never `NULL` where it
is read — `attnotnull`, or a qualifier of the plan rejects the `NULL`: a conjunct
`column IS NOT NULL`, or `column = …` through a strict operator (read only while
every `=` in the database is strict) — and no outer join, `NULL` union branch or
`GROUPING SETS` row puts a `NULL` in. A qualifier counts only where it holds of
every row the column arrives in: not an outer or anti join's own condition, not a
disjunction's arm, not a subplan. The predicate of a partial index a scan names is
read as a qualifier of that scan, since the scan drops what the predicate implies
from its `Filter`.

## Plan invariance

The answer must not depend on the plan the planner happened to choose.
`proveInvariance(targets, ownerConnectionString, open, write)` derives every view
of every target under each of `PLANNER_REGIMES`, with the statistics as found, after
`ANALYZE` and with production-scale row counts, and reports each rendering that
differs. `open` opens a session with your driver.

`reportingPreset(preset, onReport)` and `ViewConstraintsReportRenderer` print what
is derived beside what the views declare by hand.
