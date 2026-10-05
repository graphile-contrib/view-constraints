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

A column the select list spells as an expression has no base column to ask, and
what it has instead is the expression's own shape. The `Output` entry the origins
are read from is parsed and evaluated bottom-up, and a shape whose SQL definition
is the claim proves the column never `NULL`:

| Expression                                                                       | Never `NULL` when                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a literal (a string, a number, `true`, `false`), cast or not                     | always: the planner folds a cast of a constant, so the constant is its value                                                                                                                                                                                                                                                                                                                                                   |
| `NULL`, `NULL::type`                                                             | never                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `count(…)`, with `DISTINCT` or a `FILTER` alike                                  | always: `count` answers `0` over no rows                                                                                                                                                                                                                                                                                                                                                                                       |
| `COALESCE(a, b, …)`, `GREATEST`, `LEAST`                                         | one argument never `NULL`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CASE` with an `ELSE`                                                            | every `THEN` arm and the `ELSE` never `NULL`                                                                                                                                                                                                                                                                                                                                                                                   |
| `CASE` without an `ELSE`                                                         | never                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `min`/`max`/`sum`/`avg`, no `FILTER`                                             | the argument never `NULL` and the node groups (`Group Key`): a grouping's every row stands for a non-empty group; over the whole input an empty input answers `NULL`                                                                                                                                                                                                                                                           |
| `x IS [NOT] NULL`, `IS [NOT] TRUE`/`FALSE`/`UNKNOWN`, `IS [NOT] DISTINCT FROM y` | always: SQL defines each as a boolean, whatever the operands come out as                                                                                                                                                                                                                                                                                                                                                       |
| `a + b`, `a \|\| b`, the other whitelisted operators                             | every operand never `NULL` — the built-ins answer a value or an error, never `NULL`; a user-defined operator that takes a whitelisted spelling stands the rule down, as a non-strict `=` stands the qualifier down                                                                                                                                                                                                             |
| `expr::type`                                                                     | `expr` never `NULL` and the cast cannot turn a non-`NULL` value into `NULL`: it is binary-coercible (`pg_cast.castmethod = 'b'` — a type modifier then truncates but does not null), or one of the few widening integer-to-integer and integer-to-`numeric` casts PostgreSQL sends through a function; any other cast — `jsonb` to `integer`, a user `CREATE CAST`, a second cast — may answer `NULL` and stands the rule down |
| anything else — a function by name, a window function, a subscript, a subplan    | never claimed: `unknown`, and the column stays nullable                                                                                                                                                                                                                                                                                                                                                                        |

No expression is computed and no function's strictness is trusted: strictness says
`NULL` in, `NULL` out and nothing about non-`NULL` in (`lower()` over an empty range
is `NULL` from a non-`NULL` argument), which is why a function's name gives no
answer at all. A cast is another such shape: the plan names the type it casts to and
nothing about the operand's type, and a cast is free to answer `NULL` for a non-`NULL`
input, so a cast stands the rule down unless both ends are one family PostgreSQL
defines to answer a value for every input of the other — the exact numbers, the text
types. `jsonb` to `integer` and a user `CREATE CAST` are not, and may answer `NULL`,
and neither is a cast to a type a user has named after one of those, whose name is
then no promise at all.
An entry that does not parse is `unknown` too — the reader never
guesses. The same answer holds across a union's branches (a column is never `NULL`
only where every branch proves it), across a crossed view boundary, and below an
outer join: a computed column of a nulled side is `NULL` in every padded row,
whatever the expression promises about the rows it computed over.

## Plan invariance

The answer must not depend on the plan the planner happened to choose.
`proveInvariance(targets, ownerConnectionString, open, write)` derives every view
of every target under each of `PLANNER_REGIMES`, with the statistics as found, after
`ANALYZE` and with production-scale row counts, and reports each rendering that
differs. `open` opens a session with your driver.

`reportingPreset(preset, onReport)` and `ViewConstraintsReportRenderer` print what
is derived beside what the views declare by hand.
