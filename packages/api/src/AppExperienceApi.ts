import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Document } from "@openbot-build/protocol"
import {
	ConnectionName,
	ConnectionDraft,
	ConnectionId,
} from "./ConnectionsApi.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
export const Entry = Schema.Struct({
	name: ConnectionName,
	cardUrl: Document.Link,
	remoteIndex: Schema.Natural,
})
export const Transfer = Schema.Struct({
	format: Schema.Literal("openbot-apps-v1"),
	apps: Schema.Array(Entry).check(Schema.isMaxLength(30)),
})
export type Transfer = typeof Transfer.Type
export const Imported = Schema.Struct({
	entries: Schema.Array(
		Schema.Struct({
			entry: Entry,
			draft: Schema.NullOr(ConnectionDraft),
			error: Schema.NullOr(Schema.String),
		}),
	),
})
export const Reset = Schema.Struct({
	removed: Schema.Array(ConnectionId),
	pending: Schema.Array(
		Schema.Struct({
			id: ConnectionId,
			name: Schema.String,
			stage: Schema.String,
		}),
	),
})
export type Reset = typeof Reset.Type
export const AppExperienceApi = HttpApiGroup.make("appExperience").add(
	HttpApiEndpoint.get("export", "/v1/app-experience/export", {
		success: Transfer,
		error: ExperienceErrors,
	}),
	HttpApiEndpoint.post("import", "/v1/app-experience/import", {
		payload: Transfer,
		success: Imported,
		error: ExperienceErrors,
	}),
	HttpApiEndpoint.post("reset", "/v1/app-experience/reset", {
		success: Reset,
		error: ExperienceErrors,
	}),
)
