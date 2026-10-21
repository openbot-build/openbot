import { Session, SessionStore } from "@openbot-build/core"
import type { Effect, Schema } from "effect"
import type { LanguageModel } from "effect/ai"
import type * as Memory from "./Memory.ts"

export type Store = Pick<
	SessionStore.Store<Memory.Values>,
	"read" | "modifyEffect"
>
export type Error =
	Session.RuntimeError | Schema.SchemaError | Memory.MemoryError
export interface Operations {
	readonly read: (
		session: Session.Id,
	) => Effect.Effect<
		Memory.State,
		Session.SessionNotFound | SessionStore.SessionStoreError
	>
	readonly update: (
		base: Session.Position,
		command: Memory.Edit,
	) => Effect.Effect<Session.View<Memory.Values>, Error>
	readonly consolidate: (
		session: Session.Id,
	) => Effect.Effect<
		Session.View<Memory.Values>,
		Session.RuntimeError | Memory.MemoryError,
		LanguageModel.LanguageModel
	>
}
