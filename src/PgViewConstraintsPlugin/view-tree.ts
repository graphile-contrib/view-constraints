// A view's stored rewrite tree, read for two facts the plan cannot state: the column
// names of each `WITH` query, and where each of the view's own columns came from.
//
// PostgreSQL keeps the analysed body of a view in `pg_rewrite.ev_action`, a
// `pg_node_tree`: the node tree printed by the server's own `outfuncs`, bracketed and
// labelled by field name. It is not SQL and no grammar is parsed here — the text is
// walked bracket by bracket, and only fields this reader needs are taken, by name, in
// place of everything else. The fields read are stable across many major versions
// (`:ctename`, `:ctecolnames`, `:resname`, `:resorigtbl`, `:resorigcol`), but the
// format is internal and carries no cross-version promise, so `__tests__` holds a
// case that fails on a major-version change to it.
//
// Two questions it answers:
//
//   * `:ctename` and `:ctecolnames` give, for every `WITH` query, its column names in
//     select-list order. That is the map a `CTE Scan` in the plan does not print, and
//     it is what lets `plan-origins.ts` read a `WITH` query's column off the subplan
//     that computes it. A `WITH` query referenced once is inlined and leaves no CTE at
//     all; a materialized one is the wall this map takes down.
//   * `:resname`, `:resorigtbl`, `:resorigcol` give, per column of the view, the base
//     relation and column the parser traced it to (`markTargetListOrigins`). It is a
//     fact frozen at the view's creation and carried through subqueries, joins and
//     `WITH` queries; it is `0` for a column that is an expression, an aggregate or a
//     set operation, and it names an inner view rather than a base table where the
//     column came through one. This reader takes it only as a fallback source for a
//     relation, where the plan's own reading did not reach.

/** One value of a `pg_node_tree`: a node, a list, a string, or a bare token. */
type Dumped =
  | { kind: 'node'; type: string; fields: Map<string, Dumped> }
  | { kind: 'list'; items: Dumped[] }
  | { kind: 'string'; value: string }
  | { kind: 'token'; value: string }

const TOKEN_END = new Set([' ', '\t', '\n', '\r', '{', '}', '(', ')', ':'])

class DumpReader {
  private at = 0
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  parse(): Dumped | null {
    const value = this.parseValue()
    return value
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

  private parseList(): Dumped {
    this.at += 1
    const items: Dumped[] = []
    for (;;) {
      this.skipSpace()
      const char = this.text[this.at]
      if (char === undefined) break
      if (char === ')') {
        this.at += 1
        break
      }
      const before = this.at
      items.push(this.parseValue())
      // A value this reader cannot place must still move the cursor on, or a format it
      // does not know would spin; the walk then ends at the next bracket.
      if (this.at === before) this.at += 1
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
      if (char === undefined || char === '}') {
        if (char === '}') this.at += 1
        break
      }
      if (char !== ':') {
        // Anything unexpected (a future format) stops the field walk; what was read
        // stands, and the caller reads a field it did not find as absent.
        break
      }
      this.at += 1
      const name = this.parseToken()
      this.skipSpace()
      fields.set(name, this.parseValue())
      if (this.at === before) break
    }
    return { kind: 'node', type, fields }
  }

  private parseValue(): Dumped {
    this.skipSpace()
    const char = this.text[this.at]
    if (char === '{') return this.parseNode()
    if (char === '(') return this.parseList()
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

/**
 * The `WITH` query column map of a view: each CTE name to its column names in
 * select-list order. Empty where the tree cannot be read, which leaves the plan's own
 * refusals in place rather than inventing a map.
 */
export function readCteColumns(action: string): Map<string, string[]> {
  const columns = new Map<string, string[]>()
  const tree = new DumpReader(action).parse()
  const query = tree?.kind === 'list' ? nodesOf(tree)[0] : undefined
  if (query?.kind !== 'node') return columns
  for (const cte of nodesOf(query.fields.get('cteList'))) {
    if (cte.kind !== 'node') continue
    const name = textOf(cte.fields.get('ctename'))
    const names = stringsOf(cte.fields.get('ctecolnames'))
    if (name !== null && names.length > 0) columns.set(name, names)
  }
  return columns
}

/** One column of a view, as its own stored tree traced it: `schema.relation.column`. */
export interface TreeOrigin {
  tableId: number
  attnum: number
}

/**
 * Per view column, the base relation oid and attribute number the stored tree traced
 * it to, by the column's position in the view (its `resno` order is the select list's).
 * A column the tree did not trace (an expression, a set operation) has no entry.
 */
export function readTreeOrigins(action: string): Map<number, TreeOrigin> {
  const origins = new Map<number, TreeOrigin>()
  const tree = new DumpReader(action).parse()
  const query = tree?.kind === 'list' ? nodesOf(tree)[0] : undefined
  if (query?.kind !== 'node') return origins
  const targetList = nodesOf(query.fields.get('targetList'))
  for (const [position, entry] of targetList.entries()) {
    if (entry.kind !== 'node') continue
    const tableId = numberOf(entry.fields.get('resorigtbl'))
    const attnum = numberOf(entry.fields.get('resorigcol'))
    if (tableId === null || tableId === 0 || attnum === null || attnum === 0) continue
    origins.set(position, { tableId, attnum })
  }
  return origins
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

/**
 * The relation each range-table alias of the view names, by alias: `alias → oid`.
 *
 * A `Subquery Scan` in the plan is spelled with its range-table entry's name, which is
 * the view's own name where the query wrote it bare and the alias where it wrote one
 * (`FROM deposit.v bank_range`). The tree's `:rtable` holds both — `:alias` and, on an
 * `RTE_RELATION` entry, `:relid` — so the alias resolves to the relation it stands for
 * rather than to a guess by column names. The walk is over the whole tree, because the
 * alias may stand in any query the view holds, a `WITH` query's body included; an alias
 * two relations share is dropped rather than guessed between.
 */
export function readTreeAliases(action: string): Map<string, number> {
  const aliases = new Map<string, number>()
  const ambiguous = new Set<string>()
  const tree = new DumpReader(action).parse()
  if (tree === null) return aliases
  walkDumped(tree, (node) => {
    if (node.type !== 'RANGETBLENTRY') return
    if (textOf(node.fields.get('rtekind')) !== '0') return
    const relid = numberOf(node.fields.get('relid'))
    const alias = aliasOf(node)
    if (relid === null || relid === 0 || alias === null) return
    const seen = aliases.get(alias)
    if (seen !== undefined && seen !== relid) {
      ambiguous.add(alias)
      return
    }
    aliases.set(alias, relid)
  })
  for (const alias of ambiguous) aliases.delete(alias)
  return aliases
}
