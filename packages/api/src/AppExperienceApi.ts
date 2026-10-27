import { AppConnections, Execution } from "@openbot-build/domain"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Document } from "@openbot-build/protocol"
import { ConnectionDraft, ConnectionId } from "./ConnectionsApi.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
export const Entry = Schema.Struct({
	...AppConnections.Entry.fields,
	cardUrl: Document.Link,
})
export const Transfer = Schema.Struct({
	...AppConnections.Transfer.fields,
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
	execution: Execution.Record,
	connections: Schema.Array(
		Schema.Struct({ connectionId: ConnectionId, execution: Execution.Record }),
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
		payload: Schema.Struct({ commandKey: Execution.CommandKey }),
		success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
		error: [...ExperienceErrors, ...ExecutionErrors],
	}),
	HttpApiEndpoint.get("getReset", "/v1/app-experience/resets/:executionId", {
		params: { executionId: Execution.Id },
		success: Reset,
		error: [...ExperienceErrors, ...ExecutionErrors],
	}),
)
