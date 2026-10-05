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

The reader keeps at most 64 keys per node and assembles a key from at most 4 relations
(`KEYS_PER_NODE`, `RELATIONS_PER_KEY` in `plan-keys.ts`). Both are caps on how much work
one plan may be asked for, not on what is true: a key beyond them is missed, never
claimed. A view whose rows are told apart only by a wider key, or by more relations
together, is left without a derived `@primaryKey` or `@unique`, and the plan proves
nothing false.

## Uniqueness

Where the plan proves a set of the view's columns no two rows share but that set is
not also never-`NULL`, the view carries a `@unique` tag rather than a `@primaryKey`.
The key is the same reading of the plan — a base relation's unique index or primary
key carried without a multiplying join, a group key, a `DISTINCT` — and a
`@unique` is what declares it where a key column may be `NULL`: `PgFakeConstraintsPlugin`
makes a `@primaryKey` column non-null and leaves a `@unique` column as it is, and
PostgreSQL's own uniqueness admits a `NULL` beside anything (a `UNIQUE` index admits
any number of `NULL`s), so declaring a nullable key is sound where declaring it
non-null would not be. A key an outer join can null is no row identity for either tag
— the padded rows carry the same `NULL`, which tells none of them apart — so the same
guard a `@primaryKey` is taken under yields neither, and the plan's own set is named
in the view's notes. A key holding a column whose plan reading was refused — one read
from a `WITH` query a plan may spell either way — yields neither either: whether that
column is never `NULL` is what the plan cannot say. Of the keys it **derives**, a view
gets the `@primaryKey` or the
`@unique` and never both: a key whose every column is never `NULL` is the `@primaryKey`
of "Row identity", and only where no such key exists does the `@unique` stand. This is
the derived pair alone. A hand-written `@primaryKey` the derivation does not match is
left where it is, and a derived `@unique` may stand beside it — a table carries a
primary key and a unique constraint at once, and the two say different things. Pass
`deriveUnique: false` to `PgViewConstraintsPlugin` to leave `@unique` underived, for
instance to keep the generated schema's row-lookup fields to the primary keys alone.

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
`GROUPING SETS` row puts a `NULL` in. A materialized view is read by the same rule: its
stored copy of an entry that was never `NULL` holds no `NULL` either, so the column its
key is taken from carries `@notNull` beside the key rather than the key alone. A
qualifier counts only where it holds of
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
Whether a spelling is shadowed is a question about the **whole database**, not about
one view. The plan prints a name, not an oid, so a user object can take a built-in's
spelling and be printed exactly like it; and a view can reach such an object without
naming it — a user function PostgreSQL inlines carries its own body's objects into the
view's plan, while the view's rewrite rule records the function alone (`pg_depend`
records the objects a view names directly; an inlined function's body leaves no such
row). So the plugin asks the catalog which non-built-in functions, operators and types
the database holds under a spelling the rules lean on, and any object under such a
spelling stands its rule down. A user `count`, `+` or type `integer` anywhere in the
database stands the rule down for every view — an under-count on purpose, so that no
view is left trusting the built-in's name for someone else's object. The resolution is
at the object, not the individual call: the plan prints a name, and a name a user
object has taken stands the rule down wherever it is printed. Where the deparser had
to qualify a call because a same-named function shadows the built-in in the search
path, it prints the built-in as `pg_catalog.count(…)`; that qualified spelling **is**
the built-in — the object is named, not spelled — so its rule holds there whatever
user objects exist, while a call under any other schema is that schema's function and
claims nothing.
An entry that does not parse is `unknown` too — the reader never
guesses. The same answer holds across a union's branches (a column is never `NULL`
only where every branch proves it), across a crossed view boundary, and below an
outer join: a computed column of a nulled side is `NULL` in every padded row,
whatever the expression promises about the rows it computed over.

A set operation's branches are read wherever the operation stands: at the select
list, under a node that computes over it — a `GROUP BY`, a `DISTINCT`, an
`ORDER BY` — or at the select list of a view the reader crosses. The node above prints
the Vars of one branch, and each column is that branch's entry at the same position;
a column of the result is therefore never `NULL` only where the entry at that position
of **every** branch is not (a `UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT` alike,
each branch printing its own select list in the operation's column order). Where the
branches cannot be told apart — a set operation standing over another, so the same
spelling names a column of both — no column is read and the view says
`set-operation-not-a-select-list`. `INTERSECT` and `EXCEPT` are read where the plan
prints their branches directly; a PostgreSQL major that wraps the operation in a
subquery the reader leaves unread leaves them refused whole, an under-count taken on
purpose rather than a claim on a branch the plan does not name.

A `WITH` query referenced twice is materialized, and the plan prints its columns by the
query's own names in the `CTE Scan` that reads them while the subplan computes the
query's select list in order — with no map between the two in the plan. That map, and
where each of the view's own columns was written from, is in the view's stored rewrite
tree (`pg_rewrite.ev_action`), read field by field and not parsed as SQL: the tree names
every `WITH` query's columns in order (`:ctename`, `:ctecolnames`), so a `cte.col` is
read at that column's position in the subplan the plan computes it by. Where the view's
own query reads a column from a `WITH` query it **inlines** that is not simple — one that
groups, aggregates, de-duplicates, limits or windows, or that reads one of those — the
column is refused its non-nullness and its key: pulling such a query up into the query above
means merging that work into it, which PostgreSQL does only where it chooses to, and the plan
then prints the column flattened (where it resolves to a base column) or behind a subquery of
the kept query, which this reader does not pin. The relation is not refused with it: that
comes from the tree (`resorigtbl`), which no plan writes, so a `@foreignKey` on such a column
stands. A simple inlined query — a bare projection — is pulled up wherever it stands, and its
columns are read as usual. Which fields say a query is not simple is listed in
`view-tree.ts`, and the list is one the reader has been checked against on PostgreSQL 15
through 18: a field the dump no longer carries is read as the work being done. The stored tree
is read only on a PostgreSQL major whose format this reader has been checked against
(15 through 18): on any other major it is left unread — the plan's own refusals stand
where its facts would have, and each view's notes say why — so a format that moved
between majors is a missed derivation and never a guessed one. The name is not
the plan's to trust: the same `WITH` name can stand in another query the view goes
through — the same name at two query levels, a view outside the surface, or a SQL
function the view inlines — and the plan prints one `CTE <name>` subplan whose owner
nothing names. Nor is the alias the scan carries, which the view and another query can
share. What places the scan is PostgreSQL's own rule, read from the view's tree: a plan
carries a `CTE <name>` subplan and a `CTE Scan` only for a `WITH` query PostgreSQL
**materializes**, and the tree says whether this view's query of that name is one of those
(`:ctematerialized`, `:cterefcount`, `:cterecursive`: `MATERIALIZED`, a recursive query,
and a default one referenced more than once materialize; `NOT MATERIALIZED`, and a default
one referenced once, are inlined). Where the view's own query is inlined it contributes no
subplan, so any scan of that name is another query's and is refused however its origins
line up. Where it materializes it contributes exactly one subplan, so the plan must carry
exactly one — a second is another query's query of the same name, and the plan does not
say which a scan reads — the plan must name no more scans of the name than the view's own
query references it, and that one subplan must match the query's columns' origins,
position for position (the base column a column is a `Var` of, or an expression). Any of
these unproved refuses every column read through the scan. A query the tree reads as
inlined but a volatile body materializes falls on the refusing side, so a wrong reading of
the rule is a missed derivation and never a wrong tag. Where the plan could
not read a column at all — a scan a constant qualifier removed, a `WITH` query whose tree
is out of reach — the tree's own record of the base column the view column was written
from (`:resorigtbl`, `:resorigcol`) is taken as a fallback source for a relation, and for
nothing else: it says nothing of a column's nullness, and a column the plan did read is
judged by the plan. Where both name a base column for the same view column and they are
not the same, the column is refused (`plan-and-tree-disagree`) rather than either
trusted; the tree names a view where the column came through one, and is left out of the
comparison then, since that boundary is exactly the step the plan crosses and the tree
does not. The tree is the current definition — `CREATE OR REPLACE VIEW` rewrites
`pg_rewrite.ev_action`, so it is read afresh on every schema build and never from a stale
copy — and where it disagrees with the plan the column is refused whole: no non-nullness,
no key and no relation, since nothing says which of the two is the outdated one. The tree
also names every range-table alias of the view's relations (`:alias`,
`:relid`), so a source view the query referred to by an explicit alias
(`FROM deposit.v bank_range`) is a boundary the reader crosses too — PostgreSQL spells
such a subquery's node with the alias, not the view's name, and the tree is what turns
the alias back into the view.

The tree is read **closed by default**: the walk fails the whole tree on a character it
cannot place, on an unbalanced bracket, and on a node it reads that is missing a field
it needs (the fields per node type are one list in `view-tree.ts`, and a field renamed
or removed there is the failure this catches). A failed tree yields nothing rather than
a partial answer — the view's `WITH` queries are then not crossed, no origin is taken
from it, and a note names the reason instead of leaving an empty map to look like a view
with no `WITH` at all. Its format is PostgreSQL-internal and carries no cross-version
promise, so the lab is read against every supported major in CI (the `lab` job builds the
fixture from a real database of each), and a field the reader needs that a major no
longer prints fails that run.

Beyond the expression shapes above, the plan reader itself knows a closed set of node
forms and refuses the rest rather than guess. It reads: relation scans; blocks of
`Inner` joins and the `Left`/`Right`/`Full`/`Semi`/`Anti` joins; `Aggregate` and `Group`
(each row a non-empty group); `Unique`; `Append`, `Merge Append`, `SetOp` and `HashSetOp`
(the set operations, branch by branch); `Subquery Scan` (a view boundary the catalog
pins, including one spelled with an explicit alias); `CTE Scan`; `Result`; `WindowAgg`;
and the pass-through nodes (`Gather`, `Gather Merge`, `Sort`, `Incremental Sort`,
`Limit`, `Materialize`, `Memoize`, `LockRows`) that hand their child's select list on. A
`Recursive Union`, a join type it does not know, a function scan, a `VALUES` list, a
window frame — anything else — is a named refusal on the columns that reach it, never a
guess.

## Plan invariance

The answer must not depend on the plan the planner happened to choose.
`proveInvariance(targets, ownerConnectionString, open, write)` derives every view
of every target under each of `PLANNER_REGIMES`, with the statistics as found, after
`ANALYZE` and with production-scale row counts, and reports each rendering that
differs. `open` opens a session with your driver. The lab's own matrix carries the
same two axes — its regimes, read again from production-scale row counts — since the
statistics are the planner's other input and a shape can move with them alone.

This proof is the plugin's own gate on its shape of reading, and a consumer should run
it in its own CI: the plans it derives from are the ones that consumer's database
produces, and a surface whose contract moved with them would publish one schema against
an empty database and another against production. A consumer wires its services into
`InvarianceTarget`s and a driver into `open`, and fails the build on a difference.

`reportingPreset(preset, onReport)` and `ViewConstraintsReportRenderer` print what
is derived beside what the views declare by hand. The report also names the built-in
spellings a user object has taken over in the database, whose rules stand down for
every view, so a surface that derives less than expected can be read against that list
rather than mistaken for one with nothing to derive.
