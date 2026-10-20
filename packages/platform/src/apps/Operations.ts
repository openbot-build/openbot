import { AppExecution, SessionConflict } from "@openbot-build/platform-api"
import { Client, McpClient } from "@openbot-build/protocol"
import { Context, Effect, Layer, Match, Schema } from "effect"
import { failed, json } from "./AppResults.ts"
import { Capabilities } from "./Capabilities.ts"
import { InvocationRepository, type Error } from "./InvocationRepository.ts"
import { Invocations } from "./Invocations.ts"
import { ActionPolicy } from "./ActionPolicy.ts"

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
>()("@openbot-build/platform/apps/Operations") {}

const invalid = () =>
	SessionConflict.make({
		message:
			"This App input request is no longer available or does not match its operation.",
	})
export const make: Effect.Effect<
	typeof Operations.Service,
	never,
	Capabilities | InvocationRepository | Invocations | ActionPolicy
> = Effect.gen(function* () {
	const capabilities = yield* Capabilities
	const records = yield* InvocationRepository
	const invocations = yield* Invocations
	const actions = yield* ActionPolicy
	return Operations.of({
		respond: (owner, id, round, responses) =>
			Effect.scoped(
				Effect.gen(function* () {
					const value = yield* records.get(owner, id)
					const request = yield* Match.value(value.result).pipe(
						Match.when({ _tag: "InputRequired" }, ({ request }) =>
							Schema.decodeUnknownEffect(Schema.JsonObject)(request).pipe(
								Effect.mapError(invalid),
							),
						),
						Match.orElse(() => Effect.fail(invalid())),
					)
					if (value.status !== "InputRequired" || value.round !== round)
						return yield* invalid()
					if (actions.isRead(value.source) !== value.readOnly)
						return yield* invalid()
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
						Effect.mapError(invalid),
					)
					const policy = Client.InvocationPolicy.of({
						check: (invocation) =>
							invocation.connection.owner === owner &&
							invocation.connection.connectionId ===
								value.source.connectionId &&
							(invocation.action.endsWith("/list") ||
								(invocation.action === continuation.method &&
									(invocation.target === value.source.name ||
										value.source.kind === "template")))
								? Effect.void
								: Effect.fail(
										new Client.PermissionDenied({
											action: invocation.action,
											target: invocation.target,
										}),
									),
					})
					const opened = yield* capabilities
						.open({ owner, connectionId: value.source.connectionId, policy })
						.pipe(Effect.mapError(invalid))
					if (opened.stored.revision !== value.source.revision)
						return yield* invalid()
					const declaration = Match.value(value.source.kind).pipe(
						Match.when("tool", () =>
							opened.tools.find((tool) => tool.name === value.source.name),
						),
						Match.when("resource", () =>
							opened.resources.find(
								(resource) => resource.uri === value.source.name,
							),
						),
						Match.when("template", () =>
							opened.resourceTemplates.find(
								(template) => template.uriTemplate === value.source.name,
							),
						),
						Match.when("prompt", () =>
							opened.prompts.find(
								(prompt) => prompt.name === value.source.name,
							),
						),
						Match.exhaustive,
					)
					if (
						declaration === undefined ||
						value.source.definition === undefined ||
						!Schema.toEquivalence(Schema.Json)(
							value.source.definition,
							yield* json(declaration).pipe(Effect.mapError(invalid)),
						)
					)
						return yield* invalid()
					yield* invocations.resume(
						owner,
						id,
						opened.client
							.resume(continuation, responses, {
								source: "host",
								readOnly: value.readOnly,
							})
							.pipe(
								Effect.flatMap((result) =>
									Match.value(result).pipe(
										Match.tag("Completed", ({ result }) =>
											json(result).pipe(
												Effect.map((result): AppExecution.Result => ({
													_tag: "Completed",
													source: value.source,
													result,
												})),
											),
										),
										Match.tag("InputRequired", ({ result }) =>
											json(result).pipe(
												Effect.map((request): AppExecution.Result => ({
													_tag: "InputRequired",
													source: value.source,
													request,
												})),
											),
										),
										Match.exhaustive,
									),
								),
								Effect.catch((error) =>
									failed({ source: value.source, error }),
								),
								Effect.orElseSucceed(
									() =>
										({
											_tag: "Failed",
											source: value.source,
											reason: "Schema",
											message:
												"The App continuation returned invalid standard content.",
										}) as const,
								),
							),
					)
					return yield* records.get(owner, id)
				}),
			),
	})
})
export const layer = Layer.effect(Operations, make)
