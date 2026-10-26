import { AppExecution, AppViewsApi } from "@openbot-build/api"
import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Crypto,
	Effect,
	HashMap,
	Match,
	Option,
	Record as Rec,
	Ref,
	Schema,
	String as Str,
	pipe,
	type JsonSchema,
} from "effect"
import { Hex } from "effect/encoding"
import { failed, fromOperation, json } from "./AppResults.ts"
import type { Capabilities, Opened } from "./Capabilities.ts"
import type { Invocations, Position } from "./Invocations.ts"
import type { ActionPolicy } from "./ActionPolicy.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { organizationOf } from "./StoredConnections.ts"
import { type Gate, Answer, remember } from "../capabilities/Gate.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import type { CodeRunsApi } from "@openbot-build/api"
import * as Db from "../database/Database.ts"

/**
 * The live capabilities of the App connections of an owner, as plain bindings.
 * App tools and Code Mode both use them, so each App call takes the same path:
 * the same capability check, the same recorded App operation, the same result.
 */

export interface Services {
	readonly db: Db.Database
	readonly secrets: typeof Secrets.Service
	readonly capabilities: typeof Capabilities.Service
	readonly invocations: typeof Invocations.Service
	readonly policy: typeof ActionPolicy.Service
	readonly gate: typeof Gate.Service
	readonly crypto: Crypto.Crypto
}

/** One capability of one connection. */
export interface Binding {
	/** A tool name that is free in this Turn, such as `openbot_<hash>`. */
	readonly name: string
	readonly source: AppExecution.Source
	readonly schema: JsonSchema.JsonSchema
	readonly description: string
	/** True for App tools. Reads of resources and prompts need no decision. */
	readonly needsDecision: boolean
	/** True for a tool that only reads, so plan mode keeps it. */
	readonly readOnly: boolean
	readonly perform: (
		input: unknown,
	) => Effect.Effect<
		Client.OperationResult<unknown>,
		Client.Error | Schema.SchemaError
	>
}

interface Permits {
	readonly check: (
		connectionId: string,
		action: string,
		target: string,
		args: unknown,
	) => Effect.Effect<boolean>
	readonly run: <A, E, R>(
		connectionId: string,
		action: string,
		target: string,
		args: unknown,
		operation: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>
}
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const hash = (crypto: Crypto.Crypto, value: unknown) =>
	Effect.gen(function* () {
		const text = yield* encodeJson(value)
		const digest = yield* crypto.digest(
			"SHA-256",
			new TextEncoder().encode(text),
		)
		return pipe(Hex.encode(digest), Str.slice(0, 40))
	}).pipe(
		// The value is JSON data and SHA-256 is always there, so a failure here is a defect.
		Effect.orDie,
	)
const argumentStrings = Schema.Record(Schema.String, Schema.String)
/** The call does not reach the App, so the issue tells the model to fix its arguments. */
const decodeArguments = (input: unknown) =>
	Schema.decodeUnknownEffect(argumentStrings)(input).pipe(
		Effect.catchTag("SchemaError", (error) =>
			Effect.fail(
				Client.ClientError.make({
					reason: "Schema",
					issue:
						"The arguments do not match the input of this App capability: " +
						error.message,
				}),
			),
		),
	)
const visible = (tool: Opened["tools"][number]) => {
	const metadata = Schema.decodeUnknownOption(
		Schema.Struct({ visibility: Schema.Array(Schema.String) }),
	)(tool._meta?.["ui"])
	return Option.match(metadata, {
		onNone: () => true,
		onSome: (value) => value.visibility.includes("model"),
	})
}
export interface Selected {
	readonly name: string
	readonly source: AppViewsApi.ActionSource
}
const makePermits: Effect.Effect<Permits> = Effect.gen(function* () {
	const state = yield* Ref.make(HashMap.empty<string, number>())
	const key = (
		connectionId: string,
		action: string,
		target: string,
		args: unknown,
	) => JSON.stringify([connectionId, action, target, args])
	return {
		check: (connectionId, action, target, args) =>
			Ref.get(state).pipe(
				Effect.map((values) =>
					HashMap.has(values, key(connectionId, action, target, args)),
				),
			),
		run: (connectionId, action, target, args, operation) => {
			const id = key(connectionId, action, target, args)
			return Effect.acquireUseRelease(
				Ref.update(state, (values) =>
					HashMap.set(
						values,
						id,
						Option.getOrElse(HashMap.get(values, id), () => 0) + 1,
					),
				),
				() => operation,
				() =>
					Ref.update(state, (values) => {
						const count = Option.getOrElse(HashMap.get(values, id), () => 1)
						return count <= 1
							? HashMap.remove(values, id)
							: HashMap.set(values, id, count - 1)
					}),
			)
		},
	}
})

const bindingsFor = (
	services: Services,
	position: Position,
	opened: Opened,
	permits: Permits,
	occupied: ReadonlyArray<string>,
	selected: Option.Option<Selected>,
) =>
	Effect.gen(function* () {
		const owner = position.owner
		const stored = opened.stored
		const app = yield* StoredConnections.getApp(
			services.db,
			owner,
			stored.connection.cardUrl,
		)
		const source = (
			kind: AppExecution.Source["kind"],
			name: string,
			definition: Schema.Json,
		): AppExecution.Source => ({
			connectionId: stored.connection.connectionId,
			connectionName: stored.name,
			cardUrl: stored.connection.cardUrl,
			appName: app.card.title ?? app.card.name,
			remoteIndex: stored.connection.remoteIndex,
			revision: stored.revision,
			kind,
			name,
			definition,
		})
		let entries: ReadonlyArray<Binding> = []
		let used = occupied
		/** The first name `openbot_<hash>` that no other tool uses yet. */
		const freeName = (
			origin: AppExecution.Source,
			schema: JsonSchema.JsonSchema,
			salt: number,
		): Effect.Effect<string> =>
			hash(services.crypto, [owner, origin, schema, salt]).pipe(
				Effect.map((value) => "openbot_" + value),
				Effect.filterOrElse(
					(name) => !used.includes(name),
					() => freeName(origin, schema, salt + 1),
				),
			)
		const add = (
			origin: AppExecution.Source,
			schema: JsonSchema.JsonSchema,
			description: string,
			needsDecision: boolean,
			readOnly: boolean,
			perform: Binding["perform"],
		) =>
			Effect.gen(function* () {
				const name = yield* Option.match(selected, {
					onSome: (value) => Effect.succeed(value.name),
					onNone: () => freeName(origin, schema, 0),
				})
				if (used.includes(name)) return
				used = Arr.append(used, name)
				entries = Arr.append(entries, {
					name,
					source: origin,
					schema,
					description,
					needsDecision,
					readOnly,
					perform,
				})
			})
		for (const tool of Arr.filter(opened.tools, (tool) =>
			Option.match(selected, {
				onNone: () => visible(tool),
				onSome: ({ source }) =>
					source.kind === "tool" && source.target === tool.name,
			}),
		)) {
			const origin = source("tool", tool.name, yield* json(tool))
			yield* add(
				origin,
				tool.inputSchema,
				tool.description ?? "Call this App capability.",
				true,
				yield* services.policy.isRead({
					organizationId: organizationOf(owner),
					source: origin,
				}),
				(input) =>
					Effect.gen(function* () {
						const args = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
							input,
						)
						return yield* permits.run(
							stored.connection.connectionId,
							"tools/call",
							tool.name,
							args,
							opened.client.callTool(
								{ name: tool.name, arguments: args },
								{
									source: Option.isNone(selected) ? "model" : "app",
									readOnly: yield* services.policy.isRead({
										organizationId: organizationOf(owner),
										source: origin,
									}),
								},
							),
						)
					}),
			)
		}
		for (const resource of Arr.filter(opened.resources, (resource) =>
			Option.match(selected, {
				onNone: () => true,
				onSome: ({ source }) =>
					source.kind === "resource" && source.target === resource.uri,
			}),
		))
			yield* add(
				source("resource", resource.uri, yield* json(resource)),
				{ type: "object", properties: {}, additionalProperties: false },
				resource.description ?? "Read this App resource.",
				false,
				true,
				() =>
					opened.client.readResource(
						{ uri: resource.uri },
						{ source: "model", readOnly: true },
					),
			)
		for (const template of Option.isNone(selected)
			? opened.resourceTemplates
			: [])
			yield* add(
				source("template", template.uriTemplate, yield* json(template)),
				{ type: "object", additionalProperties: { type: "string" } },
				template.description ?? "Read this App resource template.",
				false,
				true,
				(input) =>
					Effect.flatMap(decodeArguments(input), (values) =>
						opened.client.readTemplate({
							template: template.uriTemplate,
							values,
							source: "model",
						}),
					),
			)
		for (const prompt of Option.isNone(selected) ? opened.prompts : []) {
			const args = prompt.arguments ?? []
			yield* add(
				source("prompt", prompt.name, yield* json(prompt)),
				{
					type: "object",
					properties: Rec.fromEntries(
						Arr.map(args, (argument) => [
							argument.name,
							{
								type: "string",
								...(argument.description === undefined
									? {}
									: { description: argument.description }),
							},
						]),
					),
					required: pipe(
						args,
						Arr.filter((argument) => argument.required === true),
						Arr.map((argument) => argument.name),
					),
					additionalProperties: false,
				},
				prompt.description ?? "Read this App prompt as external content.",
				false,
				true,
				(input) =>
					Effect.gen(function* () {
						const values = yield* decodeArguments(input)
						if (
							Arr.some(
								args,
								(argument) =>
									argument.required === true &&
									values[argument.name] === undefined,
							) ||
							Arr.some(
								Rec.keys(values),
								(name) => !Arr.some(args, (argument) => argument.name === name),
							)
						)
							return yield* Client.ClientError.make({
								reason: "Schema",
								issue: "Prompt arguments do not match the current declaration",
							})
						return yield* opened.client.getPrompt(
							{ name: prompt.name, arguments: values },
							{ source: "model", readOnly: true },
						)
					}),
			)
		}
		return entries
	})

export const prepare = (
	services: Services,
	position: Position,
	occupied: ReadonlyArray<string>,
	selected: Option.Option<Selected>,
) =>
	Effect.gen(function* () {
		const owner = position.owner
		const permits = yield* makePermits
		const read = yield* StoredConnections.list(
			services.db,
			services.secrets,
			owner,
		).pipe(Effect.result)
		const rows = Match.value(read).pipe(
			Match.tag("Success", ({ success }) => success),
			Match.tag("Failure", () => []),
			Match.exhaustive,
		)
		let entries: ReadonlyArray<Binding> = []
		let issues: ReadonlyArray<string> = Match.value(read).pipe(
			Match.tag("Failure", () => [
				"App connection storage is unavailable. No App connection can be used in this Turn.",
			]),
			Match.orElse(() => []),
		)
		for (const stored of rows) {
			if (stored.connection.state !== "Enabled") continue
			if (
				Option.exists(
					selected,
					({ source }) =>
						stored.connection.connectionId !== source.connectionId ||
						stored.revision !== source.revision,
				)
			)
				continue
			const policy = Client.InvocationPolicy.of({
				check: (invocation) =>
					Effect.gen(function* () {
						const current = yield* StoredConnections.get(
							services.db,
							services.secrets,
							owner,
							stored.connection.connectionId,
						).pipe(
							Effect.catchTags({
								ExperienceNotFound: () =>
									Effect.fail(
										Client.PermissionDenied.make({
											action: invocation.action,
											target: invocation.target,
										}),
									),
								// The policy can only deny, so a storage failure denies the call too.
								ExperienceStorageUnavailable: (error) =>
									Effect.logWarning(
										"OpenBot could not read an App connection, so it denies the App call.",
										error,
									).pipe(
										Effect.andThen(
											Effect.fail(
												Client.PermissionDenied.make({
													action: invocation.action,
													target: invocation.target,
												}),
											),
										),
									),
							}),
						)
						if (
							current.revision !== stored.revision ||
							invocation.connection.owner !== owner ||
							invocation.connection.connectionId !==
								stored.connection.connectionId
						)
							return yield* Client.PermissionDenied.make({
								action: invocation.action,
								target: invocation.target,
							})
						if (
							Schema.is(Client.ListAction)(invocation.action) ||
							invocation.action === "resources/read" ||
							invocation.action === "prompts/get"
						)
							return
						if (
							!(yield* permits.check(
								stored.connection.connectionId,
								invocation.action,
								invocation.target,
								invocation.arguments,
							))
						)
							return yield* Client.PermissionDenied.make({
								action: invocation.action,
								target: invocation.target,
							})
					}),
			})
			const result = yield* services.capabilities
				.open({ owner, connectionId: stored.connection.connectionId, policy })
				.pipe(
					Effect.flatMap((opened) =>
						bindingsFor(
							services,
							position,
							opened,
							permits,
							Arr.appendAll(
								occupied,
								Arr.map(entries, (entry) => entry.name),
							),
							selected,
						),
					),
					Effect.tapError((failure) =>
						Effect.logInfo(
							"An App connection could not be opened for a Turn.",
							Cause.fail(failure),
						).pipe(
							Effect.annotateLogs({
								connectionId: stored.connection.connectionId,
							}),
						),
					),
					Effect.result,
				)
			Match.value(result).pipe(
				Match.tag("Success", ({ success }) => {
					entries = Arr.appendAll(entries, success)
				}),
				Match.tag("Failure", ({ failure }) => {
					issues = Arr.append(
						issues,
						`${stored.name}: ${failure._tag}. Review this connection in My Apps.`,
					)
				}),
				Match.exhaustive,
			)
		}
		return { entries, issues }
	})

/** More about a call that a capability check needs. */
export interface Check {
	readonly callId: string
	readonly arguments: Schema.JsonObject
	/** Why the Bot wants the call, in its own words. */
	readonly reason: string
	/** The tool call that waits for the decision. It is `callId` unless the call comes from a program. */
	readonly toolCallId?: string
	readonly code?: CodeRunsApi.RequestCode
	/** True when a decider must see the call, even for a tool that only reads. A call with Vault values is one. */
	readonly explicit?: boolean
}

/**
 * Proposes an App call and checks it. `Allow` records the approval, so the call can run.
 * `Pending` means that a request waits for a decision. When anything fails, the call
 * does not run.
 */
export const decide = (
	services: Services,
	position: Position,
	binding: Binding,
	check: Check,
): Effect.Effect<Answer> =>
	Effect.gen(function* () {
		const invocation = yield* services.invocations.propose({
			...position,
			source: binding.source,
			toolName: binding.name,
			callId: check.callId,
			arguments: check.arguments,
		})
		const answer = yield* services.gate.check({
			capability: {
				action: "apps.call",
				target: binding.source.connectionId + "/" + binding.source.name,
			},
			reason: check.reason,
			toolCallId: check.toolCallId ?? check.callId,
			app: invocation,
			...(check.code === undefined ? {} : { code: check.code }),
			// The deployment owner says which tools only read.
			implicit:
				check.explicit !== true &&
				(yield* services.policy.isRead({
					organizationId: organizationOf(position.owner),
					source: binding.source,
				})),
		})
		if (answer._tag === "Allow")
			yield* services.invocations.approve(position, check.callId, true)
		return answer
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("Could not check an App action.", error).pipe(
				Effect.as(
					Answer.Deny({ reason: "OpenBot could not check this App call." }),
				),
				Effect.tap((answer) =>
					remember(check.toolCallId ?? check.callId, answer),
				),
			),
		),
	)

/** Ends a call as Failed when its failure could not become a result. It logs that failure. */
const unconverted =
	(source: AppExecution.Source, message: string) =>
	(error: Schema.SchemaError) =>
		Effect.logWarning(
			"An App failure could not be turned into a result.",
			Cause.fail(error),
		).pipe(
			Effect.as({
				_tag: "Failed",
				source,
				reason: "SchemaError",
				message,
			} as const),
		)

/** Sends an approved App call and records it as an App operation. */
export const execute = (
	services: Services,
	position: Position,
	binding: Binding,
	callId: string,
	args: Schema.JsonObject,
): Effect.Effect<AppExecution.Result> => {
	const origin = binding.source
	const operation = Effect.gen(function* () {
		const current = yield* StoredConnections.get(
			services.db,
			services.secrets,
			position.owner,
			origin.connectionId,
		).pipe(
			Effect.catchTag("ExperienceNotFound", () =>
				Effect.fail(
					Client.PermissionDenied.make({
						action: "invoke",
						target: origin.name,
					}),
				),
			),
		)
		if (current.revision !== origin.revision)
			return yield* Client.PermissionDenied.make({
				action: "invoke",
				target: origin.name,
			})
		return yield* fromOperation(origin)(yield* binding.perform(args))
	}).pipe(
		Effect.tapError((error) =>
			Effect.logInfo("An App call failed.", Cause.fail(error)).pipe(
				Effect.annotateLogs({
					connectionId: origin.connectionId,
					target: origin.name,
				}),
			),
		),
		Effect.catch((error) => failed({ source: origin, error })),
		Effect.catch(
			unconverted(
				origin,
				"The App result could not be turned into standard content.",
			),
		),
	)
	return services.invocations
		.execute(
			{
				...position,
				source: origin,
				toolName: binding.name,
				callId,
				arguments: args,
			},
			operation,
		)
		.pipe(
			// StoredInvocations already logs a storage failure, so only these are logged here.
			Effect.tapErrorTag(["ChatConflict", "ExperienceNotFound"], (error) =>
				Effect.logInfo("An App call did not run.", Cause.fail(error)).pipe(
					Effect.annotateLogs({
						connectionId: origin.connectionId,
						target: origin.name,
					}),
				),
			),
			Effect.catch((error) => failed({ source: origin, error })),
			Effect.catch(
				unconverted(
					origin,
					"The App failure could not be turned into a result. Review the operation before continuing.",
				),
			),
		)
}
