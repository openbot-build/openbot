import { Schema } from "effect"

/**
 * The `limit` query parameter of a list: the most items in one page. It is a
 * whole number from 1 to `maximum`.
 */
export const Limit = (maximum: number) =>
	Schema.FiniteFromString.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum }),
	)
