import { Caller } from "@openbot-build/domain"
import { Schema } from "effect"

/** An owner is known even when the old record did not keep the original token. */
export const Owner = Schema.Struct({
	organizationId: Schema.String,
	userId: Schema.String,
})

/** NeedsAuthorization is not a Caller and cannot enter an execution. */
export const Authority = Schema.TaggedUnion({
	Known: { caller: Caller },
	NeedsAuthorization: {
		owner: Owner,
		reason: Schema.Literal("OriginalCallerMissing"),
	},
})
export type Authority = typeof Authority.Type

/** A user ID alone never proves that a session cookie started the work. */
export const missing = (owner: typeof Owner.Type): Authority => ({
	_tag: "NeedsAuthorization",
	owner,
	reason: "OriginalCallerMissing",
})
