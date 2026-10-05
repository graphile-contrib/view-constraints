// Whether a select-list expression can come out NULL, read off the same deparsed
// `Output` entry the origin reader reads (`plan-origins.ts`).
//
// The origin reader answers "which base column is this the value of", and every
// entry that is not a bare reference is a refusal: a `COALESCE`, a `count`, a
// literal is nobody's column. Non-nullness is a different question, and a plain
// view's select list answers a lot of it without any base column at all: a
// literal is never NULL, `count` never is over rows that exist, a `COALESCE`
// with one never-NULL arm never is. So the entry is parsed into the small
// grammar the deparser prints and evaluated bottom-up into one of three
// answers, of which only the first changes anything anywhere:
//
//   'never-null' — no row the plan emits carries NULL in this expression;
//   'nullable'   — the expression can be NULL, proven by its shape;
//   'unknown'    — the shape says nothing; the column stays nullable.
//
// The rules are chosen so that 'never-null' is only ever claimed by a shape
// that cannot produce NULL, and everything else — a function this list does not
// know, a window function, a subscript, a subplan — is 'unknown', never a
// guess. A wrong 'never-null' puts NULL in a non-null GraphQL field and GraphQL
// then nulls the parent object; a missed one only leaves a hand-written tag in
// place.
//
// Nothing here looks at a function's strictness: strictness says "NULL in,
// NULL out" and not one word about non-NULL in. `lower()` over an empty range
// is NULL from a non-NULL argument, which is why a strict function's name gives
// no answer at all, and the only functions with rules are those whose SQL
// definition is the rule: `count` counts rows, `COALESCE` is defined by its
// first non-NULL argument, a complete `CASE` by one of its arms.

/** The answer to "can this expression be NULL". */
export type ExpressionNullability = 'never-null' | 'nullable' | 'unknown'

/** What evaluating an expression needs from whoever is reading the plan. */
export interface ExpressionAsker {
  /**
   * Whether `reference` — an `Output` entry that is a bare column reference —
   * is never NULL where it is read: the origin reader's answer, the base
   * column's `attnotnull` and the plan's own outer joins put together.
   */
  column(reference: string): ExpressionNullability
  /**
   * Whether the node printing this entry groups its input — an `Aggregate` or
   * `Group` with a `Group Key`, no `GROUPING SETS`. A grouping node emits one
   * row per non-empty group, which is what makes `min`/`max`/`sum`/`avg` over
   * a never-NULL column never NULL; over the whole input they answer NULL when
   * the input is empty.
   */
  hasGroupKey: boolean
  /**
   * Whether a user-defined function or operator has taken a built-in spelling
   * (`count`, `+`, …), so the rule that spelling carries does not hold here.
   */
  shadowed(name: string): boolean
}

// ── The grammar the deparser prints ────────────────────────────────────────────
//
// `get_rule_expr` prints a plan expression in a stable shape: keywords and
// `COALESCE`-family spellings upper-case, function names as `pg_proc` spells
// them, string constants quoted with a doubled quote, numeric constants of
// non-integer types quoted and cast (`'0'::numeric`), operators always between
// their operands and parenthesised. The parser below accepts exactly the shapes
// that carry a rule and nothing else: one unexpected token fails the whole
// entry, which the caller reads as 'unknown'.

type Token =
  | { kind: 'identifier'; text: string; quoted: boolean }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'keyword'; text: string }
  | { kind: 'operator'; text: string }
  | { kind: '(' | ')' | ',' | '.' | '[' | ']' | '::' }

const KEYWORDS = new Set([
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'COALESCE',
  'GREATEST',
  'LEAST',
  'NULLIF',
  'NULL',
  // The deparser prints a boolean constant lower-case, unlike every keyword, and
  // the target of an `IS` test in upper case — `b IS TRUE`, `b IS UNKNOWN`.
  'true',
  'false',
  'TRUE',
  'FALSE',
  'UNKNOWN',
  'NOT',
  'AND',
  'OR',
  'IS',
  'DISTINCT',
  'FILTER',
  'OVER',
  'WHERE',
  'FROM'
])

const OPERATOR_CHARACTERS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '|',
  '=',
  '<',
  '>',
  '~',
  '!',
  '@',
  '#',
  '^',
  '&',
  '?'
])

// ── The cast rule ──────────────────────────────────────────────────────────────
//
// A cast is not a shape whose SQL definition is the claim, the way `COALESCE` or
// `count` is: the value it answers is the cast's own, and PostgreSQL lets a cast
// answer NULL for a non-NULL input. `jsonb` to `integer` answers NULL for the
// `jsonb` null, and a `CREATE CAST` whose function returns NULL answers NULL
// wherever it likes. The plan prints the target type by name and says nothing
// about the operand's type, so the pair (source → target) is read off the
// operand's own shape, and a cast is taken for transparent — the operand's answer
// with nothing added — only where both ends are one family PostgreSQL defines to
// answer a value for every input of the other: the exact-number types, and the
// text types. Every other cast, however plainly its operand is never NULL, may
// answer NULL, and there the column is nullable.
const EXACT_TYPE_NAMES = new Set(['smallint', 'integer', 'bigint', 'numeric'])
const TEXT_TYPE_NAMES = new Set(['text', 'character varying', 'character'])

/** Which family a type name printed by the deparser belongs to, if either. */
function castTypeFamily(name: string): 'exact' | 'text' | null {
  if (EXACT_TYPE_NAMES.has(name)) return 'exact'
  if (TEXT_TYPE_NAMES.has(name)) return 'text'
  return null
}

/** The family every member shares, or `null` where they do not or none is known. */
function commonFamily(families: readonly ('exact' | 'text' | null)[]): 'exact' | 'text' | null {
  const [first] = families
  if (first === null || first === undefined) return null
  return families.every((family) => family === first) ? first : null
}

/** The family of a constant: its own type, or the last cast's where it carries one. */
function literalFamily(token: Token, target: string | undefined): LiteralFamily {
  if (token.kind === 'number') return 'exact'
  // A string constant is text unless a cast names another type.
  return target === undefined ? 'text' : (castTypeFamily(target) ?? 'unknown')
}

/**
 * The family an expression's value is of, as far as its shape says — nothing where
 * the shape does not say (a column reference, whose type is the catalog's answer
 * and not the plan's). Used only to read the cast around it.
 */
function operandTypeFamily(node: ExpressionNode, ask: ExpressionAsker): 'exact' | 'text' | null {
  switch (node.kind) {
    case 'literal':
      return node.family === 'exact' || node.family === 'text' ? node.family : null
    case 'cast':
      return castTypeFamily(node.target)
    case 'unary':
      return node.operator === 'NOT' ? null : operandTypeFamily(node.operand, ask)
    case 'call': {
      if (node.quoted || ask.shadowed(node.name)) return null
      if (node.name === 'count') return 'exact'
      return commonFamily(node.args.map((argument) => operandTypeFamily(argument, ask)))
    }
    case 'case':
      return commonFamily(
        [...node.arms, ...(node.otherwise === null ? [] : [node.otherwise])].map((arm) =>
          operandTypeFamily(arm, ask)
        )
      )
    case 'chain': {
      if (node.operators.every((operator) => operator === '||')) return 'text'
      if (!node.operators.every((operator) => ['+', '-', '*', '/', '%'].includes(operator))) {
        return null
      }
      return commonFamily(node.operands.map((operand) => operandTypeFamily(operand, ask)))
    }
    default:
      return null
  }
}

function tokenize(entry: string): Token[] | null {
  const tokens: Token[] = []
  let at = 0
  const length = entry.length
  while (at < length) {
    const character = entry[at]
    if (/\s/.test(character)) {
      at += 1
      continue
    }
    if (character === "'") {
      // A string constant, its embedded quotes doubled. The deparser prints
      // every character of the string as it is, newlines included.
      at += 1
      let closed = false
      while (at < length) {
        if (entry[at] === "'") {
          if (entry[at + 1] === "'") {
            at += 2
            continue
          }
          at += 1
          closed = true
          break
        }
        at += 1
      }
      if (!closed) return null
      tokens.push({ kind: 'string' })
      continue
    }
    if (/[0-9]/.test(character)) {
      const start = at
      while (at < length && /[0-9]/.test(entry[at])) at += 1
      if (entry[at] === '.' && /[0-9]/.test(entry[at + 1] ?? '')) {
        at += 1
        while (at < length && /[0-9]/.test(entry[at])) at += 1
      }
      if (entry[at] === 'e' || entry[at] === 'E') {
        let look = at + 1
        if (entry[look] === '+' || entry[look] === '-') look += 1
        if (/[0-9]/.test(entry[look] ?? '')) {
          at = look
          while (at < length && /[0-9]/.test(entry[at])) at += 1
        }
      }
      tokens.push({ kind: 'number' })
      continue
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = at
      while (at < length && /[A-Za-z0-9_$]/.test(entry[at])) at += 1
      const text = entry.slice(start, at)
      tokens.push(
        KEYWORDS.has(text) ? { kind: 'keyword', text } : { kind: 'identifier', text, quoted: false }
      )
      continue
    }
    if (character === '"') {
      const start = at
      at += 1
      while (at < length) {
        if (entry[at] === '"') {
          if (entry[at + 1] === '"') {
            at += 2
            continue
          }
          at += 1
          break
        }
        at += 1
      }
      if (entry[at - 1] !== '"' || at - start < 2) return null
      tokens.push({
        kind: 'identifier',
        text: entry.slice(start + 1, at - 1).replaceAll('""', '"'),
        quoted: true
      })
      continue
    }
    if (entry.slice(at, at + 2) === '::') {
      tokens.push({ kind: '::' })
      at += 2
      continue
    }
    if (
      character === '(' ||
      character === ')' ||
      character === ',' ||
      character === '.' ||
      character === '[' ||
      character === ']'
    ) {
      tokens.push({ kind: character })
      at += 1
      continue
    }
    if (OPERATOR_CHARACTERS.has(character)) {
      const start = at
      while (at < length && OPERATOR_CHARACTERS.has(entry[at])) at += 1
      tokens.push({ kind: 'operator', text: entry.slice(start, at) })
      continue
    }
    // Anything else — a `$` parameter the plan does not print, a bytea
    // constant, whatever a future version spells — is not a shape with a rule.
    return null
  }
  return tokens
}

type ExpressionNode =
  /** A fragment the parser could not read; its bounds are known and its content is not. */
  | { kind: 'opaque' }
  /** A constant, `family` a coarse reading of its type for the cast rule below. */
  | { kind: 'literal'; family: LiteralFamily }
  | { kind: 'null' }
  | { kind: 'reference'; text: string }
  | {
      kind: 'call'
      /** The function name as printed, unquoted only where the deparser left it unquoted. */
      name: string
      quoted: boolean
      args: ExpressionNode[]
      filter: boolean
    }
  | { kind: 'case'; arms: ExpressionNode[]; otherwise: ExpressionNode | null }
  | { kind: 'chain'; operators: string[]; operands: ExpressionNode[] }
  | { kind: 'unary'; operator: string; operand: ExpressionNode }
  /** `x IS [NOT] NULL` and `x IS [NOT] TRUE/FALSE/UNKNOWN`: a boolean either way. */
  | { kind: 'is-test' }
  /** `a IS [NOT] DISTINCT FROM b`: a boolean whatever the operands are. */
  | { kind: 'is-distinct-from' }
  /** `expr::type`. The value may be NULL whatever the operand is; see `evaluate`. */
  | { kind: 'cast'; operand: ExpressionNode; target: string }

/** A coarse reading of a value's type, for the cast rule and nothing else. */
type LiteralFamily = 'exact' | 'text' | 'boolean' | 'unknown'

class Parser {
  private readonly tokens: Token[]
  private at = 0

  private failed = false

  constructor(entry: string) {
    this.tokens = tokenize(entry) ?? []
    if (this.tokens.length === 0) this.failed = true
  }

  private peek(): Token | undefined {
    return this.tokens[this.at]
  }

  private isKeyword(text: string): boolean {
    const token = this.peek()
    return token?.kind === 'keyword' && token.text === text
  }

  private isPunctuation(kind: '(' | ')' | ',' | '.' | '[' | ']' | '::'): boolean {
    const token = this.peek()
    return token?.kind === kind
  }

  /**
   * The end of an operand that could not be parsed: the first `,` or `)` at the
   * depth the operand started at, or the keyword that structurally follows one.
   * The fragment up to there is opaque — present, bounded, unread — rather than a
   * failure of the whole entry: an unreadable argument of a `COALESCE` whose next
   * arm is a literal still answers never-NULL, and that answer is the reader's to
   * give wherever the planner prints the expression from.
   */
  private skipToOperandEnd(): ExpressionNode {
    let depth = 0
    for (;;) {
      const token = this.peek()
      if (token === undefined) throw new ExpressionParseError()
      if (depth === 0) {
        if (token.kind === ',' || token.kind === ')') break
        if (
          token.kind === 'keyword' &&
          ['THEN', 'ELSE', 'WHEN', 'END', 'FILTER', 'OVER', 'WHERE', 'FROM', 'AND', 'OR'].includes(
            token.text
          )
        ) {
          break
        }
      }
      if (token.kind === '(') depth += 1
      if (token.kind === ')') depth -= 1
      this.at += 1
    }
    return { kind: 'opaque' }
  }

  private take(): Token {
    const token = this.tokens[this.at]
    if (token === undefined) throw new ExpressionParseError()
    this.at += 1
    return token
  }

  private takeKeyword(text: string): void {
    if (!this.isKeyword(text)) throw new ExpressionParseError()
    this.at += 1
  }

  private takePunctuation(kind: '(' | ')' | ',' | '.' | '[' | ']' | '::'): void {
    if (!this.isPunctuation(kind)) throw new ExpressionParseError()
    this.at += 1
  }

  /** One `::type` suffix, its name as complex as `character varying(4)[]`. */
  private takeCast(): string {
    this.takePunctuation('::')
    const words: string[] = []
    for (;;) {
      const token = this.peek()
      if (token?.kind !== 'identifier') break
      // A type name runs on in identifiers — `double precision`, `timestamp with
      // time zone` — and so does an aggregate's `ORDER BY` that follows a cast
      // argument; `ORDER` followed by `BY` is that and never part of a type.
      const next = this.tokens[this.at + 1]
      if (
        token.text.toLowerCase() === 'order' &&
        next?.kind === 'identifier' &&
        next.text.toLowerCase() === 'by'
      ) {
        break
      }
      this.at += 1
      words.push(token.quoted ? token.text : token.text.toLowerCase())
      if (this.isPunctuation('(')) {
        this.at += 1
        for (;;) {
          if (this.peek()?.kind !== 'number') throw new ExpressionParseError()
          this.at += 1
          if (this.isPunctuation(',')) {
            this.at += 1
            continue
          }
          break
        }
        this.takePunctuation(')')
      }
    }
    if (words.length === 0) throw new ExpressionParseError()
    while (this.isPunctuation('[')) {
      this.at += 1
      this.takePunctuation(']')
    }
    return words.join(' ')
  }

  /** Every `::type` suffix in a row, outermost last, as the type names printed. */
  private takeCasts(): string[] {
    const targets: string[] = []
    while (this.isPunctuation('::')) targets.push(this.takeCast())
    return targets
  }

  /** `cast(c…(operand))` for the suffixes taken, innermost first, operand unchanged if none. */
  private wrapCasts(operand: ExpressionNode, targets: readonly string[]): ExpressionNode {
    let node = operand
    for (const target of targets) node = { kind: 'cast', operand: node, target }
    return node
  }

  private parseArguments(): { args: ExpressionNode[]; filter: boolean } {
    this.takePunctuation('(')
    const args: ExpressionNode[] = []
    let filter = false
    // `*` is multiplication between operands and the whole-argument mark only as
    // a call's sole argument, so it is one operator token told apart by place.
    const star = this.peek()
    const starAlone =
      star?.kind === 'operator' && star.text === '*' && this.tokens[this.at + 1]?.kind === ')'
    // `ORDER BY x` inside an aggregate call; `BY` is not a keyword the grammar
    // reserves, so the pair is read as it is printed: two identifiers in a row.
    const order = (): boolean => {
      const first = this.peek()
      const second = this.tokens[this.at + 1]
      if (
        first?.kind === 'identifier' &&
        first.text.toLowerCase() === 'order' &&
        second?.kind === 'identifier' &&
        second.text.toLowerCase() === 'by'
      ) {
        this.at += 2
        return true
      }
      return false
    }
    if (starAlone) {
      this.at += 1
    } else {
      if (this.isKeyword('DISTINCT')) this.at += 1
      for (;;) {
        args.push(this.parseExpression())
        if (this.isPunctuation(',')) {
          this.at += 1
          continue
        }
        break
      }
      if (order()) {
        for (;;) {
          this.parseExpression()
          if (this.isPunctuation(',')) {
            this.at += 1
            continue
          }
          break
        }
      }
    }
    this.takePunctuation(')')
    if (this.isKeyword('FILTER')) {
      // `FILTER (WHERE …)`: the condition says which rows the aggregate sees,
      // and a group whose every row it drops makes the aggregate NULL — so the
      // presence of the clause is read and the condition itself is not.
      this.at += 1
      this.takePunctuation('(')
      this.takeKeyword('WHERE')
      this.parseExpression()
      this.takePunctuation(')')
      filter = true
    }
    if (this.isKeyword('OVER')) {
      // A window function: its aggregate runs per input row over a frame that
      // may be empty — `lead` of one row is NULL — and the frame is not in the
      // expression. Not a shape with a rule.
      throw new ExpressionParseError()
    }
    return { args, filter }
  }

  private parseCase(): ExpressionNode {
    this.takeKeyword('CASE')
    if (!this.isKeyword('WHEN')) this.parseExpression() // the simple form's operand
    const arms: ExpressionNode[] = []
    let otherwise: ExpressionNode | null = null
    for (;;) {
      if (this.isKeyword('WHEN')) {
        this.at += 1
        this.parseExpression() // the condition, whichever form the `CASE` takes
        this.takeKeyword('THEN')
        arms.push(this.parseExpression())
        continue
      }
      if (this.isKeyword('ELSE')) {
        this.at += 1
        otherwise = this.parseExpression()
        continue
      }
      break
    }
    this.takeKeyword('END')
    return { kind: 'case', arms, otherwise }
  }

  private parseOperand(): ExpressionNode {
    try {
      return this.parseOperandStrict()
    } catch (error) {
      if (!(error instanceof ExpressionParseError)) throw error
      // Whatever the operand turned out to be, it ends where an operand ends, and
      // the expression around it goes on: one unreadable fragment is not a verdict
      // on the whole entry.
      return this.skipToOperandEnd()
    }
  }

  private parseOperandStrict(): ExpressionNode {
    if (this.isPunctuation('(')) {
      this.at += 1
      const inner = this.parseExpression()
      this.takePunctuation(')')
      return this.wrapCasts(inner, this.takeCasts())
    }
    const token = this.peek()
    if (token === undefined) throw new ExpressionParseError()
    if (token.kind === 'string' || token.kind === 'number') {
      this.at += 1
      const targets = this.takeCasts()
      // A constant is a constant however it is cast — the planner folds a cast of
      // one — so `'0'::numeric` and `'usdt'::text` are values, never NULL. The
      // target of the last cast, where there is one, is the constant's type.
      return { kind: 'literal', family: literalFamily(token, targets.at(-1)) }
    }
    if (token.kind === 'keyword') {
      if (token.text === 'NULL') {
        this.at += 1
        this.takeCasts()
        return { kind: 'null' }
      }
      if (token.text === 'true' || token.text === 'false') {
        this.at += 1
        this.takeCasts()
        return { kind: 'literal', family: 'boolean' }
      }
      if (token.text === 'NOT') {
        this.at += 1
        const operand = this.parseOperand()
        return { kind: 'unary', operator: 'NOT', operand }
      }
      if (token.text === 'CASE') return this.parseCase()
      if (
        token.text === 'COALESCE' ||
        token.text === 'GREATEST' ||
        token.text === 'LEAST' ||
        token.text === 'NULLIF'
      ) {
        const name = token.text
        this.at += 1
        const { args, filter } = this.parseArguments()
        return this.wrapCasts({ kind: 'call', name, quoted: false, args, filter }, this.takeCasts())
      }
      throw new ExpressionParseError()
    }
    if (token.kind === 'operator' && (token.text === '-' || token.text === '+')) {
      this.at += 1
      const operand = this.parseOperand()
      return { kind: 'unary', operator: token.text, operand }
    }
    if (token.kind === 'identifier') {
      this.at += 1
      if (this.isPunctuation('(')) {
        const { args, filter } = this.parseArguments()
        return this.wrapCasts(
          { kind: 'call', name: token.text, quoted: token.quoted, args, filter },
          this.takeCasts()
        )
      }
      // `alias.column` is as far as a column reference goes; `alias.*` is a
      // whole row and `alias.column[1]` a subscript, neither a bare reference.
      const names: { text: string; quoted: boolean }[] = [
        { text: token.text, quoted: token.quoted }
      ]
      while (this.isPunctuation('.')) {
        this.at += 1
        const part = this.take()
        if (part.kind !== 'identifier') throw new ExpressionParseError()
        names.push({ text: part.text, quoted: part.quoted })
      }
      if (names.length > 2) throw new ExpressionParseError()
      if (this.isPunctuation('[')) throw new ExpressionParseError()
      const text = names
        .map((part) => (part.quoted ? `"${part.text.replaceAll('"', '""')}"` : part.text))
        .join('.')
      return this.wrapCasts({ kind: 'reference', text }, this.takeCasts())
    }
    throw new ExpressionParseError()
  }

  /**
   * One operand with whatever `IS …` suffix follows it. The suffixes are
   * boolean however the operand comes out — even `NULL IS NULL` is `true`, and
   * `IS [NOT] DISTINCT FROM` never returns NULL — so they are shapes with a
   * rule after all.
   */
  private parseOperandWithIs(): ExpressionNode {
    const operand = this.parseOperand()
    if (!this.isKeyword('IS')) return operand
    this.at += 1
    let negated = false
    if (this.isKeyword('NOT')) {
      this.at += 1
      negated = true
    }
    if (this.isKeyword('DISTINCT')) {
      this.at += 1
      this.takeKeyword('FROM')
      this.parseOperand()
      return { kind: 'is-distinct-from' }
    }
    if (
      this.isKeyword('NULL') ||
      this.isKeyword('TRUE') ||
      this.isKeyword('FALSE') ||
      this.isKeyword('UNKNOWN')
    ) {
      this.at += 1
      return this.wrapCasts({ kind: 'is-test' }, this.takeCasts())
    }
    throw new ExpressionParseError()
  }

  parseExpression(): ExpressionNode {
    const first = this.parseOperandWithIs()
    const operators: string[] = []
    const operands: ExpressionNode[] = [first]
    for (;;) {
      const token = this.peek()
      const operator =
        token?.kind === 'operator'
          ? token.text
          : token?.kind === 'keyword' && (token.text === 'AND' || token.text === 'OR')
            ? token.text
            : null
      if (operator === null) break
      this.at += 1
      operators.push(operator)
      operands.push(this.parseOperandWithIs())
    }
    if (operators.length === 0) return first
    return { kind: 'chain', operators, operands }
  }

  parse(): ExpressionNode | null {
    if (this.failed) return null
    try {
      const expression = this.parseExpression()
      if (this.at !== this.tokens.length) return null
      return expression
    } catch {
      return null
    }
  }
}

class ExpressionParseError extends Error {}

/**
 * Parses one `Output` entry into the expression shapes that carry a
 * non-nullness rule. `null` where the entry is anything else — a subplan
 * reference, a window function, a subscript, a whole-row reference — and the
 * caller reads that as 'unknown'.
 */
export function parseExpression(entry: string): ExpressionNode | null {
  return new Parser(entry).parse()
}

// ── The rules ──────────────────────────────────────────────────────────────────

// The `min`/`max`/`sum`/`avg` of SQL answer NULL over an empty input, and a
// value otherwise — so over a never-NULL column they are never NULL exactly
// when every row the node emits stands for a non-empty group of input rows,
// which is what a `Group Key` says and nothing else in the plan does. `count`
// is the one aggregate SQL defines over the rows themselves: it answers 0, not
// NULL, whatever it is given.
const GROUP_ANSWERING_AGGREGATES = new Set(['min', 'max', 'sum', 'avg'])
const NEVER_NULL_AGGREGATES = new Set(['count'])

// `COALESCE` is its first non-NULL argument; `GREATEST` and `LEAST` skip NULL
// the same way and answer NULL only when every argument is NULL. `NULLIF`
// answers NULL whenever its two arguments compare equal — a complete
// non-nullness no argument list can repair.
const FIRST_NON_NULL = new Set(['COALESCE', 'GREATEST', 'LEAST'])

// Operators that never return NULL over operands that are never NULL. Every
// built-in operator spelled `+ - * / %` is a strict numeric routine that
// returns a value or raises — never NULL; every built-in `= <> < <= > >=` is a
// strict comparison that answers a boolean; `||` builds a non-NULL string or
// array out of two non-NULL values whichever of its several implementations
// runs. `AND`, `OR` and `NOT` are keywords rather than operators, so no user
// definition can take the spelling, and over non-NULL operands they answer
// true or false. A user-defined operator that takes one of the operator
// spellings — a shadow a keyword cannot have — makes the spelling stand down
// for the whole reading, the same stand-down `plan-qualifiers.ts` takes over a
// non-strict `=`.
const NEVER_NULL_OPERATORS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  '=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  'AND',
  'OR'
])

function combineOperands(states: ExpressionNullability[]): ExpressionNullability {
  if (states.some((state) => state === 'nullable')) return 'nullable'
  if (states.every((state) => state === 'never-null')) return 'never-null'
  return 'unknown'
}

function evaluate(node: ExpressionNode, ask: ExpressionAsker): ExpressionNullability {
  switch (node.kind) {
    case 'opaque':
      return 'unknown'
    case 'literal':
      return 'never-null'
    case 'null':
      return 'nullable'
    case 'reference':
      return ask.column(node.text)
    case 'is-test':
    case 'is-distinct-from':
      return 'never-null'
    case 'cast': {
      const operand = evaluate(node.operand, ask)
      // A cast adds nothing to a nullable operand's answer: it stays nullable.
      if (operand !== 'never-null') return operand
      const target = castTypeFamily(node.target)
      if (target !== null && target === operandTypeFamily(node.operand, ask)) return 'never-null'
      return 'nullable'
    }
    case 'unary':
      // `-x` and `NOT x` answer NULL exactly when `x` does: negation of a
      // value is a value, and of a boolean a boolean.
      return evaluate(node.operand, ask)
    case 'call': {
      if (node.quoted || ask.shadowed(node.name)) return 'unknown'
      if (node.name === 'NULLIF') return 'nullable'
      if (FIRST_NON_NULL.has(node.name)) {
        const states = node.args.map((argument) => evaluate(argument, ask))
        if (states.some((state) => state === 'never-null')) return 'never-null'
        if (states.every((state) => state === 'nullable')) return 'nullable'
        return 'unknown'
      }
      if (NEVER_NULL_AGGREGATES.has(node.name)) return 'never-null'
      if (GROUP_ANSWERING_AGGREGATES.has(node.name)) {
        if (node.filter) return 'nullable'
        const argument = node.args[0]
        if (!argument) return 'unknown'
        const state = evaluate(argument, ask)
        if (state !== 'never-null') return state
        return ask.hasGroupKey ? 'never-null' : 'nullable'
      }
      return 'unknown'
    }
    case 'case': {
      if (node.otherwise === null) return 'nullable'
      return combineOperands([...node.arms, node.otherwise].map((arm) => evaluate(arm, ask)))
    }
    case 'chain': {
      const known = node.operators.every(
        (operator) => NEVER_NULL_OPERATORS.has(operator) && !ask.shadowed(operator)
      )
      if (!known) return 'unknown'
      return combineOperands(node.operands.map((operand) => evaluate(operand, ask)))
    }
  }
}

/**
 * Evaluates one parsed entry to an answer. A `null` node is not an answer:
 * 'unknown' is, and it is what everything unrecognised reads as.
 */
export function evaluateExpression(
  node: ExpressionNode | null,
  ask: ExpressionAsker
): ExpressionNullability {
  if (node === null) return 'unknown'
  return evaluate(node, ask)
}
