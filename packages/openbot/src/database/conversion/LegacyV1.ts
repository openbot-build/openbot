import { Schema } from "effect"

/** Stored forms at 2a123ff. These codecs do not follow the current HTTP contract. */
export const source = "openbot/2a123ff"
const id = Schema.NonEmptyString
export const Reminder = Schema.Struct({
	id,
	userId: Schema.String,
	author: id,
	chat: id,
	turn: id,
	toolCallId: Schema.String,
	note: Schema.String,
	createdAt: Schema.Finite,
	dueAt: Schema.Finite,
	status: Schema.Literals(["waiting", "done", "cancelled"]),
})
export const Confession = Schema.Struct({
	id: Schema.String,
	chat: id,
	turn: id,
	text: Schema.String,
	reply: Schema.String,
	at: Schema.Finite,
})
export const Enrichment = Schema.Struct({
	chat: id,
	turn: id,
	text: Schema.String,
	original: Schema.optional(Schema.String),
	entries: Schema.Array(Schema.String),
	at: Schema.Finite,
})
export const MemoryLog = Schema.Struct({
	bot: id,
	entry: Schema.Struct({
		version: Schema.Natural,
		at: Schema.Finite,
		by: Schema.Literals(["memory_bot", "person", "promotion"]),
		ids: Schema.Array(Schema.String),
		reason: Schema.optionalKey(Schema.String),
	}),
})
export const MemorySources = Schema.Array(
	Schema.Union([
		Schema.Struct({ chat: id, item: id }),
		Schema.Struct({ entry: Schema.String }),
	]),
)
export const MemoryContent = Schema.NonEmptyString
export const Owner = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String]),
)

/** These are the opened values of old sealed fields, before any current domain checks. */
export const SecretCredentials = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("onepassword"), url: id, token: id }),
	Schema.Struct({
		kind: Schema.Literal("bitwarden"),
		url: id,
		token: Schema.optionalKey(id),
	}),
	Schema.Struct({
		kind: Schema.Literal("hashicorp"),
		url: id,
		token: id,
		mount: Schema.optionalKey(Schema.String),
		namespace: Schema.optionalKey(Schema.String),
	}),
])
export const VaultValues = Schema.Record(Schema.String, Schema.String)
export const VaultSource = Schema.TaggedUnion({
	Builtin: {},
	OnePassword: { provider: id, vault: id, item: id },
	Bitwarden: { provider: id, item: id },
	HashiCorp: { provider: id, path: id },
})
export const VaultExits = Schema.Array(
	Schema.TaggedStruct("App", {
		connection: id,
		tool: Schema.NullOr(Schema.String),
	}),
)
export const PlatformSecrets = Schema.Struct({
	authSecret: id,
	identityProvider: Schema.NullOr(
		Schema.Struct({ clientSecret: Schema.NullOr(id) }),
	),
	files: Schema.optionalKey(
		Schema.Struct({
			storage: Schema.NullOr(Schema.Struct({ secretAccessKey: id })),
		}),
	),
})
export const ComputerCredentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("e2b"),
		apiKey: id,
		apiUrl: Schema.optionalKey(id),
		sandboxDomain: Schema.optionalKey(id),
	}),
	Schema.Struct({
		kind: Schema.Literal("daytona"),
		apiKey: id,
		apiUrl: Schema.optionalKey(id),
		target: Schema.optionalKey(id),
	}),
])
