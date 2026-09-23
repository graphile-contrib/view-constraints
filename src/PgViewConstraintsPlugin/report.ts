// Renders what `PgViewConstraintsPlugin` derives beside what a service's views
// declare by hand, from the report a non-declaring instance of the plugin hands over.
//
// The comparison runs inside a real `makeSchema`, so the hand-written side is the
// merged smart tags PostGraphile itself sees — tag plugins and SQL `COMMENT`s alike —
// rather than a second reading of whatever wrote them. `reportingPreset` swaps the
// declaring instance out for a reporting one, so nothing derived reaches the schema.

import type {} from 'postgraphile'
import { foreignKeyReference, PgViewConstraintsPlugin } from './index.ts'
import type { ViewConstraintsReport } from './index.ts'
import { COLUMN_REFUSALS, PLAN_REFUSALS } from './plan-origins.ts'
import type { ColumnRefusal, PlanRefusal } from './plan-origins.ts'
import { TARGET_REFUSALS } from './derive.ts'
import type { TargetRefusal } from './derive.ts'

type Refusal = PlanRefusal | ColumnRefusal | TargetRefusal

/**
 * `preset` with its `PgViewConstraintsPlugin` replaced by one that declares nothing
 * and hands its report to `onReport` instead, so that the hand-written side of the
 * comparison is the tags a human wrote rather than the tags the declaring instance
 * would have added to them.
 */
export function reportingPreset(
  preset: GraphileConfig.Preset,
  onReport: (report: ViewConstraintsReport) => void
): GraphileConfig.Preset {
  return {
    ...preset,
    plugins: [
      ...(preset.plugins ?? []).filter((plugin) => plugin.name !== 'PgViewConstraintsPlugin'),
      PgViewConstraintsPlugin({ report: onReport })
    ]
  }
}

function tail(tag: string): string {
  const [, ...rest] = tag.split('|')
  return rest.join('|')
}

/** The `@notNull` tally of one surface, and the names behind its worrying third. */
interface NotNullTally {
  /** Hand-written `@notNull` the derivation confirms. */
  confirmed: number
  /** Derived where no hand tag stands. */
  derivedOnly: number
  /** Hand-written `@notNull` the derivation does not reach, `schema.view.column`. */
  handOnly: string[]
}

function renderService(
  title: string,
  report: ViewConstraintsReport,
  census: Map<Refusal, number>,
  line: (text?: string) => void
): NotNullTally {
  const tally: NotNullTally = { confirmed: 0, derivedOnly: 0, handOnly: [] }
  line(`\n════ ${title} (schemas: ${report.schemas.length})`)
  for (const failure of report.failures) {
    line(
      `  !! ${failure.schema}.${failure.view} (relkind ${failure.relkind}): EXPLAIN refused: ${failure.error}`
    )
  }
  for (const skip of report.skipped) {
    line(`  ?? ${skip.schema}.${skip.view} (relkind ${skip.relkind}): not planned: ${skip.reason}`)
  }
  for (const view of report.views) {
    const { derived } = view
    const derivedKeys = new Map(
      derived.foreignKeys.map((foreignKey) => [foreignKeyReference(foreignKey.tag), foreignKey])
    )
    const declaredKeys = new Map(
      view.declaredForeignKeys.map((tag) => [foreignKeyReference(tag), tag])
    )
    const derivedNotNull = new Set(derived.notNullColumns)
    const declaredNotNull = new Set(view.declaredNotNullColumns)
    const interesting =
      derivedKeys.size > 0 ||
      declaredKeys.size > 0 ||
      derived.primaryKey !== null ||
      view.declaredPrimaryKey !== null ||
      derivedNotNull.size > 0 ||
      declaredNotNull.size > 0 ||
      derived.origins === null
    if (!interesting) continue

    line(
      `\n  ── ${derived.schema}.${derived.view}${derived.relkind === 'm' ? '  (materialized)' : ''}`
    )
    if (derived.origins === null) {
      line('     plan: not readable positionally — nothing derived')
    }
    for (const [key, foreignKey] of derivedKeys) {
      const marker = declaredKeys.has(key) ? 'both  ' : 'DERIVED-ONLY'
      const via = foreignKey.via
        .map((entry) => `${entry.schema}.${entry.relation} ${entry.constraintName}`)
        .join(' + ')
      line(`     fk ${marker} ${foreignKey.tag}   [via ${via}]`)
      const declared = declaredKeys.get(key)
      if (declared && tail(declared)) line(`        hand tail: |${tail(declared)}`)
    }
    for (const [key, tag] of declaredKeys) {
      if (derivedKeys.has(key)) continue
      line(`     fk HAND-ONLY   ${tag}`)
    }
    const derivedPk = derived.primaryKey
    if (derivedPk) {
      const same = view.declaredPrimaryKey === derivedPk.tag
      line(
        `     pk ${same ? 'both  ' : 'DERIVED-ONLY'} ${derivedPk.tag}   [${derivedPk.via ? `via ${derivedPk.via.schema}.${derivedPk.via.relation} ${derivedPk.via.constraintName}` : 'made by the plan'}]`
      )
    }
    if (view.declaredPrimaryKey && view.declaredPrimaryKey !== derivedPk?.tag) {
      line(`     pk HAND-ONLY   ${view.declaredPrimaryKey}`)
    }
    // The three ways a column's non-nullness can stand. The third is the one to read:
    // either the derivation is too weak to see what the author saw, or the hand tag
    // promises a non-nullness the structure does not give.
    const both = [...declaredNotNull].filter((column) => derivedNotNull.has(column))
    const derivedOnly = [...derivedNotNull].filter((column) => !declaredNotNull.has(column))
    const handOnly = [...declaredNotNull].filter((column) => !derivedNotNull.has(column))
    tally.confirmed += both.length
    tally.derivedOnly += derivedOnly.length
    if (both.length > 0) line(`     nn both         ${both.join(', ')}`)
    if (derivedOnly.length > 0) line(`     nn DERIVED-ONLY ${derivedOnly.join(', ')}`)
    if (handOnly.length > 0) {
      line(`     nn HAND-ONLY    ${handOnly.join(', ')}`)
      for (const column of handOnly) {
        tally.handOnly.push(`${derived.schema}.${derived.view}.${column}`)
      }
    }
    for (const note of derived.notes) line(`     note: ${note}`)
  }
  for (const declaration of report.unexamined) {
    line(
      `\n  ── ${declaration.schema}.${declaration.relation}  (relkind ${declaration.relkind}, never examined: ${declaration.reason})`
    )
    for (const tag of declaration.declaredForeignKeys) line(`     fk HAND-ONLY   ${tag}`)
    if (declaration.declaredPrimaryKey) {
      line(`     pk HAND-ONLY   ${declaration.declaredPrimaryKey}`)
    }
    if (declaration.declaredNotNullColumns.length > 0) {
      line(`     nn HAND-ONLY    ${declaration.declaredNotNullColumns.join(', ')}`)
      for (const column of declaration.declaredNotNullColumns) {
        tally.handOnly.push(`${declaration.schema}.${declaration.relation}.${column}`)
      }
    }
  }
  // The census: every relation this surface asked about, said out loud whether it is
  // interesting or not. "Nothing was derived" and "nothing was looked at" are
  // different answers, and a view that derives nothing has to say which of the closed
  // list of refusals it is.
  line('\n  ── census')
  for (const view of report.views) {
    const { derived } = view
    const kind = derived.relkind === 'm' ? 'm' : 'v'
    const refused =
      derived.planRefusal ??
      [...new Set(derived.columnRefusals.filter((refusal) => refusal !== null))].sort().join(' + ')
    // A relation the catalog authorises and this reader did not lead to a projection
    // is the third category of the closed list, and belongs in this line and in the
    // tally below beside the other two.
    const declined = [...new Set(derived.declinedViewTargets.map((target) => target.refusal))]
      .sort()
      .join(' + ')
    const got =
      `${derived.foreignKeys.length} fk` +
      `${derived.primaryKey ? ', pk' : ''}` +
      `, ${derived.notNullColumns.length} nn`
    const read = derived.origins?.filter((sources) => sources !== null).length ?? 0
    line(
      `     ${derived.schema}.${derived.view} [${kind}] ${read}/${derived.columns.length} columns read` +
        ` — ${got}${refused ? ` — refused: ${refused}` : ''}` +
        `${declined ? ` — declined: ${declined}` : ''}`
    )
    for (const refusal of derived.columnRefusals) {
      if (refusal) census.set(refusal, (census.get(refusal) ?? 0) + 1)
    }
    if (derived.planRefusal) {
      census.set(derived.planRefusal, (census.get(derived.planRefusal) ?? 0) + 1)
    }
    for (const target of derived.declinedViewTargets) {
      census.set(target.refusal, (census.get(target.refusal) ?? 0) + 1)
    }
  }
  for (const failure of report.failures) {
    line(`     ${failure.schema}.${failure.view} [${failure.relkind}] — EXPLAIN refused`)
  }
  for (const skip of report.skipped) {
    line(`     ${skip.schema}.${skip.view} [${skip.relkind}] — not planned`)
  }
  for (const declaration of report.unexamined) {
    line(
      `     ${declaration.schema}.${declaration.relation} [${declaration.relkind}] — ${declaration.reason}`
    )
  }

  line(
    `\n  ── notNull: ${tally.confirmed} hand tags confirmed, ` +
      `${tally.derivedOnly} derived where no hand tag stands, ` +
      `${tally.handOnly.length} hand-only`
  )
  for (const column of tally.handOnly) line(`     hand-only: ${column}`)
  return tally
}

/**
 * Renders the reports of any number of services, then the totals over all of them:
 * the `@notNull` tally and the census of the closed lists of refusals — each of them,
 * including the ones no service takes, which carry their case in the lab instead.
 */
export class ViewConstraintsReportRenderer {
  private readonly census = new Map<Refusal, number>()
  private confirmed = 0
  private derivedOnly = 0
  private readonly handOnly = new Set<string>()

  /** The lines for one service. */
  service(title: string, report: ViewConstraintsReport): string[] {
    const lines: string[] = []
    const tally = renderService(title, report, this.census, (text = '') => lines.push(text))
    this.confirmed += tally.confirmed
    this.derivedOnly += tally.derivedOnly
    for (const column of tally.handOnly) this.handOnly.add(column)
    return lines
  }

  /** The lines over every service rendered so far. */
  totals(): string[] {
    const lines = [
      `\n════ notNull across every service: ${this.confirmed} hand tags confirmed, ` +
        `${this.derivedOnly} derived where no hand tag stands, ` +
        `${this.handOnly.size} distinct hand-only columns`
    ]
    for (const column of [...this.handOnly].sort()) lines.push(`  hand-only: ${column}`)
    lines.push('\n════ why something was not derived, over every service')
    for (const refusal of [
      ...Object.keys(PLAN_REFUSALS),
      ...Object.keys(COLUMN_REFUSALS),
      ...Object.keys(TARGET_REFUSALS)
    ] as Refusal[]) {
      lines.push(`  ${String(this.census.get(refusal) ?? 0).padStart(5)}  ${refusal}`)
    }
    return lines
  }
}
