import { Developers } from "@openbot-build/domain"
import { Crypto, Effect, Schema } from "effect"
import { Hex } from "effect/encoding"
import * as Db from "../database/Database.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"

const NoticeIdentity = Schema.fromJsonString(
	Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
)
/** The caller commits a notice with the state that caused it. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const crypto = yield* Crypto.Crypto
	const namespace = yield* IndexNamespace
	/** Post a notice once. The same owner and identity always give the same notice ID. */
	const emit = Effect.fn("DeveloperNotices.emit")(function* (
		owner: string,
		identity: ReadonlyArray<string | number>,
		value: Omit<Developers.Notice, "id" | "readAt">,
	) {
		const text = yield* Schema.encodeEffect(NoticeIdentity)([
			owner,
			...identity,
		]).pipe(Effect.orDie)
		const digest = yield* crypto
			.digest("SHA-256", new TextEncoder().encode(text))
			.pipe(Effect.orDie)
		yield* Rows.postNotice(db, namespace, owner, {
			...value,
			id: Hex.encode(digest),
			readAt: null,
		})
	})

	return { emit }
})
