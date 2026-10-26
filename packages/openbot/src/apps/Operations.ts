import { organizationOf } from "./StoredConnections.ts"
import {
	AppExecution,
	ChatConflict,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Client, McpClient } from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Schema,
} from "effect"
import { failed, fromOperation, json } from "./AppResults.ts"
import { Capabilities } from "./Capabilities.ts"
import type { PgClient } from "@effect/sql-pg"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredInvocations from "./StoredInvocations.ts"
import type { Error } from "./StoredInvocations.ts"
import { Invocations } from "./Invocations.ts"
import { ActionPolicy } from "./ActionPolicy.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

export class Operations extends Context.Service<
	Operations,
	{
		readonly respond: (
			owner: string,
			id: string,
			round: number,
			responses: Schema.JsonObject,
		) => Effect.Effect<AppExecution.Invocation, Error>
	}
>()("@openbot-build/openbot/apps/Operations") {}

export const make: Effect.Effect<
	typeof Operations.Service,
	never,
	Capabilities | PgClient.PgClient | Secrets | Invocations | ActionPolicy
> = Effect.gen(function* () {
	const capabilities = yield* Capabilities
	const db = yield* Db.make
	const secrets = yield* Secrets
	const invocations = yield* Invocations
	const actions = yield* ActionPolicy
	const conflict = () =>
		ChatConflict.make({
			message:
				"This App input request is no longer available or does not match its operation.",
		})
	return Operations.of({
		respond: (owner, id, round, responses) =>
			Effect.scoped(
				Effect.gen(function* () {
					const value = yield* StoredInvocations.get(db, secrets, owner, id)
					const request = yield* Match.value(value.result).pipe(
						Match.when({ _tag: "InputRequired" }, ({ request }) =>
							Schema.decodeUnknownEffect(Schema.JsonObject)(request).pipe(
								Effect.catchTag("SchemaError", () => Effect.fail(conflict())),
							),
						),
						Match.orElse(() => Effect.fail(conflict())),
					)
					if (value.status !== "InputRequired" || value.round !== round)
						return yield* conflict()
					// The read rules changed since the call started, so the old decision no longer holds.
					const readOnly = yield* actions.isRead({
						organizationId: organizationOf(owner),
						source: value.source,
					})
					if (readOnly !== value.readOnly) return yield* conflict()
					const continuation = Match.value(value.source.kind).pipe(
						Match.when(
							"tool",
							() =>
								({
									method: "tools/call",
									params: {
										name: value.source.name,
										arguments: value.arguments,
									},
									request,
								}) as const,
						),
						Match.when(
							"resource",
							() =>
								({
									method: "resources/read",
									params: { uri: value.source.name },
									request,
								}) as const,
						),
						Match.when(
							"template",
							() =>
								({
									method: "resources/read",
									params: {
										uriTemplate: value.source.name,
										values: value.arguments,
									},
									request,
								}) as const,
						),
						Match.when(
							"prompt",
							() =>
								({
									method: "prompts/get",
									params: {
										name: value.source.name,
										arguments: value.arguments,
									},
									request,
								}) as const,
						),
						Match.exhaustive,
					)
					yield* McpClient.validateInputs(continuation, responses).pipe(
						Effect.catchTag("ClientError", () => Effect.fail(conflict())),
					)
					const policy = Client.InvocationPolicy.of({
						check: (invocation) =>
							invocation.connection.owner === owner &&
							invocation.connection.connectionId ===
								value.source.connectionId &&
							(Schema.is(Client.ListAction)(invocation.action) ||
								(invocation.action === continuation.method &&
									(invocation.target === value.source.name ||
										value.source.kind === "template")))
								? Effect.void
								: Effect.fail(
										Client.PermissionDenied.make({
											action: invocation.action,
											target: invocation.target,
										}),
									),
					})
					const opened = yield* capabilities
						.open({ owner, connectionId: value.source.connectionId, policy })
						.pipe(
							Effect.catch((error): Effect.Effect<never, Error> =>
								// A storage failure keeps its meaning. Any other failure means
								// that the App connection can no longer serve this request.
								error._tag === "ExperienceStorageUnavailable" ||
								(error._tag === "StoreError" && error.reason === "Unavailable")
									? Effect.fail(ExperienceStorageUnavailable.make({}))
									: Effect.fail(error).pipe(
											Failures.replace(
												"App connection did not open for an input response",
												conflict,
											),
										),
							),
						)
					if (opened.stored.revision !== value.source.revision)
						return yield* conflict()
					const declaration = Match.value(value.source.kind).pipe(
						Match.when("tool", () =>
							Arr.findFirst(
								opened.tools,
								(tool) => tool.name === value.source.name,
							),
						),
						Match.when("resource", () =>
							Arr.findFirst(
								opened.resources,
								(resource) => resource.uri === value.source.name,
							),
						),
						Match.when("template", () =>
							Arr.findFirst(
								opened.resourceTemplates,
								(template) => template.uriTemplate === value.source.name,
							),
						),
						Match.when("prompt", () =>
							Arr.findFirst(
								opened.prompts,
								(prompt) => prompt.name === value.source.name,
							),
						),
						Match.exhaustive,
					)
					if (
						Option.isNone(declaration) ||
						value.source.definition === undefined ||
						!Schema.toEquivalence(Schema.Json)(
							value.source.definition,
							yield* json(declaration.value).pipe(
								Effect.catchTag("SchemaError", () => Effect.fail(conflict())),
							),
						)
					)
						return yield* conflict()
					yield* invocations.resume(
						owner,
						id,
						opened.client
							.resume(continuation, responses, {
								source: "host",
								readOnly: value.readOnly,
							})
							.pipe(
								Effect.flatMap(fromOperation(value.source)),
								Effect.tapError((error) =>
									Effect.logInfo(
										"An App continuation failed.",
										Cause.fail(error),
									).pipe(
										Effect.annotateLogs({
											connectionId: value.source.connectionId,
											target: value.source.name,
										}),
									),
								),
								Effect.catch((error) =>
									failed({ source: value.source, error }),
								),
								Effect.catch((error) =>
									Effect.logWarning(
										"An App failure could not be turned into a result.",
										Cause.fail(error),
									).pipe(
										Effect.as({
											_tag: "Failed",
											source: value.source,
											reason: "Schema",
											message:
												"The App continuation returned invalid standard content.",
										} as const),
									),
								),
							),
					)
					return yield* StoredInvocations.get(db, secrets, owner, id)
				}),
			),
	})
})
export const layer = Layer.effect(Operations, make)
