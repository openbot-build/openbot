import { Developers } from "@openbot-build/domain"
import { Effect, Schema } from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
import * as Db from "@openbot-build/server-database/Database"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "../apps-contract/apps/IndexNamespace.ts"

const NoticeIdentity = Schema.fromJsonString(
	Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
)
/** The caller commits a notice with the state that caused it. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const crypto = yield* Digest.Digest
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
			.digest(Digest.sha256, new TextEncoder().encode(text))
			.pipe(Effect.orDie)
		yield* Rows.postNotice(db, namespace, owner, {
			...value,
			id: Hex.encode(digest),
			readAt: null,
		})
	})

	return { emit }
})
