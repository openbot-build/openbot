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
import { Array as Arr, Effect } from "effect"

/**
 * Changes a residual condition into a SQL condition for drizzle. `columns`
 * gives the column of each field of the resource. A field with no column is
 * a mistake in the code, so it is a defect.
 *
 * A leaf always returns true or false. SQL NULL must not change the result of
 * a later NOT: a shared resource has no member owner, but it can still match
 * a negated owner condition.
 */
export const toWhere = (
	condition: Condition.Any,
	columns: Readonly<Record<string, AnyColumn | SQL>>,
): Effect.Effect<SQL> => {
	const column = (field: string) => sql`${columns[field]!}`
	const missing = Arr.filter(
		Condition.fields(condition),
		(field) => columns[field] === undefined,
	)
	if (missing.length > 0)
		return Effect.die(
			new Error(`No column for the fields ${Arr.join(missing, ", ")}`),
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
					return sql`${target} IS NOT DISTINCT FROM ${value}`
				case "ne":
					return sql`${target} IS DISTINCT FROM ${value}`
				case "lt":
					return sql`coalesce(${lt(target, value)}, FALSE)`
				case "lte":
					return sql`coalesce(${lte(target, value)}, FALSE)`
				case "gt":
					return sql`coalesce(${gt(target, value)}, FALSE)`
				case "gte":
					return sql`coalesce(${gte(target, value)}, FALSE)`
			}
		},
		in: (field, values) => {
			const target = column(field)
			const present = Arr.filter(values, (value) => value !== null)
			const parts = [
				...(present.length > 0
					? [sql`coalesce(${inArray(target, present)}, FALSE)`]
					: []),
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
