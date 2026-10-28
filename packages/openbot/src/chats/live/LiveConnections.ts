import {
	type Scope,
	Array as Arr,
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Schedule,
	Semaphore,
	Stream,
} from "effect"
import { type ChatStore, Chat, Config } from "@openbot-build/core"
import * as ModelFailure from "../../models/ModelFailure.ts"
import {
	Authorization,
	Execution,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import {
	AiError,
	LanguageModel,
	Prompt,
	Response,
	Tool,
	Toolkit,
} from "effect/ai"
import { ownerKey } from "../../apps/StoredConnections.ts"
import * as Check from "../../authorization/Check.ts"
import { Records, category } from "../../errors/Records.ts"
import * as Recovery from "../../execution/Recovery.ts"
import * as Send from "../../execution/Send.ts"
import { Registry } from "../../execution/Engine.ts"
import { Store, type Fence, type Key } from "../../execution/Store.ts"
import { Directory } from "../../resources/Directory.ts"
import * as Resource from "../../resources/Resource.ts"
import * as Db from "../../database/Database.ts"
import * as StoredChats from "../StoredChats.ts"
import * as ChatHost from "../ChatHost.ts"
import { Transport } from "../../resources/Transport.ts"

const ToolDefinition = Schema.Struct({
	name: Schema.String,
	description: Schema.optionalKey(Schema.String),
	parameters: Schema.JsonObject,
})
const Choice = Schema.Union([
	Schema.Literals(["auto", "none", "required"]),
	Schema.Struct({ tool: Schema.String }),
	Schema.Struct({
		mode: Schema.optionalKey(Schema.Literals(["auto", "required"])),
		oneOf: Schema.Array(Schema.String),
	}),
])
const Request = Schema.Struct({
	call: Send.Reference,
	kind: Schema.Literals(["generate", "stream"]),
	selection: Config.Selection,
	prompt: Prompt.Prompt,
	tools: Schema.Array(ToolDefinition),
	toolChoice: Choice,
})
const requestCodec = Schema.toCodecJson(Request)
const partsCodec = Schema.toCodecJson(Schema.Array(Response.Part()))
const partCodec = Schema.toCodecJson(Response.StreamPart())
const chatInput = Schema.Struct({ chat: Chat.Id })
const SessionRequest = Schema.Struct({
	namespace: Schema.String,
	id: Execution.Id,
	generation: Execution.Generation,
})
const sameSelection = Schema.toEquivalence(Config.Selection)
export const resource = (namespace: string, chat: Chat.Id): Resource.Ref => ({
	namespace,
	kind: "live-session",
	id: chat,
})

const selectionKey = Schema.encodeEffect(
	Schema.fromJsonString(Config.Selection),
)
const modelResource = (
	namespace: string,
	chat: Chat.Id,
	selection: Config.Selection,
) =>
	selectionKey(selection).pipe(
		Effect.orDie,
		Effect.map((key): Resource.Ref => ({
			namespace,
			kind: "live-model",
			id: `${chat.length}:${chat}${key}`,
		})),
	)

/** A Live connection stays at its physical node. Only model requests cross private RPC. */
export interface Service {
	readonly use: <A, E, R>(
		input: {
			readonly identity: ExecutionIdentity
			readonly chat: Chat.Id
			readonly selection: Config.Selection
			readonly model: Effect.Effect<LanguageModel.LanguageModel>
			readonly started: (key: Key) => Effect.Effect<void>
		},
		run: (held: {
			readonly address: Resource.Address
			readonly lost: Effect.Effect<void>
			readonly retire: Effect.Effect<void, Execution.StorageError>
		}) => Effect.Effect<A, E, R>,
	) => Effect.Effect<
		A,
		| E
		| Resource.Busy
		| Chat.ChatNotFound
		| ChatStore.ChatStoreError
		| Resource.Failed
		| Execution.Forbidden
		| Resource.Gone
		| Execution.StorageError,
		Exclude<Exclude<R, Scope.Scope>, Scope.Scope>
	>
	readonly model: (
		key: Key,
		chat: Chat.Id,
		selection: Config.Selection,
	) => Effect.Effect<LanguageModel.LanguageModel, never>
	readonly wait: (
		key: Fence,
		chat: Chat.Id,
		selection?: Config.Selection,
	) => Effect.Effect<Resource.Address, Resource.Error | Execution.StorageError>
	readonly release: (
		namespace: string,
		chat: Chat.Id,
	) => Effect.Effect<void, Resource.Error | Execution.StorageError>
	readonly available: (
		namespace: string,
		chat: Chat.Id,
	) => Effect.Effect<boolean, Execution.StorageError>
}

export class LiveConnections extends Context.Service<
	LiveConnections,
	Service
>()("@openbot-build/openbot/chats/live/LiveConnections") {}

const make = Effect.gen(function* () {
	const transport = yield* Transport
	const db = yield* Db.make
	const directory = yield* Directory
	const access = yield* Send.Access
	const store = yield* Store
	const registry = yield* Registry
	const checks = yield* Check.make
	const errors = yield* Records
	const recovery = yield* Recovery.make
	const failure = (
		cause: Cause.Cause<unknown>,
		id: Execution.Id,
		notSent = false,
	) =>
		Effect.gen(function* () {
			if (Cause.hasInterruptsOnly(cause))
				return yield* Effect.failCause(
					Cause.fromReasons<never>(
						Arr.filter(cause.reasons, Cause.isInterruptReason),
					),
				)
			const known = ModelFailure.fromCause(cause)
			if (Option.isSome(known)) return yield* ModelFailure.notSent(known.value)
			const reason = cause.reasons[0]
			const saved =
				cause.reasons.length === 1 &&
				reason?._tag === "Fail" &&
				Schema.is(Resource.Failed)(reason.error)
					? {
							...reason.error.failure,
							...(reason.error.outcome === "unknown"
								? { category: "outcome_unknown" as const }
								: {}),
						}
					: yield* recovery.record(cause, id)
			if (
				notSent ||
				(cause.reasons.length === 1 &&
					reason?._tag === "Fail" &&
					Schema.is(Resource.Failed)(reason.error) &&
					reason.error.outcome === "not_sent")
			)
				return yield* ModelFailure.notSent(saved)
			return yield* AiError.make({
				module: "OpenBot",
				method: "live",
				reason: AiError.UnknownError.make({
					description: "The Live connection could not give an answer.",
					metadata: { openbot: saved },
				}),
			})
		})
	const use = <A, E, R>(
		input: {
			readonly identity: ExecutionIdentity
			readonly chat: Chat.Id
			readonly selection: Config.Selection
			readonly model: Effect.Effect<LanguageModel.LanguageModel>
			readonly started: (key: Key) => Effect.Effect<void>
		},
		run: (
			held: Effect.Success<ReturnType<typeof transport.register>>,
		) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const ref = resource(ownerKey(input.identity.owner), input.chat)
			const admit = Effect.gen(function* () {
				yield* StoredChats.lock(db, ref.namespace, input.chat)
				const chat = yield* StoredChats.ref(db, ref.namespace, input.chat)
				if (
					Option.isNone(chat) ||
					ChatHost.hostState(chat.value).control !== undefined
				)
					return yield* Execution.Forbidden.make({})
			})
			const permit = yield* Semaphore.make(1)
			const held =
				yield* Deferred.make<
					Effect.Success<ReturnType<typeof transport.register>>
				>()
			const modelHeld =
				yield* Deferred.make<
					Effect.Success<ReturnType<typeof transport.register>>
				>()
			const authorize = (request: typeof Request.Type) =>
				Effect.gen(function* () {
					if (
						request.call.namespace !== ref.namespace ||
						!sameSelection(request.selection, input.selection)
					)
						return yield* Execution.Forbidden.make({})
					const identity = yield* access.resolve(
						Send.Authority.cases.Call.make({ reference: request.call }),
					)
					if (
						ownerKey(identity.owner) !== ref.namespace ||
						identity.botId !== input.identity.botId
					)
						return yield* Execution.Forbidden.make({})
					const saved = yield* store.loadMember(request.call)
					if (
						saved.record.resource.kind !== "Turn" ||
						(yield* Schema.decodeUnknownEffect(chatInput)(saved.input)).chat !==
							input.chat
					)
						return yield* Execution.Forbidden.make({})
					yield* Check.execution(checks, identity, {
						action: "run",
						resource: Authorization.Chat.make({
							organizationId: identity.owner.organizationId,
							ownerUserId: identity.owner.userId,
							id: input.chat,
						}),
					})
					yield* Check.model(checks, identity, input.selection)
					// The person holding the sound connection must still be allowed to hear this Chat.
					for (const action of ["read", "run"] as const)
						yield* Check.execution(checks, input.identity, {
							action,
							resource: Authorization.Chat.make({
								organizationId: input.identity.owner.organizationId,
								ownerUserId: input.identity.owner.userId,
								id: input.chat,
							}),
						})
					yield* Check.model(checks, input.identity, input.selection)
				})
			// A cancelled response has no reliable end marker. Never reuse this sound connection.
			const protect = <A, E>(stream: Stream.Stream<A, E>) =>
				stream.pipe(
					Stream.onExit((exit) =>
						Exit.isFailure(exit)
							? Effect.all([
									Deferred.await(held),
									Deferred.await(modelHeld),
								]).pipe(
									Effect.flatMap((connections) =>
										Effect.forEach(
											connections,
											(connection) => transport.closeLocal(connection.address),
											{ discard: true },
										),
									),
								)
							: Effect.void,
					),
				)
			const handler = (json: Schema.Json) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const request = yield* Schema.decodeEffect(requestCodec)(json)
						// The directory can be seen before registration returns. Do not send until
						// both leases exist; this wait must stay interruptible if registration fails.
						yield* Deferred.await(modelHeld)
						// The stream owns the permit. Losing the RPC closes this call before the next one.
						yield* Effect.acquireRelease(permit.take(1), () =>
							permit.release(1),
						)
						// Check after waiting: permission or execution ownership may have changed.
						yield* authorize(request)
						yield* input.started(request.call)
						const model = yield* input.model
						const toolkit = Toolkit.make(
							...Arr.map(request.tools, (tool) =>
								Tool.dynamic(tool.name, {
									...(tool.description === undefined
										? {}
										: { description: tool.description }),
									parameters: tool.parameters,
									success: Schema.Json,
								}),
							),
						)
						const options = {
							prompt: request.prompt,
							toolkit,
							toolChoice: request.toolChoice,
							disableToolCallResolution: true as const,
							toolCallValidation: "deferred" as const,
						}
						if (request.kind === "generate")
							return protect(
								Stream.fromEffect(
									model
										.generateText(options)
										.pipe(
											Effect.flatMap((response) =>
												Schema.encodeEffect(partsCodec)(response.content),
											),
										),
								),
							)
						return protect(
							model
								.streamText(options)
								.pipe(
									Stream.mapEffect((part) =>
										Schema.encodeEffect(partCodec)(part),
									),
								),
						)
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (Cause.hasInterruptsOnly(cause))
									return yield* Effect.failCause(
										Cause.fromReasons<never>(
											Arr.filter(cause.reasons, Cause.isInterruptReason),
										),
									)
								return yield* Resource.Failed.make({
									resource: ref,
									outcome: "not_sent",
									failure: yield* errors.record(cause, category(cause)),
								})
							}),
						),
					),
				)
			// One lease owns the sound session. Its model route includes the full config,
			// so a later Turn waits for a matching connection instead of using the old model.
			return yield* transport.own(
				ref,
				(json) =>
					Stream.fromEffect(
						Effect.gen(function* () {
							yield* Deferred.await(held)
							const key =
								yield* Schema.decodeUnknownEffect(SessionRequest)(json)
							const saved = yield* store.loadMember(key)
							if (
								key.namespace !== ref.namespace ||
								saved.generation !== key.generation ||
								saved.record.status !== "running" ||
								saved.phaseFailed ||
								saved.record.resource.kind !== "Turn" ||
								(yield* Schema.decodeUnknownEffect(chatInput)(saved.input))
									.chat !== input.chat ||
								ownerKey(saved.identity.owner) !== ref.namespace ||
								saved.identity.botId !== input.identity.botId
							)
								return yield* Execution.Forbidden.make({})
							const feature = yield* registry.get(saved.workflow)
							if (Option.isNone(feature))
								return yield* Execution.Forbidden.make({})
							yield* feature.value.authorize(
								key,
								saved.identity.actor,
								"advance",
							)
							// Follow the saved execution before waiting for a matching model. This also
							// reaches an idle socket when another node accepts an HTTP message.
							yield* input.started(key)
							return null
						}).pipe(
							Effect.catchCause((cause) =>
								Effect.gen(function* () {
									if (Cause.hasInterruptsOnly(cause))
										return yield* Effect.failCause(
											Cause.fromReasons<never>(
												Arr.filter(cause.reasons, Cause.isInterruptReason),
											),
										)
									return yield* Resource.Failed.make({
										resource: ref,
										outcome: "not_sent",
										failure: yield* errors.record(cause, category(cause)),
									})
								}),
							),
						),
					),
				{ admit },
				(connection) =>
					Effect.gen(function* () {
						yield* Deferred.succeed(held, connection)
						const modelConnection = yield* transport.register(
							yield* modelResource(ref.namespace, input.chat, input.selection),
							handler,
							{ admit },
						)
						yield* Deferred.succeed(modelHeld, modelConnection)
						return yield* Effect.raceFirst(
							run(connection),
							modelConnection.lost.pipe(Effect.andThen(Effect.interrupt)),
						)
					}),
			)
		})
	const wait = (key: Fence, chat: Chat.Id, selection?: Config.Selection) =>
		Effect.gen(function* () {
			const ref = resource(key.namespace, chat)
			const request = yield* Schema.encodeEffect(
				Schema.toCodecJson(SessionRequest),
			)(key).pipe(Effect.orDie)
			const follow = (
				afterLease?: string,
			): Effect.Effect<void, Execution.StorageError | Resource.Error> =>
				Effect.gen(function* () {
					const address = yield* directory.wait(ref, afterLease)
					yield* transport.callAt(address, request).pipe(
						Stream.runDrain,
						Effect.catchTag("ResourceGone", () => follow(address.lease)),
					)
				}).pipe(
					Effect.retry({
						// This read-only RPC can lose its reply while the same socket is healthy.
						// Retry observation on the current owner. Only Gone waits for a new lease.
						while: (error) =>
							error._tag === "ResourceFailed" && error.outcome === "unknown",
						schedule: Schedule.spaced("100 millis"),
					}),
				)
			yield* follow()
			return yield* selection === undefined
				? directory.wait(ref)
				: modelResource(key.namespace, chat, selection).pipe(
						Effect.flatMap((ref) => directory.wait(ref)),
					)
		})
	const model = (key: Key, chat: Chat.Id, selection: Config.Selection) => {
		// Gone proves that the handler did not start. Once it starts, loss is an unknown result.
		const send = (
			input: Schema.Json,
			afterLease?: string,
		): Stream.Stream<Schema.Json, Resource.Error | Execution.StorageError> =>
			Stream.unwrap(
				modelResource(key.namespace, chat, selection).pipe(
					Effect.flatMap((ref) => directory.wait(ref, afterLease)),
					Effect.map((address) =>
						transport
							.callAt(address, input)
							.pipe(
								Stream.catchTag("ResourceGone", () =>
									send(input, address.lease),
								),
							),
					),
				),
			)
		const ref = resource(key.namespace, chat)
		const request = (
			kind: "generate" | "stream",
			options: LanguageModel.ProviderOptions,
		) =>
			Effect.gen(function* () {
				const current = yield* Send.Current
				if (
					Option.isNone(current) ||
					current.value._tag !== "Call" ||
					current.value.reference.id !== key.id ||
					current.value.reference.namespace !== key.namespace
				)
					return yield* Execution.Forbidden.make({})
				const tools = yield* Effect.forEach(options.tools, (tool) =>
					Schema.decodeUnknownEffect(ToolDefinition)({
						name: tool.name,
						...(Tool.getDescription(tool) === undefined
							? {}
							: { description: Tool.getDescription(tool) }),
						parameters: Tool.getJsonSchema(tool),
					}),
				)
				return yield* Schema.encodeEffect(requestCodec)({
					call: current.value.reference,
					kind,
					selection,
					prompt: options.prompt,
					tools,
					toolChoice: options.toolChoice,
				})
			})
		return LanguageModel.make({
			generateText: (options) =>
				request("generate", options).pipe(
					Effect.catchCause((cause) => failure(cause, key.id, true)),
					Effect.flatMap((input) => send(input).pipe(Stream.runCollect)),
					Effect.flatMap((replies) =>
						Effect.gen(function* () {
							if (replies.length !== 1)
								return yield* Resource.Gone.make({ resource: ref })
							const parts = yield* Schema.decodeEffect(partsCodec)(replies[0]!)
							return Arr.fromIterable(
								yield* Schema.encodeEffect(Schema.Array(Response.Part()))(
									parts,
								),
							)
						}),
					),
					Effect.catchCause((cause) => failure(cause, key.id)),
				),
			streamText: (options) =>
				Stream.unwrap(
					request("stream", options).pipe(
						Effect.catchCause((cause) => failure(cause, key.id, true)),
						Effect.map((input) => send(input)),
					),
				).pipe(
					Stream.mapEffect((part) =>
						Schema.decodeEffect(partCodec)(part).pipe(
							Effect.flatMap((decoded) =>
								Schema.encodeEffect(Response.StreamPart())(decoded),
							),
						),
					),
					Stream.catchCause((cause) =>
						Stream.fromEffect(failure(cause, key.id)),
					),
				),
		})
	}
	return LiveConnections.of({
		use,
		model,
		wait,
		release: (namespace: string, chat: Chat.Id) =>
			transport.release(resource(namespace, chat)),
		available: (namespace: string, chat: Chat.Id) =>
			directory.find(resource(namespace, chat)).pipe(Effect.map(Option.isSome)),
	})
})

export const layer = Layer.effect(LiveConnections, make)
