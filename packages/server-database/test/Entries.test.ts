import { assert, describe, it } from "@effect/vitest"
import * as AuthSchema from "@openbot-build/server-database/AuthSchema"
import * as Schema from "@openbot-build/server-database/Schema"
import { Array as Arr, Record as Rec } from "effect"
import { is, Table } from "drizzle-orm"

// The built entries are what other packages use, so this test reads them by
// the package name and not from the source.
describe("Entries", () => {
	it("every export of the built schema modules is a table", () => {
		const values = Rec.values({ ...Schema, ...AuthSchema })
		assert.isTrue(Arr.isReadonlyArrayNonEmpty(values))
		assert.deepStrictEqual(
			Arr.filter(values, (value) => !is(value, Table)),
			[],
		)
	})
})
