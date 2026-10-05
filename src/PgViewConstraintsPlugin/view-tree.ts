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
//     this is what turns that alias back into the relation.

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
 * (`VAR`, `CONST`, …) are not listed: nothing is taken from them.
 */
const REQUIRED_NODE_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['QUERY', ['cteList', 'targetList']],
  ['TARGETENTRY', ['resorigtbl', 'resorigcol']],
  ['COMMONTABLEEXPR', ['ctename', 'ctecolnames']],
  ['RANGETBLENTRY', ['rtekind', 'alias']],
  ['ALIAS', ['aliasname']]
])

/** Whether a node of the walk carries every field this reader needs of its type. */
function hasRequiredFields(node: Extract<Dumped, { kind: 'node' }>): boolean {
  const required = REQUIRED_NODE_FIELDS.get(node.type)
  if (required === undefined) return true
  for (const field of required) if (!node.fields.has(field)) return false
  return true
}

/** Everything this reader takes from a view's stored tree. */
export interface ViewTree {
  /** Whether the whole tree parsed. `false` means none of the rest is trusted. */
  ok: boolean
  /** CTE name → its column names in select-list order. */
  cteColumns: Map<string, string[]>
  /** CTE names the tree defines at more than one query level, so the plan cannot tell them apart. */
  cteAmbiguous: Set<string>
  /** View column position → the base relation oid and attribute number it came from. */
  treeOrigins: Map<number, TreeOrigin>
  /** Range-table alias → the relation oid it names. */
  relationAliases: Map<string, number>
}

/**
 * Reads a view's whole stored tree. A tree the walk cannot fully place is `ok: false`
 * with every map empty — the caller refuses rather than reading a partial answer.
 */
export function readViewTree(action: string): ViewTree {
  const tree: ViewTree = {
    ok: false,
    cteColumns: new Map(),
    cteAmbiguous: new Set(),
    treeOrigins: new Map(),
    relationAliases: new Map()
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
  walkDumped(root, (node) => {
    for (const cte of nodesOf(node.fields.get('cteList'))) {
      if (cte.kind !== 'node') continue
      const name = textOf(cte.fields.get('ctename'))
      const names = stringsOf(cte.fields.get('ctecolnames'))
      if (name === null || names.length === 0) continue
      if (tree.cteColumns.has(name)) {
        tree.cteAmbiguous.add(name)
        continue
      }
      tree.cteColumns.set(name, names)
    }
  })
  for (const name of tree.cteAmbiguous) tree.cteColumns.delete(name)

  for (const [position, entry] of nodesOf(top.fields.get('targetList')).entries()) {
    if (entry.kind !== 'node') continue
    const tableId = numberOf(entry.fields.get('resorigtbl'))
    const attnum = numberOf(entry.fields.get('resorigcol'))
    if (tableId === null || tableId === 0 || attnum === null || attnum === 0) continue
    tree.treeOrigins.set(position, { tableId, attnum })
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
