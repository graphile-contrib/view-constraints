// A view's stored rewrite tree, read for the facts the plan cannot state: the column
// names of each `WITH` query, the base column each of the view's own columns came from,
// and the relation each range-table alias names.
//
// PostgreSQL keeps the analysed body of a view in `pg_rewrite.ev_action`, a
// `pg_node_tree`: the node tree printed by the server's own `outfuncs`, bracketed and
// labelled by field name. It is not SQL and no grammar is parsed here — the text is
// walked bracket by bracket, and only fields this reader needs are taken, by name, in
// place of everything else. The format is internal and carries no cross-version promise,
// so the whole tree is read closed by default: everything this walk does not recognise
// fails it, and a failed tree yields nothing rather than a partial answer, which the
// caller turns into a named refusal (see `plan-origins.ts`). `__tests__` reads the lab
// views through it on every run, so a major-version change to the format fails a case.
//
// Three questions it answers:
//
//   * `:ctename` and `:ctecolnames` give, for every `WITH` query, its column names in
//     select-list order. That is the map a `CTE Scan` in the plan does not print, and
//     it is what lets `plan-origins.ts` read a `WITH` query's column off the subplan
//     that computes it. A `WITH` query referenced once is inlined and leaves no CTE at
//     all; a materialized one is the wall this map takes down. A name two `WITH`
//     queries share — the same name at two query levels, which the plan does not tell
//     apart — is dropped, so neither is read.
//   * `:resname`, `:resorigtbl`, `:resorigcol` give, per column of the view, the base
//     relation and column the parser traced it to (`markTargetListOrigins`). It is a
//     fact frozen at the view's creation and carried through subqueries, joins and
//     `WITH` queries; it is `0` for a column that is an expression, an aggregate or a
//     set operation, and it names an inner view rather than a base table where the
//     column came through one. This reader takes it only as a fallback source for a
//     relation, where the plan's own reading did not reach.
//   * `:rtable` gives, per range-table alias, the relation it names (`:rtekind 0`,
//     `:relid`). A `Subquery Scan` in the plan is spelled with its range-table entry's
//     name, which is the alias where the query wrote one (`FROM deposit.v bank_range`);
//     this is what turns that alias back into the relation. The same table, with the
//     `varno` of each column's expression, says which columns this view reads from a
//     `WITH` query whose columns a plan may spell either way (`:rtekind 6`, inlined and
//     not simple) — the columns refused rather than read.

/** One value of a `pg_node_tree`: a node, a list, an array, a string, or a bare token. */
type Dumped =
  | { kind: 'node'; type: string; fields: Map<string, Dumped> }
  | { kind: 'list'; items: Dumped[] }
  | { kind: 'string'; value: string }
  | { kind: 'token'; value: string }

const TOKEN_END = new Set([' ', '\t', '\n', '\r', '{', '}', '(', ')', ':', '[', ']'])

class DumpReader {
  private at = 0
  private readonly text: string
  /** Set where the walk meets a character it cannot place: the tree is then untrusted. */
  private failed = false

  constructor(text: string) {
    this.text = text
  }

  parse(): { ok: boolean; value: Dumped | null } {
    const value = this.parseValue()
    return { ok: !this.failed, value }
  }

  private skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at] ?? '')) this.at += 1
  }

  private parseToken(): string {
    let value = ''
    while (this.at < this.text.length) {
      const char = this.text[this.at] ?? ''
      // The deparser escapes a character that would end a bare token with a backslash
      // — an identifier with a space in it (`*SELECT*\ 1`) is one token of both words.
      if (char === '\\') {
        value += this.text[this.at + 1] ?? ''
        this.at += 2
        continue
      }
      if (TOKEN_END.has(char)) break
      value += char
      this.at += 1
    }
    return value
  }

  private parseString(): Dumped {
    this.at += 1
    let value = ''
    while (this.at < this.text.length) {
      const char = this.text[this.at]
      if (char === '\\') {
        const next = this.text[this.at + 1] ?? ''
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next
        this.at += 2
        continue
      }
      if (char === '"') {
        this.at += 1
        break
      }
      value += char
      this.at += 1
    }
    return { kind: 'string', value }
  }

  /** A bracketed run of values: `( … )` for a list, `[ … ]` for a constant array. */
  private parseBracketed(open: '(' | '[', close: ')' | ']'): Dumped {
    if (this.text[this.at] !== open) this.failed = true
    this.at += 1
    const items: Dumped[] = []
    for (;;) {
      this.skipSpace()
      const char = this.text[this.at]
      if (char === undefined) {
        this.failed = true
        break
      }
      if (char === close) {
        this.at += 1
        break
      }
      const before = this.at
      items.push(this.parseValue())
      // A value this reader cannot place must still move the cursor on, or a format it
      // does not know would spin; the tree is marked unread instead.
      if (this.at === before) {
        this.at += 1
        this.failed = true
      }
    }
    return { kind: 'list', items }
  }

  private parseNode(): Dumped {
    this.at += 1
    const type = this.parseToken()
    const fields = new Map<string, Dumped>()
    for (;;) {
      const before = this.at
      this.skipSpace()
      const char = this.text[this.at]
      if (char === undefined) {
        this.failed = true
        break
      }
      if (char === '}') {
        this.at += 1
        break
      }
      // `:constvalue <count> [ <values> ]` prints the array as the field's value and a
      // bracketed run after it; the run is read and the walk goes on to the next field.
      if (char === '[') {
        this.parseBracketed('[', ']')
        continue
      }
      if (char !== ':') {
        // Anything unexpected (a future format) stops the field walk and fails it.
        this.failed = true
        break
      }
      this.at += 1
      const name = this.parseToken()
      this.skipSpace()
      fields.set(name, this.parseValue())
      if (this.at === before) {
        this.failed = true
        break
      }
    }
    return { kind: 'node', type, fields }
  }

  private parseValue(): Dumped {
    this.skipSpace()
    const char = this.text[this.at]
    if (char === '{') return this.parseNode()
    if (char === '(') return this.parseBracketed('(', ')')
    if (char === '[') return this.parseBracketed('[', ']')
    if (char === '"') return this.parseString()
    return { kind: 'token', value: this.parseToken() }
  }
}

/** The text one node field spells, whether the deparser quoted it or left it bare. */
function textOf(value: Dumped | undefined): string | null {
  if (value === undefined) return null
  if (value.kind === 'string' || value.kind === 'token') return value.value
  return null
}

function numberOf(value: Dumped | undefined): number | null {
  const text = textOf(value)
  if (text === null) return null
  const number = Number(text)
  return Number.isInteger(number) ? number : null
}

/** Every node of a list value; a value that is not a list yields none. */
function nodesOf(value: Dumped | undefined): Dumped[] {
  if (value?.kind !== 'list') return []
  return value.items.filter((item) => item.kind === 'node')
}

/** Every string a list value spells; a value that is not a list yields none. */
function stringsOf(value: Dumped | undefined): string[] {
  if (value?.kind !== 'list') return []
  return value.items.map((item) => textOf(item)).filter((item): item is string => item !== null)
}

/** Every node of a value, however deep, so nested queries' range tables are reached. */
function walkDumped(value: Dumped, visit: (node: Extract<Dumped, { kind: 'node' }>) => void): void {
  if (value.kind === 'node') {
    visit(value)
    for (const field of value.fields.values()) walkDumped(field, visit)
  } else if (value.kind === 'list') {
    for (const item of value.items) walkDumped(item, visit)
  }
}

/** An alias name, or `null` where the field is present but empty (`<>`). */
function aliasName(value: Dumped | undefined): string | null {
  const name = textOf(value)
  return name === null || name.length === 0 || name === '<>' ? null : name
}

/** The alias of one range-table entry, which `ALIAS` and `EREF` each spell. */
function aliasOf(entry: Extract<Dumped, { kind: 'node' }>): string | null {
  for (const field of ['alias', 'eref']) {
    const node = entry.fields.get(field)
    if (node?.kind === 'node') {
      const name = aliasName(node.fields.get('aliasname'))
      if (name !== null) return name
    }
  }
  return null
}

/** A field the dump prints as `<>` where the query writes nothing there. */
function emptyField(value: Dumped | undefined): boolean {
  return value === undefined || (value.kind === 'token' && value.value === '<>')
}

/**
 * How far the walk follows a value into the query levels it stands on before it stands
 * down. The chain an ordinary view builds is a handful of levels deep; a chain longer than
 * this is refused by the walk rather than followed, so a shape nobody has seen is a refusal
 * rather than a silent "nothing to see".
 */
const LEVEL_TRACE_DEPTH = 8

/**
 * Whether pulling a query into the query above it is a rule rather than a choice. It is a
 * rule for a projection: a bare projection is pulled up wherever it stands. It is not for a
 * query that groups, aggregates, de-duplicates, limits, windows or spreads a set-returning
 * call, because pulling one of those up means merging that work into the query above, and
 * the planner does that only where it chooses to — the plan then prints the query's columns
 * flattened above or behind a subquery it kept. A field the dump does not carry is read as
 * the work being done: the doubt is taken on rather than the query trusted with what the
 * reader cannot see.
 *
 * A set operation is deliberately not on the list. Pulling a `UNION ALL` up is a rule of its
 * own (`is_simple_union_all`, decided before any cost), a `UNION` is never pulled up, and
 * the reader reads every set operation where it stands — so a union level's columns are
 * printed the same way whatever the plan costs, and refusing them here would take back the
 * set operations this reader was built to read.
 */
function simpleQuery(query: Extract<Dumped, { kind: 'node' }> | undefined): boolean {
  return !(
    saysTrue(query, 'hasAggs') ||
    saysTrue(query, 'hasWindowFuncs') ||
    saysTrue(query, 'hasTargetSRFs') ||
    saysTrue(query, 'hasDistinctOn') ||
    saysTrue(query, 'hasModifyingCTE') ||
    saysSomething(query, 'groupClause') ||
    saysSomething(query, 'distinctClause') ||
    saysSomething(query, 'limitCount') ||
    saysSomething(query, 'limitOffset')
  )
}

/** Whether a boolean field of a query is `true`, a field the dump does not carry included. */
function saysTrue(query: Extract<Dumped, { kind: 'node' }> | undefined, field: string): boolean {
  if (query === undefined || !query.fields.has(field)) return true
  return textOf(query.fields.get(field)) === 'true'
}

/** Whether a clause field of a query holds something, a field the dump does not carry included. */
function saysSomething(
  query: Extract<Dumped, { kind: 'node' }> | undefined,
  field: string
): boolean {
  if (query === undefined || !query.fields.has(field)) return true
  return !emptyField(query.fields.get(field))
}

/** One column of a view, as its own stored tree traced it. */
export interface TreeOrigin {
  tableId: number
  attnum: number
}

/**
 * The fields the reader takes from each node type it reads anything out of. The walk
 * fails the whole tree on a node of one of these types that does not carry every field
 * listed, so a field renamed or removed on a node the reader depends on is a refusal
 * rather than a silent empty answer. The reader does not demand that a node carry
 * *only* these fields — PostgreSQL prints a different field *set* per type and the
 * sets move between majors (PostgreSQL 15 and 16 print a field on these nodes that 17
 * and 18 do not), so an unknown field with a well-formed value is read past, while a
 * missing one the reader needs fails the tree. Node types the reader only walks past
 * (`CONST`, `BOOL`, …) are not listed: nothing is taken from them.
 */
const REQUIRED_NODE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['QUERY', ['cteList', 'targetList']],
  ['TARGETENTRY', ['resorigtbl', 'resorigcol', 'expr']],
  ['COMMONTABLEEXPR', ['ctename', 'ctecolnames']],
  ['RANGETBLENTRY', ['rtekind', 'alias']],
  ['ALIAS', ['aliasname']],
  ['VAR', ['varno', 'varlevelsup']]
])

/**
 * The fields a range-table entry must carry for the kind it says it is (`:rtekind`): the
 * reader takes a `WITH` query's name from one, a subquery's query from another, a `GROUP`
 * entry's expressions from a third and a relation's oid from a fourth, and a field renamed
 * or removed on any of them fails the tree rather than leaving a column read past.
 */
const REQUIRED_RTE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['0', ['relid']],
  ['1', ['subquery']],
  ['6', ['ctename']],
  ['9', ['groupexprs']]
])

/** Whether a node of the walk carries every field this reader needs of its type. */
function hasRequiredFields(node: Extract<Dumped, { kind: 'node' }>): boolean {
  const required = REQUIRED_NODE_FIELDS.get(node.type)
  if (required !== undefined) {
    for (const field of required) if (!node.fields.has(field)) return false
  }
  if (node.type !== 'RANGETBLENTRY') return true
  const byKind = REQUIRED_RTE_FIELDS.get(textOf(node.fields.get('rtekind')) ?? '')
  if (byKind === undefined) return true
  for (const field of byKind) if (!node.fields.has(field)) return false
  return true
}

/** Everything this reader takes from a view's stored tree. */
export interface ViewTree {
  /** Whether the whole tree parsed. `false` means none of the rest is trusted. */
  ok: boolean
  /** CTE name → its column names in select-list order. */
  cteColumns: Map<string, string[]>
  /**
   * CTE name → the origin of each of its columns in select-list order: the base relation
   * and attribute number the column's target-list entry is a `Var` of, or `null` where
   * the entry is an expression. This is what a plan's `CTE <name>` subplan is proved
   * against before it is read (`plan-origins.ts`).
   */
  cteOrigins: Map<string, (TreeOrigin | null)[]>
  /** CTE names the tree defines at more than one query level, so the plan cannot tell them apart. */
  cteAmbiguous: Set<string>
  /** View column position → the base relation oid and attribute number it came from. */
  treeOrigins: Map<number, TreeOrigin>
  /**
   * View column positions whose value stands on a query a plan may spell either way: a
   * `WITH` query this view inlines that is not simple — one that groups, aggregates,
   * de-duplicates, limits or windows, so pulling it up means merging that work into the
   * query above, which the planner does only where it chooses to — or a `FROM (SELECT …)`
   * subquery that is, or either of those read through another. Such a column is refused
   * rather than read (`derive.ts`).
   */
  optionallyFlattenedColumns: Set<number>
  /** Range-table alias → the relation oid it names. */
  relationAliases: Map<string, number>
  /**
   * Whether each `WITH` query of this view is **materialized** by PostgreSQL, read from
   * the query's own `:ctematerialized` (`MATERIALIZED`, `NOT MATERIALIZED`, default),
   * `:cterefcount` and `:cterecursive`: a `MATERIALIZED` query, a recursive one, and a
   * default one referenced more than once are materialized; a `NOT MATERIALIZED` one,
   * and a default one referenced once, are inlined. A plan carries a `CTE <name>`
   * subplan and a `CTE Scan` only for a materialized query, so a name this view inlines
   * has no scan of its own and any scan of that name is some other query's. The default
   * referenced once is inlined only while its body has no volatile function, which the
   * tree does not say — so a `false` here is read as "no scan of this name may be read",
   * which refuses a query a volatile function actually materialized rather than trust it.
   */
  cteMaterialized: Map<string, boolean>
  /** How many times each `WITH` query is referenced in this view's own query. */
  cteRefCount: Map<string, number>
}

/**
 * Reads a view's whole stored tree. A tree the walk cannot fully place is `ok: false`
 * with every map empty — the caller refuses rather than reading a partial answer.
 */
export function readViewTree(action: string): ViewTree {
  const tree: ViewTree = {
    ok: false,
    cteColumns: new Map(),
    cteOrigins: new Map(),
    cteAmbiguous: new Set(),
    treeOrigins: new Map(),
    optionallyFlattenedColumns: new Set(),
    relationAliases: new Map(),
    cteMaterialized: new Map(),
    cteRefCount: new Map()
  }
  const parsed = new DumpReader(action).parse()
  if (!parsed.ok || parsed.value === null) return tree
  const root = parsed.value
  const top = root.kind === 'list' ? nodesOf(root)[0] : root
  if (top?.kind !== 'node' || top.type !== 'QUERY') return tree
  // Closed by default: a node this reader takes anything from must carry only fields it
  // knows for its type, or the format has moved and nothing here is trusted.
  let known = true
  walkDumped(root, (node) => {
    if (known && !hasRequiredFields(node)) known = false
  })
  if (!known) return tree
  tree.ok = true

  // The whole tree, so a `WITH` query nested in another query's body is reached: a name
  // two of them share is dropped, because the plan spells both by that name and cannot
  // say which a `CTE Scan` reads.
  const cteDefinitions = new Map<
    string,
    { query: Extract<Dumped, { kind: 'node' }> | undefined; simple: boolean; inlined: boolean }[]
  >()
  walkDumped(root, (node) => {
    for (const cte of nodesOf(node.fields.get('cteList'))) {
      if (cte.kind !== 'node') continue
      const name = textOf(cte.fields.get('ctename'))
      const names = stringsOf(cte.fields.get('ctecolnames'))
      if (name === null || names.length === 0) continue
      const query = cte.fields.get('ctequery')
      const cteQuery = query?.kind === 'node' ? query : undefined
      // Whether PostgreSQL materializes this query, from its own declaration: the
      // `:ctematerialized` keyword (`1` `MATERIALIZED`, `2` `NOT MATERIALIZED`, `0`
      // default), the number of references, and recursion.
      const keyword = numberOf(cte.fields.get('ctematerialized'))
      const refCount = numberOf(cte.fields.get('cterefcount')) ?? 0
      const recursive = textOf(cte.fields.get('cterecursive')) === 'true'
      const inlined = !(keyword === 1 || (keyword === 0 && (refCount > 1 || recursive)))
      // Every definition of the name, the ones the plan cannot tell apart included: the
      // same name at two query levels is one spelling for two queries, and no plan says
      // which a scan reads, so the doubt of either definition is the doubt of the name.
      const definitions = cteDefinitions.get(name) ?? []
      definitions.push({ query: cteQuery, simple: simpleQuery(cteQuery), inlined })
      cteDefinitions.set(name, definitions)
      if (tree.cteColumns.has(name)) {
        tree.cteAmbiguous.add(name)
        continue
      }
      tree.cteColumns.set(name, names)
      // Each of the query's own columns' origin, from its target list: a `Var` records
      // the base relation and attribute (`resorigtbl`/`resorigcol`), anything else
      // records none. A plan subplan named after the query is proved against these
      // before a `CTE Scan` is read off it.
      const targets = cteQuery === undefined ? [] : nodesOf(cteQuery.fields.get('targetList'))
      tree.cteOrigins.set(
        name,
        targets.map((entry) => {
          if (entry.kind !== 'node') return null
          const tableId = numberOf(entry.fields.get('resorigtbl'))
          const attnum = numberOf(entry.fields.get('resorigcol'))
          if (tableId === null || tableId === 0 || attnum === null || attnum === 0) return null
          return { tableId, attnum }
        })
      )
      tree.cteRefCount.set(name, refCount)
      tree.cteMaterialized.set(name, !inlined)
    }
  })
  for (const name of tree.cteAmbiguous) {
    tree.cteColumns.delete(name)
    tree.cteOrigins.delete(name)
    tree.cteMaterialized.delete(name)
    tree.cteRefCount.delete(name)
  }
  // Which query levels a plan may spell either way. Two kinds stand between a view's column
  // and the value it holds: a `WITH` query this view inlines (a materialized one is read off
  // its own subplan, and must be printed as a `CTE Scan`), and a `FROM (SELECT …)` subquery
  // (`:rtekind 1`). Neither has a boundary a plan must show: PostgreSQL pulls either of them
  // up into the query above where the pull-up is a rule — a bare projection is pulled up
  // wherever it stands — and where the level groups, aggregates, de-duplicates, limits,
  // windows or spreads a set-returning call, only where it chooses to, so the plan then
  // prints the level's columns flattened above or behind a subquery it kept. A level that is
  // not simple, or that reads a level that is not, is one whose columns a plan may spell
  // either way, and a column read from it carries no answer that holds.
  const subqueryKeys = new Map<Extract<Dumped, { kind: 'node' }>, string>()
  walkDumped(root, (node) => {
    if (node.type !== 'RANGETBLENTRY') return
    if (textOf(node.fields.get('rtekind')) !== '1') return
    subqueryKeys.set(node, `subquery:${subqueryKeys.size}`)
  })
  interface Level {
    /** Whether a plan must print this level's columns under a boundary of its own. */
    stable: boolean
    /** Whether pulling the level up into the query above is a rule rather than a choice. */
    simple: boolean
    query: Extract<Dumped, { kind: 'node' }> | undefined
    /** The levels this level's own query reads; filled in below. */
    reads: Set<string>
  }
  const levels = new Map<string, Level[]>()
  const addLevel = (key: string, level: Omit<Level, 'reads'>): void => {
    const found = levels.get(key) ?? []
    found.push({ ...level, reads: new Set() })
    levels.set(key, found)
  }
  for (const [name, definitions] of cteDefinitions) {
    for (const definition of definitions) {
      addLevel(`with:${name}`, {
        stable: !definition.inlined,
        simple: definition.simple,
        query: definition.query
      })
    }
  }
  for (const [entry, key] of subqueryKeys) {
    const subquery = entry.fields.get('subquery')
    const query = subquery?.kind === 'node' ? subquery : undefined
    addLevel(key, { stable: false, simple: query !== undefined && simpleQuery(query), query })
  }

  /**
   * The query levels a value stands on, as far as it can be followed: a `Var` at the
   * expression's own level, resolved against that level's range table (`:varno`, and
   * `:varattno` within the entry), through whatever the entry is made of — a `GROUP`
   * entry's `:groupexprs` — until a level or a base relation is reached. A `SUBLINK` is not
   * followed: it stands over a query of its own whose value the plan prints as a subplan,
   * which the reader refuses there. A path the walk cannot follow says so instead of
   * answering.
   */
  interface Trace {
    keys: Set<string>
    unfollowed: boolean
  }
  const trace = (value: Dumped, rtable: Dumped[], depth: number): Trace => {
    const result: Trace = { keys: new Set(), unfollowed: false }
    const merge = (inner: Trace): void => {
      for (const key of inner.keys) result.keys.add(key)
      result.unfollowed = result.unfollowed || inner.unfollowed
    }
    if (depth > LEVEL_TRACE_DEPTH) {
      result.unfollowed = true
      return result
    }
    if (value.kind === 'list') {
      for (const item of value.items) merge(trace(item, rtable, depth))
      return result
    }
    if (value.kind !== 'node') return result
    // A query of its own, or the table that holds one: its reads belong to it, not here.
    if (
      value.type === 'SUBLINK' ||
      value.type === 'QUERY' ||
      value.type === 'COMMONTABLEEXPR' ||
      value.type === 'RANGETBLENTRY'
    ) {
      return result
    }
    if (value.type === 'VAR') {
      if (numberOf(value.fields.get('varlevelsup')) !== 0) {
        result.unfollowed = true
        return result
      }
      const varno = numberOf(value.fields.get('varno'))
      const attno = numberOf(value.fields.get('varattno'))
      if (varno === null || attno === null) {
        result.unfollowed = true
        return result
      }
      const entry = rtable[varno - 1]
      if (entry?.kind !== 'node') {
        result.unfollowed = true
        return result
      }
      const kind = textOf(entry.fields.get('rtekind'))
      // A base relation: the value is a column of a table, and no query stands behind it.
      if (kind === '0') return result
      if (kind === '6') {
        const name = textOf(entry.fields.get('ctename'))
        if (name === null) result.unfollowed = true
        else result.keys.add(`with:${name}`)
        return result
      }
      if (kind === '1') {
        const key = subqueryKeys.get(entry)
        if (key === undefined) result.unfollowed = true
        else result.keys.add(key)
        return result
      }
      if (kind === '9') {
        const grouped = nodesOf(entry.fields.get('groupexprs'))[attno - 1]
        if (grouped === undefined) {
          result.unfollowed = true
          return result
        }
        return trace(grouped, rtable, depth + 1)
      }
      // A function, a `VALUES` list, a join, a table function, a kind the reader does not
      // know: the value comes from something this walk can say nothing about.
      result.unfollowed = true
      return result
    }
    for (const field of value.fields.values()) merge(trace(field, rtable, depth))
    return result
  }
  const readsOf = (query: Extract<Dumped, { kind: 'node' }> | undefined): Set<string> => {
    const keys = new Set<string>()
    if (query === undefined) return keys
    const rtable = nodesOf(query.fields.get('rtable'))
    for (const [field, value] of query.fields) {
      // The `WITH` list holds queries of their own, whose reads are their own too.
      if (field === 'cteList') continue
      for (const key of trace(value, rtable, 0).keys) keys.add(key)
    }
    return keys
  }
  for (const found of levels.values()) {
    for (const level of found) level.reads = readsOf(level.query)
  }
  // Resolved to a fixpoint: a level reads another that may itself read one, and the walk
  // meets them in no order.
  const uncertain = new Set<string>()
  for (let pass = 0; pass < levels.size + 1; pass++) {
    for (const [key, found] of levels) {
      if (uncertain.has(key)) continue
      const spellsEitherWay = found.some(
        (level) =>
          (!level.stable && !level.simple) || [...level.reads].some((read) => uncertain.has(read))
      )
      if (spellsEitherWay) uncertain.add(key)
    }
  }

  for (const [position, entry] of nodesOf(top.fields.get('targetList')).entries()) {
    if (entry.kind !== 'node') continue
    const tableId = numberOf(entry.fields.get('resorigtbl'))
    const attnum = numberOf(entry.fields.get('resorigcol'))
    if (tableId === null || tableId === 0 || attnum === null || attnum === 0) continue
    tree.treeOrigins.set(position, { tableId, attnum })
  }

  // A column whose value stands on a level a plan may spell either way — or on a path the
  // walk cannot follow at all — has no answer that holds across plans, and is named here to
  // be refused rather than read (`derive.ts`).
  const ownRtable = nodesOf(top.fields.get('rtable'))
  for (const [position, entry] of nodesOf(top.fields.get('targetList')).entries()) {
    if (entry.kind !== 'node') continue
    const expr = entry.fields.get('expr')
    if (expr === undefined) continue
    const traced = trace(expr, ownRtable, 0)
    if (traced.unfollowed || [...traced.keys].some((key) => uncertain.has(key))) {
      tree.optionallyFlattenedColumns.add(position)
    }
  }

  const ambiguousAliases = new Set<string>()
  walkDumped(root, (node) => {
    if (node.type !== 'RANGETBLENTRY') return
    if (textOf(node.fields.get('rtekind')) !== '0') return
    const relid = numberOf(node.fields.get('relid'))
    const alias = aliasOf(node)
    if (relid === null || relid === 0 || alias === null) return
    const seen = tree.relationAliases.get(alias)
    if (seen !== undefined && seen !== relid) {
      ambiguousAliases.add(alias)
      return
    }
    tree.relationAliases.set(alias, relid)
  })
  for (const alias of ambiguousAliases) tree.relationAliases.delete(alias)

  return tree
}
