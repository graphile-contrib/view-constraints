-- The schema behind fixture.json.
--
-- One relation per case the reader of a plan has to get right, positive and
-- negative alike. The fixture is PostgreSQL's answer for this schema, not a
-- transcription of it: apply this file to an empty database and read the plans back
-- through the plugin's own catalog queries (readCatalogRelations, readTypeCoercions,
-- explainStatement), keeping the plan fields plan-origins.ts and plan-keys.ts read.

create schema lab;
set search_path = lab;

create table currency (code text primary key, title text not null);
create table bank (id bigint primary key, title text not null);
create table wallet (id bigint primary key, cur_code text not null references currency(code));

create table tx (
  id bigint primary key,
  cur_code text not null references currency(code),
  bank_id bigint references bank(id),
  amount numeric not null
);
create table tx2 (
  id bigint primary key,
  cur_code varchar(8) not null references currency(code)
);
create domain cur_code_dom as text;
create table tx3 (
  id bigint primary key,
  cur_code cur_code_dom not null references currency(code)
);
create table refund (id bigint primary key, cur_code text not null references currency(code));

-- unique index as the only key a view can carry
create table asset (id bigint primary key, code text not null, label text);
create unique index asset_code_key on asset (code) include (id);

-- nullable unique: a key that identifies nothing where it is null
create table slot (id bigint primary key, tag text);
create unique index slot_tag_key on slot (tag);

-- POSITIVE
create view v_bare as select id, cur_code from tx;
create view v_left_join as
  select t.id, b.id as bank_id, t.cur_code from tx t left join bank b on b.id = t.bank_id;
create view v_group as select cur_code, count(*) as n from tx group by cur_code;
create view v_window as
  select id, cur_code, row_number() over (partition by cur_code order by id) as rn from tx;
create view v_distinct_src as select distinct id, cur_code from tx;
create view v_over_view as select id, cur_code from v_distinct_src;
create view v_cast_varchar_to_text as select id, cur_code::text as cur_code from tx2;
create view v_cast_domain_to_base as select id, cur_code::text as cur_code from tx3;
create view v_union_same_column as
  select id, cur_code from tx where amount > 0
  union all
  select id, cur_code from tx where amount < 0;
create view v_union_same_target as
  select id, cur_code from tx union all select id, cur_code from wallet;
create view v_union_null_branch as
  select id, bank_id from tx union all select id, NULL::bigint from refund;
create view v_cte as
  with live as (select t.id, t.cur_code, t.amount from tx t)
  select live.id, live.cur_code, max(paired.amount) as top_amount
  from live join live paired on paired.cur_code = live.cur_code
  group by live.id, live.cur_code;
-- POSITIVE: a computed column of a materialized WITH query is read at the entry the
-- subplan prints — here a `count` inside the query, never NULL.
create view v_cte_aggregate as
  with totals as materialized (select cur_code, count(*) as n from tx group by cur_code)
  select cur_code, n from totals;
create view v_unique_key as select code from asset;
create materialized view m_tx as select id, cur_code, amount from tx;

create view v_union_unreadable_branch as
  select id, cur_code from tx union all select id, upper(cur_code) from wallet;

-- POSITIVE, non-nullness: the planner folds the outer join into an inner one because
-- the qualifier is strict, so a column nullable by the view's text is not nullable
-- in fact — and the plan is the only place that shows it.
create view v_collapsed_left_join as
  select t.id, b.title from tx t left join bank b on b.id = t.bank_id where b.title > '';

-- NEGATIVE, non-nullness: which side an outer join nulls, one view per kind. The
-- preserved side of each is the positive half of the same case.
create view v_right_join as
  select t.id as t_id, b.title from tx t right join bank b on b.id = t.bank_id;
create view v_full_join as
  select t.id as t_id, b.title from tx t full join bank b on b.id = t.bank_id;
create view v_nested_outer_join as
  select r.id, paired.title
  from refund r
  left join (select b.id, b.title from bank b join currency c on c.code = b.title) paired
    on paired.id = r.id;
create view v_union_null_over_not_null as
  select id, cur_code from tx union all select id, NULL::text from refund;
create view v_grouping_sets as select id, count(*) as n from tx group by rollup (id);
create view v_not_null_predicate as select id, bank_id from tx where bank_id is not null;
create view v_cte_nulled_scan as
  with live as (select t.cur_code from tx t)
  select r.id, a.cur_code as a_code, b.cur_code as b_code
  from refund r
  left join live a on a.cur_code = r.id::text
  join live b on b.cur_code = 'x';
create view v_cte_reordered_scans as
  with live as (select t.id, t.cur_code from tx t)
  select r.id, a.cur_code, b.cur_code as b_cur_code
  from refund r
  left join live a on a.id = r.id
  left join live b on b.id = r.id + 1;

-- NEGATIVE
create view v_coalesce as
  select t.id, coalesce(t.cur_code, w.cur_code) as cur_code
  from tx t left join wallet w on w.id = t.id;
create view v_constant as select id, 'usdt'::text as cur_code from tx;
create view v_cast_truncating as select id, cur_code::varchar(4) as cur_code from tx;
create view v_cast_function as select id, bank_id::numeric as bank_id from tx;
create view v_distinct_over_union as
  select distinct * from (select id, cur_code from tx union all select id, cur_code from wallet) s;
create view v_self_join as
  select a.id as a_id, b.cur_code as b_cur_code from tx a join tx b on b.id = a.id + 1;
create view v_nullable_unique as select tag from slot;

-- The union is what the plan is built on; whether it is also the root of the plan is
-- the planner's judgement of cost. An `ORDER BY` puts a `Sort` or a `MergeAppend`
-- over it, a `LIMIT` puts a `Limit` over it, and parallelism puts a `Gather` over a
-- parallel `Append`. All three read the same, because the union under them is the
-- same union.
create view v_union_ordered as
  select id, cur_code from tx union all select id, cur_code from wallet order by 1;
create view v_union_limited as
  select id, cur_code
  from (select id, cur_code from tx union all select id, cur_code from wallet) s
  limit 10;

-- De-duplication over a union is refused whichever way the planner implements it.
-- `Unique` over a `Sort` and a hashed `Aggregate` grouping by every column are the
-- same query costed two ways, and the `Aggregate` computes, so neither is stepped
-- over. `v_distinct_over_union` above is the `SELECT DISTINCT` spelling of it; this
-- is the `UNION` one, which PostgreSQL plans the same way.
create view v_union_distinct as
  select id, cur_code from tx union select id, cur_code from wallet;

-- ── Views built on views ───────────────────────────────────────────────────────
--
-- PostgreSQL flattens a view into the query above it wherever it may, and then the
-- plan names the base relations directly. Two things stop it. A security-barrier
-- view is never pulled up — its qualifiers have to stay below whatever the query
-- above adds — and a `Subquery Scan` that projects a narrower list than its child's
-- is not the trivial one `setrefs.c` removes. So a barrier view asked for whole
-- dissolves all the same, and a barrier view asked for a subset leaves a node
-- spelled with its own column names and nothing else.
--
-- Every published projection of this repository is a barrier view, so this is the
-- shape the surfaces are actually made of.

create view v_barrier with (security_barrier = true) as
  select id, cur_code, bank_id, amount from tx;
-- Asked for its whole select list, the barrier is a trivial `Subquery Scan` and
-- `setrefs.c` removes it: the plan is the plan of `tx`.
create view v_barrier_whole as select id, cur_code, bank_id, amount from v_barrier;
-- Asked for a subset, it stays, and the descent has a boundary to cross.
create view v_over_barrier as select id, cur_code from v_barrier;
-- A barrier over a barrier, narrowing at each level: two boundaries in one plan.
create view v_barrier_over_barrier with (security_barrier = true) as
  select id, cur_code, bank_id from v_barrier;
create view v_barrier_chain as select id, cur_code from v_barrier_over_barrier;
-- A barrier over a plain view: the plain one is flattened into the barrier, and the
-- barrier is asked for its whole list, so nothing is left of either.
create view v_barrier_over_plain with (security_barrier = true) as
  select id, cur_code from v_bare;
-- A plain view over a barrier is the ordinary surface shape.
create view v_plain_over_barrier as select id, bank_id from v_barrier;
-- A union inside a barrier view, read branch by branch through the boundary.
create view v_barrier_union with (security_barrier = true) as
  select id, cur_code, amount from tx union all select id, cur_code, 0::numeric from wallet;
create view v_over_barrier_union as select id, cur_code from v_barrier_union;

-- NEGATIVE, across a boundary: what the inner view computes stays computed.
create view v_barrier_computed with (security_barrier = true) as
  select id, cur_code, upper(cur_code) as loud, amount from tx;
create view v_over_barrier_computed as select id, loud from v_barrier_computed;

-- NEGATIVE, across a boundary: the inner view narrows the value and the outer casts
-- it back to the base type. Read one step at a time each cast is binary-coercible;
-- read end to end the value is not the base column's any more.
create view v_barrier_narrowing with (security_barrier = true) as
  select id, cur_code::varchar(4) as cur_code, amount from tx;
create view v_over_barrier_narrowing as
  select id, cur_code::text as cur_code from v_barrier_narrowing;

-- NEGATIVE: an alias over a barrier view. The plan prints the alias and nothing else
-- — no schema, no relation name — so the name is all there is to pin the node to a
-- view with, and `t` is not the name of any view this one is built on.
create view v_aliased_barrier as select t.id, t.cur_code from v_barrier t;

-- NEGATIVE: a column that is a NULL literal all the way up contributes no value.
create view v_null_column as select id, NULL::text as cur_code from tx;

-- POSITIVE: a set operation's branches are read one by one wherever it stands. An
-- `EXCEPT`/`INTERSECT` prints its branches directly; a `UNION` under a grouping prints
-- the union's columns inside the aggregate, and a column of the result is the value at
-- that position of whichever branch a row came from.
create view v_except as
  select id, cur_code from tx except select id, cur_code from wallet;
create view v_intersect as
  select id, cur_code from tx intersect select id, cur_code from wallet;

-- POSITIVE: a grouping over a `UNION ALL` — the shape the ledger totals are built
-- from. The group key proxies both branches, and the aggregates read the union's
-- columns.
create view v_union_grouped as
  select sid, cur_code, sum(amount) as total, count(*) as n
  from (
    select t.id as sid, t.cur_code, t.amount from tx t
    union all
    select r.id, r.cur_code, 0::numeric from refund r
  ) u
  group by sid, cur_code;

-- NEGATIVE: a set operation over another cannot tell its branches apart — the same
-- spelling names a column of both — so no column of it is read.
create view v_union_nested as
  select id, cur_code from tx
  union all
  select id, cur_code
  from (select id, cur_code from tx union select id, cur_code from wallet) w;

-- NEGATIVE: a recursive WITH reads its own output as one tagged stream, so a column
-- has no branch to be read off.
create view v_recursive as
  with recursive walk as (
    select t.id, t.bank_id from tx t where t.bank_id is null
    union all
    select t.id, t.bank_id from tx t join walk w on w.id = t.bank_id
  )
  select id, bank_id from walk;

-- NEGATIVE: a row source the catalog has nothing to say about. A function scan
-- carries an alias like any other scan and names no relation.
create view v_function_scan as
  select t.id, u.val from tx t cross join lateral unnest(array [t.bank_id]) as u(val);

-- A union inside a barrier view that PostgreSQL cannot pull up into the query above
-- — an `ORDER BY` of its own is enough — keeps both the boundary and the union, so
-- the branches are read one by one on the far side of a `Subquery Scan`.
create view v_barrier_union_ordered with (security_barrier = true) as
  select id, cur_code, amount from tx
  union all
  select id, cur_code, 0::numeric from wallet
  order by 1;
create view v_over_barrier_union_ordered as
  select id, cur_code from v_barrier_union_ordered;

-- NEGATIVE: a `VALUES` list is a row source with an alias and no relation behind it.
-- Two rows, because PostgreSQL folds a one-row `VALUES` into constants and the case
-- would then be the constant one instead.
create view v_values_scan as
  select v.a, v.b from (values (1, 'usdt'), (2, 'btc')) as v(a, b);

-- NEGATIVE: a constant-false qualifier leaves a plan with no scan in it at all, while
-- the select list still spells the relation that is not read.
create view v_where_false as select id, cur_code from tx where 1 = 0;

-- ── A relation from one view to another ───────────────────────────────────────
--
-- A relation is led to a projection instead of only to a table when two catalog
-- facts stand under it: a real foreign key on the base column the referencing view
-- proxies, and a projection whose derived row identity is the very key that foreign
-- key points at. Row identity, not the proxy alone — a view that repeats the key
-- is not keyed by it.
--
-- These relations need their own tables. Every view above is a projection of `tx`,
-- so `tx`'s own key is the row identity of a dozen of them at once, which is the
-- ambiguous case and never the unambiguous one.

create table merchant (id bigint primary key, title text not null);
create table invoice (id bigint primary key, merchant_id bigint not null references merchant(id));
-- POSITIVE: exactly one projection of `merchant` is a row of it, so `v_invoice`'s
-- `merchant_id` is led to `v_merchant` as well as to `merchant`.
create view v_merchant with (security_barrier = true) as select id, title from merchant;
create view v_invoice as select id, merchant_id from invoice;

-- POSITIVE, through a unique index that is not the primary key: `entry` references
-- `ledger(code)`, and the projection keyed by `code` is the one the relation is led
-- to. The projection keyed by `ledger`'s primary key is not a candidate for it —
-- it is a row of the same table by a key the relation does not point at.
create table ledger (id bigint primary key, code text not null);
create unique index ledger_code_key on ledger (code);
create table entry (id bigint primary key, ledger_code text not null references ledger(code));
create view v_ledger_by_code as select code from ledger;
create view v_ledger_by_id as select id from ledger;
create view v_entry as select id, ledger_code from entry;

-- NEGATIVE: two projections of `carrier` are rows of it by the same key, and
-- nothing in the catalog says which of them a relation to `carrier(id)` was meant
-- for. The relation to the table stands; the one to a projection is declined by
-- name.
create table carrier (id bigint primary key, title text not null);
create table parcel (id bigint primary key, carrier_id bigint not null references carrier(id));
create view v_carrier_titled as select id, title from carrier;
create view v_carrier_bare as select id from carrier;
create view v_parcel as select id, carrier_id from parcel;

-- NEGATIVE: a projection that carries the key and is not keyed by it. The join
-- repeats every `depot` row once per `crate`, so `depot.id` is not unique in the
-- view and the view has no derived row identity — a relation pointing at it would
-- point at several rows.
create table depot (id bigint primary key, title text not null);
create table crate (id bigint primary key, depot_id bigint not null references depot(id));
create view v_depot_joined as
  select d.id, c.id as crate_id from depot d join crate c on c.depot_id = d.id;
create view v_crate as select id, depot_id from crate;

-- POSITIVE, a self-referencing table: `node.parent_id` points at `node(id)`, so the
-- only projection the relation can be led to is the projection asking for it. Two
-- relations point at that key and they are not the same statement — `(id)` is the
-- row's identity with its own row, which `@primaryKey` already says, while
-- `(parent_id)` reaches the parent, about which it says nothing.
create table node (id bigint primary key, parent_id bigint references node(id));
create view v_node as select id, parent_id from node;

-- POSITIVE, a composite key the projection spells in another order and under other
-- names, referenced by a foreign key that spells it in a third order. The key is
-- matched as a set, and each column is carried to the view column that proxies it,
-- so neither the order nor the names have to line up anywhere.
create table crew (ship_code text, seat int, name text not null, primary key (ship_code, seat));
create table shift (
  id bigint primary key,
  seat int not null,
  ship_code text not null,
  foreign key (seat, ship_code) references crew (seat, ship_code)
);
create view v_crew as select seat as berth, ship_code as vessel, name from crew;
create view v_shift as select id, seat, ship_code from shift;

-- Every table above is a referencing half as well: its own foreign key is the very
-- `pg_constraint` row a view's relation is derived down to, so `invoice.merchant_id`
-- is led to `v_merchant` exactly as `v_invoice.merchant_id` is, `parcel.carrier_id`
-- is declined between the two projections of `carrier`, and `crate.depot_id` is led
-- nowhere, `v_depot_joined` repeating `depot`'s key rather than being keyed by it.
--
-- NEGATIVE, a foreign key added NOT VALID: it promises nothing about the rows already
-- in the table, so it is no referencing half, though `v_merchant` is the one
-- projection of the key it names.
create table consignment (id bigint primary key, merchant_id bigint not null);
alter table consignment
  add constraint consignment_merchant_id_fkey foreign key (merchant_id) references merchant (id)
  not valid;

-- ── Row identity ───────────────────────────────────────────────────────────────
--
-- A key is carried up the plan the way a value is, and every node answers which of
-- its output column sets are unique from what its inputs answered. These tables are
-- the lab's own so that the projections keyed here are rows of no key the relation
-- cases above point at.

create table region (code text primary key, title text not null);
create table store (
  id bigint primary key,
  code text not null,
  region_code text not null references region(code)
);
create unique index store_code_key on store (code);
create table sale (
  id bigint primary key,
  store_id bigint not null references store(id),
  region_code text not null,
  amount numeric not null
);
create table berth (dock text, slot int, title text not null, primary key (dock, slot));
create table mooring (id bigint primary key, dock text not null, slot int not null);

-- POSITIVE: a many-to-one join multiplies no row of the side it keeps.
create view v_sale_store as
  select s.id, st.code as store_code from sale s join store st on st.id = s.store_id;
-- POSITIVE: and a chain of them, through a relation the view does not show.
create view v_sale_region as
  select s.id, r.title from sale s
  join store st on st.id = s.store_id
  join region r on r.code = st.region_code;
-- POSITIVE: the kept side is the preserved one, however the view spells the join.
create view v_sale_right_store as
  select s.id, st.code from store st right join sale s on st.id = s.store_id;
-- POSITIVE: a nullable unique index is a key of the other side all the same, because
-- the equality admits no NULL.
create view v_sale_slot as
  select s.id, sl.id as slot_id from sale s join slot sl on sl.tag = s.region_code;
-- POSITIVE: a composite key of the other side, every column of it equated.
create view v_mooring_berth as
  select m.id, b.title from mooring m join berth b on b.dock = m.dock and b.slot = m.slot;
-- POSITIVE: one column of it equated to a literal is equated all the same.
create view v_mooring_first_slot as
  select m.id, b.title from mooring m join berth b on b.dock = m.dock and b.slot = 1;
-- POSITIVE: a semi join emits each row of its outer side once, and an anti join too.
create view v_sale_in_live_region as
  select s.id from sale s where exists (select 1 from store st where st.region_code = s.region_code);
create view v_sale_outside_regions as
  select s.id from sale s where not exists (select 1 from store st where st.region_code = s.region_code);
-- POSITIVE: two relations neither of which is unique given the other: the pair of
-- their keys is a key, and a key made of two relations names no row of either.
create view v_sale_pairs as
  select s.id, other.id as other_id from sale s join sale other on other.store_id = s.store_id;
-- POSITIVE, across a boundary: a barrier view over a many-to-one join, narrowed.
create view v_barrier_sale with (security_barrier = true) as
  select s.id, s.amount, st.code from sale s join store st on st.id = s.store_id;
create view v_over_barrier_sale as select id, code from v_barrier_sale;

-- NEGATIVE: a join on part of the other side's key multiplies.
create view v_mooring_dock as
  select m.id, b.title from mooring m join berth b on b.dock = m.dock;
-- NEGATIVE: the same, the other way round: the key of the repeated side is not shown.
create view v_sale_repeated as
  select s.id from sale s join sale other on other.store_id = s.store_id;
-- NEGATIVE: a cast equates the value to something else.
create view v_sale_cast_join as
  select s.id from sale s join store st on st.id::text = s.region_code;
-- NEGATIVE: a disjunction equates nothing about any one row.
create view v_sale_or_join as
  select s.id from sale s join store st on st.id = s.store_id or st.id = 0;

-- POSITIVE: a group key is a key.
create view v_group_store as
  select s.store_id, st.code, sum(s.amount) as amount
  from sale s join store st on st.id = s.store_id
  group by s.store_id, st.code;
-- POSITIVE: so is what `DISTINCT` de-duplicates, whichever way it is planned.
create view v_distinct_code as select distinct cur_code from tx;
-- NEGATIVE: a group key over a column that can be NULL is no row identity.
create view v_group_nullable as
  select cur_code, bank_id, count(*) as n from tx group by cur_code, bank_id;
create view v_distinct_nullable as select distinct bank_id from tx;
-- NEGATIVE: a group key over an expression is a key of nothing the view can name.
create view v_group_expression as
  select upper(cur_code) as loud, count(*) as n from tx group by upper(cur_code);

-- POSITIVE: a union whose branches each write their own text literal into one column
-- keeps the branches apart, so a key of each branch with that column is a key.
create view v_union_discriminated as
  select 'tx'::text as source, id, cur_code from tx
  union all
  select 'wallet'::text, id, cur_code from wallet;
-- POSITIVE: a branch keyed through a many-to-one join is keyed all the same.
create view v_union_discriminated_joined as
  select 'sale'::text as source, s.id, st.code from sale s join store st on st.id = s.store_id
  union all
  select 'tx'::text, t.id, t.cur_code from tx t;
-- POSITIVE, across a boundary: the discriminated union inside a barrier view.
create view v_barrier_discriminated with (security_barrier = true) as
  select 'tx'::text as source, id, cur_code, amount from tx
  union all
  select 'wallet'::text, id, cur_code, 0::numeric from wallet;
create view v_over_barrier_discriminated as
  select source, id from v_barrier_discriminated;
-- NEGATIVE: one literal in two branches tells them apart no more than none.
create view v_union_same_literal as
  select 'tx'::text as source, id from tx union all select 'tx'::text, id from wallet;
-- NEGATIVE: a numeric literal is not a discriminator: two spellings, one number.
create view v_union_numeric_literal as
  select 1 as source, id from tx union all select 2, id from wallet;
-- NEGATIVE: a NULL is no literal of its own.
create view v_union_null_discriminator as
  select 'tx'::text as source, id from tx union all select NULL::text, id from wallet;
-- NEGATIVE: the branches are told apart, and a row of one branch is not.
create view v_union_discriminated_unkeyed as
  select 'tx'::text as source, cur_code from tx
  union all
  select 'wallet'::text, cur_code from wallet;

-- POSITIVE: a de-duplicated subquery joined on every column it has meets each row at
-- most once — the shape the planner itself builds to turn a semi join into an inner
-- join.
create view v_sale_distinct_region as
  select s.id from sale s
  join (select distinct region_code from store) live on live.region_code = s.region_code;
-- NEGATIVE: a grouped subquery with an aggregate beside its group key. Its group key
-- is a key, but whether the plan keeps a `Subquery Scan` over it — which renames its
-- columns to names nothing maps back — is the planner's choice of join method, so
-- below a join a grouping is taken as a key only where it is nothing but its key.
create view v_sale_store_totals as
  select s.id, totals.n
  from sale s
  left join (select store_id, count(*) as n from sale group by store_id) totals
    on totals.store_id = s.store_id;

-- NEGATIVE: a lateral grouping that reaches out to another relation. Once the grouping
-- is pinned, what stood inside it — the filter tying it to `st` — holds of the rows
-- it collapsed, not of the row it emits, so it determines nothing about `st`.
create view v_sale_lateral_grouping as
  select s.id, st.id as store_id
  from sale s
  join store st on true
  join lateral (select distinct x.region_code from sale x where x.store_id = st.id) r
    on r.region_code = s.region_code;
-- NEGATIVE: the same text in two lengths is one value, not two discriminators.
create view v_union_varchar_lengths as
  select 'x'::varchar(5) as source, id from tx
  union all
  select 'x'::varchar(10), id from wallet;
-- NEGATIVE, across a boundary: a cast over the discriminator can make two literals one
-- — `'tx'` and `'wallet'` are both something else in two characters. The barrier's
-- own `ORDER BY` keeps its boundary in the plan, so the cast is read across it.
create view v_barrier_discriminated_ordered with (security_barrier = true) as
  select 'deposit'::text as source, id from tx
  union all
  select 'debit'::text, id from wallet
  order by 2;
create view v_over_barrier_discriminated_cast as
  select source::varchar(2) as source, id from v_barrier_discriminated_ordered;
-- NEGATIVE: a deferrable unique constraint admits duplicates until commit.
create table deferred_code (
  code text not null,
  constraint deferred_code_key unique (code) deferrable initially deferred
);
create view v_deferred_code as select code from deferred_code;
-- POSITIVE: a semi join de-duplicated over an expression pins that expression.
create view v_sale_in_shifted_store as
  select s.id from sale s where s.store_id in (select st.id + 1 from store st);
-- NEGATIVE: a view that ends in a LIMIT is, under a join, the top of a subquery.
create view v_first_stores as select id, code from store order by id limit 10;
create view v_sale_first_store as
  select s.id, f.code from sale s join v_first_stores f on f.id = s.store_id;

-- ── Non-nullness from the plan's own qualifiers ─────────────────────────────────
--
-- A column the catalog calls nullable is never NULL in a view whose qualifiers reject
-- the NULL — `IS NOT NULL`, or a strict equality — wherever the qualifier holds of
-- every row the column arrives in.

-- POSITIVE: a join on the column rejects a NULL in it, whether the join keeps the
-- condition or a nested loop pushes it into the inner scan.
create view v_joined_on_nullable as
  select t.id, t.bank_id from tx t join bank b on b.id = t.bank_id;
-- POSITIVE: so does a filter to a literal.
create view v_filtered_to_literal as select id, tag from slot where tag = 'x';
-- POSITIVE: a semi join emits only rows that found a match.
create view v_semi_on_nullable as
  select t.id, t.bank_id from tx t where t.bank_id in (select b.id from bank b);
-- POSITIVE: a partial index built on the very predicate drops it from the scan's
-- `Filter`; the predicate the plan names the index of is read instead.
create table ticket (id bigint primary key, code text);
create index ticket_code_idx on ticket (code) where code is not null;
create view v_partial_index_predicate as
  select id, code from ticket where code is not null order by code;
-- POSITIVE: every branch of a union rejects the NULL.
create view v_union_both_filtered as
  select id, bank_id from tx where bank_id is not null
  union all
  select id, bank_id from tx where bank_id is not null and amount > 0;

-- NEGATIVE: an outer join keeps the rows its condition does not match.
create view v_left_join_condition as
  select t.id, t.bank_id, b.title from tx t left join bank b on b.id = t.bank_id;
-- NEGATIVE: so does an anti join, which keeps only those.
create view v_anti_on_nullable as
  select t.id, t.bank_id from tx t where not exists (select 1 from bank b where b.id = t.bank_id);
-- NEGATIVE: an arm of a disjunction holds of some rows, not of every row.
create view v_disjunction_not_null as
  select id, bank_id from tx where bank_id is not null or amount > 0;
-- NEGATIVE: a subplan's condition holds of the subplan's rows.
create view v_subplan_condition as
  select t.id, t.bank_id, exists (select 1 from bank b where b.id = t.bank_id) as known
  from tx t;
-- NEGATIVE: one branch of a union rejects the NULL and the other does not.
create view v_union_one_filtered as
  select id, bank_id from tx where bank_id is not null
  union all
  select id, bank_id from tx where amount > 0;

-- ── Non-nullness of computed columns ───────────────────────────────────────────
--
-- An entry that is not a column reference has no base column to ask about, but its
-- own shape answers a lot: a literal is never NULL, `count` never is, a `COALESCE`
-- with one never-NULL arm never is (plan-expressions.ts). The rules are recursive —
-- any depth of the shapes that carry them — and every other shape stays nullable
-- rather than guessed: a strict function, a window function, an aggregate over a
-- nullable column or over no group.

-- POSITIVE: a literal is never NULL, however cast.
create view v_expr_literal as select id, 'usdt'::text as code, 0::numeric as zero from tx;
-- POSITIVE: one never-NULL arm of a COALESCE is enough — here the literal at the end
-- of an arm that is itself a COALESCE over a NULL literal and a nullable column.
create view v_expr_coalesce as
  select id,
         coalesce(bank_id, 0::bigint) as bank_id,
         coalesce(bank_id, coalesce(null::bigint, 0)) as nested
  from tx;
-- NEGATIVE: every arm nullable is a nullable COALESCE.
create view v_expr_coalesce_nullable as select id, coalesce(bank_id, bank_id) as b from tx;
-- POSITIVE: a complete CASE over never-NULL arms, nested one in another.
create view v_expr_case_else as
  select id,
         case when bank_id is null then case when amount > 0 then 1 else 2 end
              else coalesce(bank_id, 3)
         end as filled
  from tx;
-- NEGATIVE: a CASE without ELSE answers NULL on its last arm.
create view v_expr_case_no_else as
  select id, case when bank_id is null then 0 end as filled from tx;
-- NEGATIVE: an ELSE over a nullable column does not repair the CASE.
create view v_expr_case_nullable_arm as
  select id, case when bank_id is null then 0 else bank_id end as filled from tx;
-- POSITIVE: count answers 0 over what it counted, however it counted.
create view v_expr_group_count as
  select cur_code, count(*) as n, count(bank_id) as nb, count(distinct bank_id) as nd
  from tx group by cur_code;
-- POSITIVE: min/max/sum/avg over a NOT NULL column answer a value in every row of
-- a grouping: each row stands for a non-empty group.
create view v_expr_group_values as
  select cur_code, min(amount) as lo, max(amount) as hi, sum(amount) as total, avg(amount) as mean
  from tx group by cur_code;
-- NEGATIVE: over the whole input they answer NULL when it is empty; count does not.
create view v_expr_aggregate_whole_input as
  select max(amount) as hi, sum(amount) as total, count(*) as n from tx;
-- NEGATIVE: so do they over a nullable column, group or no group.
create view v_expr_group_nullable_argument as
  select cur_code, max(bank_id) as hi from tx group by cur_code;
-- NEGATIVE: a FILTER can drop every row of the group the aggregate would have seen.
create view v_expr_group_filtered as
  select cur_code, max(amount) filter (where id < 0) as hi from tx group by cur_code;
-- POSITIVE: the whitelisted operators over never-NULL operands are a value or an
-- error, never NULL; the IS forms are a boolean whatever the operand.
create view v_expr_operators as
  select id, amount + 1 as plus, amount * 2 as twice, cur_code || 'x' as glued,
         bank_id is null as absent, cur_code is distinct from 'usdt' as other
  from tx;
-- NEGATIVE: a nullable operand is a NULL result for the same operators.
create view v_expr_operator_nullable as select id, bank_id + 1 as plus from tx;
-- NEGATIVE: a function's strictness proves nothing — lower of an empty range is
-- NULL from a non-NULL argument.
create view v_expr_function as select id, upper(cur_code) as loud from tx;
-- NEGATIVE: a window function runs per frame, and a frame can be empty.
create view v_expr_window as select id, row_number() over (order by id) as rn from tx;
-- POSITIVE: a cast hands its operand's answer on. The value it preserves is another
-- question, which is why this column has no origins, only non-nullness.
create view v_expr_cast as select id, cur_code::varchar(4) as code from tx;
-- NEGATIVE: NULLIF answers NULL whenever its arguments compare equal.
create view v_expr_nullif as select id, nullif(cur_code, 'usdt') as code from tx;
-- POSITIVE: a computed branch proves non-nullness the way a single entry does, and
-- a union column is never NULL only where every branch proves it.
create view v_expr_union_literal as
  select id, coalesce(bank_id, 0::bigint) as bank_id from tx where amount > 0
  union all
  select id, 0::bigint from tx where amount <= 0;
-- NEGATIVE: one branch that can be NULL makes the union column nullable.
create view v_expr_union_nullable_branch as
  select id, coalesce(bank_id, 0::bigint) as bank_id from tx where amount > 0
  union all
  select id, bank_id from tx where amount <= 0;
-- POSITIVE, across a boundary: a computed column of a crossed view is the same
-- expression one step down.
create view v_barrier_expr with (security_barrier = true) as
  select id, cur_code, coalesce(bank_id, 0::bigint) as bank_filled from tx;
create view v_over_barrier_expr as select id, bank_filled from v_barrier_expr;
-- NEGATIVE: an outer join over a grouping pads the computed column with NULL the
-- same way it pads a base column.
create view v_expr_group_under_outer_join as
  select r.id, v_group.n from refund r left join v_group on v_group.cur_code = r.id::text;
-- POSITIVE: an inner join over the same grouping pads nothing.
create view v_expr_group_over_join as
  select r.id, v_group.n from refund r join v_group on v_group.cur_code = r.id::text;
-- POSITIVE: an aggregate call with ORDER BY inside is still a call, and the
-- literal arm of the COALESCE around it answers never-NULL on its own —
-- wherever the planner prints the expression from.
create view v_expr_ordered_aggregate as
  select cur_code, coalesce(string_agg(cur_code, ',' order by id), ''::text) as glued
  from tx group by cur_code;

-- ── What a cast preserves ───────────────────────────────────────────────────────
--
-- A cast is not a shape whose SQL definition is the claim, the way `COALESCE` or
-- `count` is: the value it answers is the cast's own, and PostgreSQL lets a cast
-- answer NULL for a non-NULL input. `jsonb` to `integer` answers NULL for the
-- `jsonb` null; a `CREATE CAST` whose function returns NULL answers NULL wherever
-- it likes. The plan prints the target type by name and says nothing about the
-- operand's type, so the pair is read off the operand's own shape, and a cast is
-- taken for transparent only where both ends are one family PostgreSQL defines to
-- answer a value for every input of the other — the exact numbers, the text types.

-- POSITIVE: text to varchar is binary-coercible, and a NOT NULL column stays NOT NULL.
create view v_cast_text_to_varchar as select id, cur_code::varchar as cur_code from tx;
-- POSITIVE: the widening integer casts `pg_cast` sends through a function answer a
-- value for every input, so a NOT NULL bigint stays NOT NULL through `bigint` to
-- `numeric`.
create table document (id bigint primary key, payload jsonb not null, flag boolean);
create view v_cast_int_to_numeric as select id, id::numeric as scaled from document;
-- NEGATIVE: `jsonb` to `integer` answers NULL for the `jsonb` null.
create view v_cast_jsonb_to_int as select id, payload::int as payload from document;
-- NEGATIVE: a user-defined cast whose function answers NULL for a non-NULL input.
create type mystery as enum ('a');
create function to_mystery(bigint) returns mystery
  language plpgsql immutable as $$ begin if $1 < 0 then return null; end if; return 'a'; end $$;
create cast (bigint as mystery) with function to_mystery(bigint);
create view v_cast_user_defined as select id, id::mystery as mystery_id from document;

-- POSITIVE: the IS TRUE/FALSE/UNKNOWN tests answer a boolean whatever the operand,
-- however NULL it is.
create view v_expr_is_tests as
  select id,
         flag is true as is_true, flag is not true as is_not_true,
         flag is false as is_false, flag is not false as is_not_false,
         flag is unknown as is_unknown, flag is not unknown as is_not_unknown
  from document;

-- NEGATIVE: `GROUP BY ()` groups the whole input into one group that may be empty,
-- so an aggregate over it answers NULL when the input is empty.
create view v_expr_group_by_empty as
  select min(amount) as lo, avg(amount) as mean from tx group by ();

-- POSITIVE: `count` is 0 over no rows, so it is never NULL in the grand-total and
-- subtotal rows of `GROUP BY ()`, `ROLLUP`, `CUBE` and `GROUPING SETS` alike — the
-- one aggregate SQL defines over the rows themselves rather than over their values.
-- `ROLLUP`/`CUBE`/`()` all reach the plan as a node computing `GROUPING SETS`, the
-- same node an explicit `GROUPING SETS` builds; PostgreSQL does not pull a view using
-- the explicit spelling up into the query above it, so the case is written with the
-- spellings that do flatten.
create view v_group_by_empty_count as
  select min(amount) as lo, count(*) as n from tx group by ();
create view v_group_count_rollup as
  select id, count(*) as n, count(bank_id) as some_n from tx group by rollup (id);
create view v_group_count_cube as select id, count(*) as n from tx group by cube (id);

-- ── A user object taking a built-in spelling ────────────────────────────────────
--
-- The non-nullness rules read a function's, an operator's or a type's name off the
-- plan, and a user object that takes a built-in spelling is printed by it. The rule
-- the spelling carries stands down for the view that names that object (and the views
-- built on it), and for no other: the many views above that call the built-in `count`,
-- `+` and `integer` keep their rules.

create function lab.count(integer) returns integer
  language plpgsql immutable as $$ begin if $1 < 0 then return null; end if; return $1; end $$;
create function lab.plus(bigint, bigint) returns bigint
  language plpgsql immutable as $$ begin if $1 < 0 then return null; end if; return $1 + $2; end $$;
create operator lab.+ (leftarg = bigint, rightarg = bigint, function = lab.plus);
create domain lab.integer as bigint;

-- NEGATIVE: a user `count` under a name the rules know: the column it fills is not
-- claimed non-null, and neither is the one a view built on this one fills.
create view v_user_count as select id, lab.count(amount::integer) as c from tx;
create view v_over_user_count as select id, c from v_user_count;
-- NEGATIVE: a user `+` whose function may answer NULL stands the whitelisted operator
-- rule down.
create view v_user_operator as select id, (id operator(lab.+) 1) as plus from tx;
-- NEGATIVE: a user type spelled `integer` is no longer the built-in's promise: the
-- cast the family rule would have trusted stands down for the view that names it.
create view v_user_type as select id, coalesce(amount, 0)::lab.integer as ii from tx;

-- ── A `WITH` name at two query levels ───────────────────────────────────────────
--
-- The plan spells a `CTE Scan` with the `WITH` query's own name and never says which
-- level it reads, so a name two `WITH` queries share is ambiguous: the reader takes
-- neither rather than read one level's column off another level's subplan. The tables
-- carry rows so that a case which crossed the wrong level would emit a tag the rows
-- contradict.

create table need (id int primary key, nn int not null, nul int);
insert into need values (1, 10, null), (2, 20, 5);
create table need_ref (id int primary key, need_id int not null references need(id), note text);
insert into need_ref values (1, 1, 'a'), (2, 2, 'b');

-- NEGATIVE: the outer `live` and the lateral `live` share a name. The true `inner_x.y`
-- is `need.nul` (nullable), but the top `live`'s subplan computes `need.nn`; a reader
-- that picked the first subplan would call it never NULL.
create view v_cte_name_shadowed as
  with live as materialized (select id as x, nn as y from need)
  select outer_live.x, inner_x.y
  from live outer_live
  join lateral (
    with live as materialized (select n.nul as y, n.id as x from need n)
    select il.x, il.y from live il
  ) inner_x on inner_x.x = outer_live.x;

-- NEGATIVE: the same shape with a relation in play. The true `inner_x.inner_v` is
-- `need.nn` (no foreign key); the top `live`'s subplan computes `need_ref.need_id`
-- (which references `need`), so a reader that picked the first subplan would lead a
-- foreign key the rows do not carry.
create view v_cte_name_shadowed_fk as
  with live as materialized (select need_ref.need_id as v from need_ref)
  select outer_live.v, inner_x.inner_v
  from live outer_live
  join lateral (
    with live as materialized (select n.nn as v from need n)
    select il.v as inner_v from live il
  ) inner_x on inner_x.inner_v = outer_live.v;

-- POSITIVE: a constant array in the stored tree (`:constvalue … [ … ]`, what a
-- `WHERE false` writes) does not break the walk, so the `WITH` query still reads.
create view v_cte_where_false as
  with live as materialized (select id, cur_code from tx)
  select live.id, live.cur_code from live where false;

-- ── A `WITH` name shared across the views a query goes through ──────────────────
--
-- The plan spells a `CTE Scan` with the `WITH` query's own name and never says which
-- view's query it is. A name the analysed view and one of its source views both define
-- — the source's materialized, so it leaves a `CTE live` subplan, the analysed view's
-- inlined, so its own tree shows no clash — cannot be pinned to either, and reading it
-- off the analysed view's map puts the source's columns behind the wrong names. The
-- data is here so a case that crossed the wrong query would emit a tag the rows
-- contradict.

create table parent (id int primary key);
create table child (id int primary key, ref int not null references parent(id), plain int not null);
insert into parent values (1);
insert into child values (1, 1, 5);

-- NEGATIVE: `v_cte_cross_view.sx` is `v_cte_cross_src.x`, a nullable `need.nul`, but the
-- source's own `live` computes `need.nn` at the position `x` stands at in the analysed
-- view's `live`.
create view v_cte_cross_src as
  with live as materialized (select id as k, nn as y, nul as x from need)
  select a.k, a.x from live a join live b using (k);
create view v_cte_cross_view as
  with live as (select id as y, nn as x from need)
  select o.y as oy, s.x as sx from live o join v_cte_cross_src s on s.k = o.y;

-- NEGATIVE: the same with a key in play. `sx` is `child.plain`, no key, but the source's
-- `live` computes `child.ref` at that position, which references `parent`.
create view v_cte_cross_src_fk as
  with live as materialized (select id as k, ref as y, plain as x from child)
  select a.k, a.x from live a join live b using (k);
create view v_cte_cross_view_fk as
  with live as (select id as y, ref as x from child)
  select o.y as oy, s.x as sx from live o join v_cte_cross_src_fk s on s.k = o.y;

-- NEGATIVE: a source reached through two views, so the clash is not direct.
create view v_cte_cross_mid as
  with live as materialized (select id as k, nn as y, nul as x from need)
  select a.k, a.x from live a join live b using (k);
create view v_cte_cross_src2 as select k, x from v_cte_cross_mid;
create view v_cte_cross_view_two as
  with live as (select id as y, nn as x from need)
  select o.y as oy, s.x as sx from live o join v_cte_cross_src2 s on s.k = o.y;

-- NEGATIVE: both `live` queries inlined, so the plan carries no subplan of that name and
-- the source's `live` leaves no trace; the clash is still refused rather than read.
create view v_cte_cross_src_once as
  with live as (select id as k, nul as x from need)
  select k, x from live;
create view v_cte_cross_view_inlined as
  with live as (select id as y, nn as x from need)
  select o.y as oy, s.x as sx from live o join v_cte_cross_src_once s on s.k = o.y;
