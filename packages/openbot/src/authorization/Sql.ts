import { Condition } from "@nmnmcc/ability"
import {
	type AnyColumn,
	and,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm"
import { Effect } from "effect"

/**
 * Changes a residual condition into a SQL condition for drizzle. `columns`
 * gives the column of each field of the resource. A field with no column is
 * a mistake in the code, so it is a defect.
 *
 * A test with `null` follows the meaning of the condition, not of SQL: `ne`
 * is true when the column is `NULL`, so it uses `IS DISTINCT FROM`.
 */
export const toWhere = (
	condition: Condition.Any,
	columns: Readonly<Record<string, AnyColumn>>,
): Effect.Effect<SQL> => {
	const column = (field: string) => columns[field]!
	const missing = Condition.fields(condition).filter(
		(field) => columns[field] === undefined,
	)
	if (missing.length > 0)
		return Effect.die(
			new Error(`No column for the fields ${missing.join(", ")}`),
		)
	return Condition.fold<SQL>(condition, {
		true: () => sql`TRUE`,
		false: () => sql`FALSE`,
		compare: (op, field, value) => {
			const target = column(field)
			if (value === null)
				return op === "eq"
					? isNull(target)
					: op === "ne"
						? isNotNull(target)
						: sql`FALSE`
			switch (op) {
				case "eq":
					return sql`${target} = ${value}`
				case "ne":
					return sql`${target} IS DISTINCT FROM ${value}`
				case "lt":
					return lt(target, value)
				case "lte":
					return lte(target, value)
				case "gt":
					return gt(target, value)
				case "gte":
					return gte(target, value)
			}
		},
		in: (field, values) => {
			const target = column(field)
			const present = values.filter((value) => value !== null)
			const parts = [
				...(present.length > 0 ? [inArray(target, present)] : []),
				...(values.includes(null) ? [isNull(target)] : []),
			]
			return or(...parts) ?? sql`FALSE`
		},
		exists: (field) => isNotNull(column(field)),
		and: (parts) => and(...parts) ?? sql`TRUE`,
		or: (parts) => or(...parts) ?? sql`FALSE`,
		not: (part) => sql`NOT (${part})`,
	}).pipe(Effect.orDie)
}
