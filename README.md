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

## A relation to a projection

Where a published view is a row of a base relation — its `@primaryKey` is that
relation's own unique key, carried — a relation to that key is led to the view too,
beside the relation to the table. The referencing half is either a relation derived
for a view, or a real `convalidated` foreign key of a table of the same surface (a
table in one of the service's schemas some column of which the role may read). The
relation is nullable.

Exactly one view of the surface may be a row of the key: with several, nothing is
led and the view or table names the refusal `more-than-one-projection-carries-the-key`
and the candidates. A view published as an `@enum`, and one whose hand-written
`@primaryKey` names other columns, is no candidate. A view is not led to its own row
over the very columns it carries. A table's foreign key itself is left to
`PgRelationsPlugin`; only the relation to the projection is declared, and not where
the table already states the same reference by hand.

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
