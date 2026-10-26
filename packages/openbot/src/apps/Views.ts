import { Chat, Item } from "@openbot-build/core"
import {
	AppViewsApi as Api,
	type ConnectionsApi,
	ExperienceInputInvalid,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	Identity,
	ChatConflict,
	type ChatExecutionUnavailable,
} from "@openbot-build/api"
import { AppUi, Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Option,
	pipe,
	Schema,
	type Scope,
	String as Str,
} from "effect"
import { Backend } from "../app/Backend.ts"
import * as Failures from "../app/Failures.ts"
import type * as Chats from "../chats/Chats.ts"
import { Capabilities, type Opened } from "./Capabilities.ts"
import { ConnectionLocks } from "./ConnectionLocks.ts"
import { appSecrets } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import * as StoredInvocations from "./StoredInvocations.ts"
import * as StoredViews from "./StoredViews.ts"
import { type Action, type View } from "./StoredViews.ts"
import { json, jsonObject } from "./AppResults.ts"
import * as Db from "../database/Database.ts"

/** The error of a view that can not go on. The text and the result of its operation stay. */
const viewUnavailable = (reason: Api.AppViewUnavailable["reason"]) =>
	Api.AppViewUnavailable.make({
		reason,
		message:
			"This App view is unavailable. Its recorded text and business result are still available.",
	})
const viewChanged = () =>
	ChatConflict.make({
		message:
			"The Chat or App view changed. Read its current state before continuing.",
	})
const interactionChanged = () =>
	ChatConflict.make({
		message:
			"The App view or confirmed interaction changed. Read its current state before continuing.",
	})
/** Logs a failure that the caller can not act on, then fails with `AppViewUnavailable` in its place. */
const replaceUnavailable = (
	message: string,
	reason: Api.AppViewUnavailable["reason"],
) => Failures.replace(message, () => viewUnavailable(reason))
/** Logs a storage failure, then fails with `ExperienceStorageUnavailable` in its place. */
const replaceStorage = (message: string) =>
	Failures.replace(message, () => ExperienceStorageUnavailable.make({}))
/**
 * Gives each failure of the Chats service its meaning for App views. A
 * conflict stays a conflict, a missing Chat is not found, and a bad model is
 * bad input. Only the other failures become `ExperienceStorageUnavailable`.
 */
const fromChats =
	(message: string) =>
	<A, R>(
		self: Effect.Effect<A, Chats.ServiceError | ChatExecutionUnavailable, R>,
	) =>
		self.pipe(
			Effect.catchTags({
				ChatNotFound: (error) =>
					Effect.fail(ExperienceNotFound.make({ id: error.chat })),
				ChatModelInvalid: (error) =>
					Effect.fail(ExperienceInputInvalid.make({ message: error.message })),
				ChatStorageUnavailable: (error) =>
					Effect.fail(error).pipe(replaceStorage(message)),
				ChatExecutionUnavailable: (error) =>
					Effect.fail(error).pipe(replaceStorage(message)),
			}),
		)

export const make = Effect.gen(function* () {
	const backend = yield* Backend
	const capabilities = yield* Capabilities
	const locks = yield* ConnectionLocks
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const newId = crypto.randomUUIDv4().pipe(Effect.orDie)
	const read = (owner: string, kind: string, id: string) =>
		db
			.select()
			.from(appSecrets)
			.where(StoredViews.where(owner, kind, id))
			.pipe(Effect.map(Arr.head))
	const required = <A>(found: Option.Option<A>) =>
		Effect.fromOption(found, () => ExperienceNotFound.make({ id: "App view" }))
	const getView = (owner: string, id: string) =>
		read(owner, "app-view", id).pipe(
			replaceStorage("OpenBot could not read an App view"),
			Effect.map(Option.filter((row) => !row.consumed)),
			Effect.flatMap(required),
			Effect.flatMap((row) =>
				StoredViews.open(secrets, StoredViews.View, row).pipe(
					replaceStorage("OpenBot could not open a stored App view"),
				),
			),
		)
	const openView = (owner: string, view: View) =>
		Effect.gen(function* () {
			const body = yield* StoredViews.seal(
				secrets,
				StoredViews.View,
				owner,
				"app-view",
				view.id,
				view,
			)
			yield* db.insert(appSecrets).values({
				owner,
				kind: "app-view",
				id: view.id,
				connectionId: view.connectionId,
				body,
			})
		}).pipe(replaceStorage("OpenBot could not save an App view"))
	const closeView = (owner: string, id: string) =>
		db
			.update(appSecrets)
			.set({ consumed: true })
			.where(StoredViews.where(owner, "app-view", id))
			.returning({ id: appSecrets.id })
			.pipe(
				replaceStorage("OpenBot could not close an App view"),
				Effect.flatMap((rows) =>
					rows.length === 0
						? Effect.fail(ExperienceNotFound.make({ id: "App view" }))
						: Effect.void,
				),
			)
	const readInteraction = (owner: string, chat: string, operationId: string) =>
		Effect.gen(function* () {
			const found = yield* read(
				owner,
				"app-ui-state",
				StoredViews.interactionKey(chat, operationId),
			)
			return yield* Option.match(found, {
				onNone: () => Effect.succeed(StoredViews.initial),
				onSome: (row) => StoredViews.open(secrets, Api.Interaction, row),
			})
		}).pipe(
			replaceStorage(
				"OpenBot could not read the confirmed interaction of an App view",
			),
		)
	const confirmInteraction = (
		owner: string,
		view: View,
		revision: number,
		context: Schema.JsonObject,
	) =>
		Effect.gen(function* () {
			const id = StoredViews.interactionKey(view.chat, view.operationId)
			const initialBody = yield* StoredViews.seal(
				secrets,
				Api.Interaction,
				owner,
				"app-ui-state",
				id,
				StoredViews.initial,
			)
			return yield* db.transaction((tx) =>
				Effect.gen(function* () {
					yield* tx
						.insert(appSecrets)
						.values({
							owner,
							kind: "app-ui-state",
							id,
							connectionId: view.connectionId,
							body: initialBody,
						})
						.onConflictDoNothing()
					const row = (yield* tx
						.select()
						.from(appSecrets)
						.where(StoredViews.where(owner, "app-ui-state", id))
						.for("update"))[0]
					if (row === undefined)
						return yield* ExperienceNotFound.make({ id: "App view" })
					const previous = yield* StoredViews.open(
						secrets,
						Api.Interaction,
						row,
					)
					if (previous.revision !== revision) return yield* interactionChanged()
					const next: Api.Interaction = { revision: revision + 1, context }
					const body = yield* StoredViews.seal(
						secrets,
						Api.Interaction,
						owner,
						"app-ui-state",
						id,
						next,
					)
					yield* tx
						.update(appSecrets)
						.set({ body })
						.where(StoredViews.where(owner, "app-ui-state", id))
					return next
				}),
			)
		}).pipe(
			Effect.catchTag(
				[
					"EffectDrizzleQueryError",
					"SqlError",
					"SecretStorageError",
					"SchemaError",
				],
				(error) =>
					Effect.fail(error).pipe(
						replaceStorage(
							"OpenBot could not save the confirmed interaction of an App view",
						),
					),
			),
		)
	const findAction = (owner: string, viewId: string, requestId: string) =>
		read(
			owner,
			"app-view-action",
			StoredViews.actionKey(viewId, requestId),
		).pipe(
			Effect.flatMap((found) =>
				Effect.transposeOption(
					Option.map(found, (row) =>
						StoredViews.open(secrets, StoredViews.Action, row),
					),
				),
			),
			replaceStorage("OpenBot could not read an App view action"),
		)
	const readAction = (owner: string, viewId: string, requestId: string) =>
		findAction(owner, viewId, requestId).pipe(Effect.flatMap(required))
	/** Save the action of a request once. Give `false` when the request was saved before. */
	const claimAction = (owner: string, view: View, input: Action) =>
		Effect.gen(function* () {
			const id = StoredViews.actionKey(view.id, input.requestId)
			const body = yield* StoredViews.seal(
				secrets,
				StoredViews.Action,
				owner,
				"app-view-action",
				id,
				input,
			)
			const inserted = yield* db
				.insert(appSecrets)
				.values({
					owner,
					kind: "app-view-action",
					id,
					connectionId: view.connectionId,
					body,
				})
				.onConflictDoNothing()
				.returning({ id: appSecrets.id })
			if (inserted.length !== 0) return true
			const saved = yield* readAction(owner, view.id, input.requestId)
			if (
				saved.kind !== input.kind ||
				saved.target !== input.target ||
				!Schema.toEquivalence(Schema.JsonObject)(
					saved.arguments,
					input.arguments,
				)
			)
				return yield* interactionChanged()
			return false
		}).pipe(
			// `readAction` replaces its own storage failures.
			Effect.catchTag(
				["EffectDrizzleQueryError", "SecretStorageError", "SchemaError"],
				(error) =>
					Effect.fail(error).pipe(
						replaceStorage("OpenBot could not save an App view action"),
					),
			),
		)
	const acceptAction = (
		owner: string,
		view: View,
		requestId: string,
		ticket: Api.ActionTicket,
	) =>
		db
			.transaction((tx) =>
				Effect.gen(function* () {
					const id = StoredViews.actionKey(view.id, requestId)
					const row = (yield* tx
						.select()
						.from(appSecrets)
						.where(StoredViews.where(owner, "app-view-action", id))
						.for("update"))[0]
					if (row === undefined)
						return yield* ExperienceNotFound.make({ id: "App view" })
					const saved = yield* StoredViews.open(
						secrets,
						StoredViews.Action,
						row,
					)
					if (
						saved.ticket !== null &&
						!Schema.toEquivalence(Api.ActionTicket)(saved.ticket, ticket)
					)
						return yield* interactionChanged()
					const body = yield* StoredViews.seal(
						secrets,
						StoredViews.Action,
						owner,
						"app-view-action",
						id,
						{ ...saved, ticket },
					)
					yield* tx
						.update(appSecrets)
						.set({ body })
						.where(StoredViews.where(owner, "app-view-action", id))
				}),
			)
			.pipe(
				Effect.catchTag(
					[
						"EffectDrizzleQueryError",
						"SqlError",
						"SecretStorageError",
						"SchemaError",
					],
					(error) =>
						Effect.fail(error).pipe(
							replaceStorage(
								"OpenBot could not save the receipt of an App view action",
							),
						),
				),
			)
	const chats = (identity: typeof Identity.Service) =>
		backend
			.forCaller(identity)
			.pipe(replaceStorage("OpenBot could not open the Chats of a member"))
	const bound = (identity: typeof Identity.Service, id: string) =>
		Effect.gen(function* () {
			const view = yield* getView(ownerKey(identity), id)
			if (view.expiresAt < (yield* Clock.currentTimeMillis))
				return yield* viewUnavailable("Closed")
			const stored = yield* StoredConnections.get(
				db,
				secrets,
				ownerKey(identity),
				view.connectionId,
			).pipe(
				// The member removed the connection of the view.
				Effect.catchTag("ExperienceNotFound", () =>
					Effect.fail(viewUnavailable("ConnectionChanged")),
				),
			)
			if (
				stored.connection.state !== "Enabled" ||
				stored.revision !== view.revision
			)
				return yield* viewUnavailable("ConnectionChanged")
			return view
		})
	const locked = <A, E, R>(
		identity: typeof Identity.Service,
		id: string,
		task: Effect.Effect<A, E, R>,
	) =>
		locks.withConnection(
			{ owner: ownerKey(identity), connectionId: "view:" + id },
			task,
		)
	const openClient = (
		identity: typeof Identity.Service,
		connectionId: string,
	): Effect.Effect<
		Opened,
		| ConnectionsApi.AppRestricted
		| ExperienceStorageUnavailable
		| Api.AppViewUnavailable,
		Scope.Scope
	> =>
		capabilities
			.open({
				owner: ownerKey(identity),
				connectionId,
				policy: Client.InvocationPolicy.of({
					check: (invocation) =>
						invocation.connection.owner === ownerKey(identity) &&
						invocation.connection.connectionId === connectionId &&
						(Schema.is(Client.ListAction)(invocation.action) ||
							invocation.action === "resources/read")
							? Effect.void
							: Effect.fail(
									Client.PermissionDenied.make({
										action: invocation.action,
										target: invocation.target,
									}),
								),
				}),
			})
			.pipe(
				// A rule of the organization and a storage failure keep their meaning.
				// A protocol store outage is a storage failure too, and its source
				// has already logged it.
				Effect.catchTag(
					["AppRestricted", "ExperienceStorageUnavailable"],
					(error) => Effect.fail(error),
					(
						error,
					): Effect.Effect<
						never,
						ExperienceStorageUnavailable | Api.AppViewUnavailable
					> =>
						error._tag === "StoreError" && error.reason === "Unavailable"
							? Effect.fail(ExperienceStorageUnavailable.make({}))
							: Effect.fail(error).pipe(
									replaceUnavailable(
										"OpenBot could not open the App connection of a view",
										"ConnectionChanged",
									),
								),
				),
			)
	/** The Item with the result of an App operation, in the Turn of the operation. */
	const historyBinding = (
		identity: typeof Identity.Service,
		operationId: string,
		chatId: Chat.Id,
		itemId?: Item.Id,
	) =>
		Effect.gen(function* () {
			const operation = yield* StoredInvocations.get(
				db,
				secrets,
				ownerKey(identity),
				operationId,
			)
			const service = yield* chats(identity)
			const items = yield* service
				.turnLog(chatId, operation.turn)
				.pipe(fromChats("OpenBot could not read the Turn of an App operation"))
			const item = pipe(
				Arr.findFirst(
					items,
					(item) =>
						(itemId === undefined || item.id === itemId) &&
						Arr.some(
							item.content.content,
							(message) =>
								message.role === "tool" &&
								Arr.some(
									message.content,
									(part) =>
										part.type === "tool-result" && part.id === operation.callId,
								),
						),
				),
				Option.filter((item) => item.origin?.turn === operation.turn),
			)
			if (Option.isNone(item))
				return yield* ExperienceNotFound.make({ id: operationId })
			return { operation, item: item.value, service }
		})
	const binding = (identity: typeof Identity.Service, view: View) =>
		Effect.gen(function* () {
			const operation = yield* StoredInvocations.get(
				db,
				secrets,
				ownerKey(identity),
				view.operationId,
			)
			return {
				id: view.id,
				operationId: view.operationId,
				readOnly: view.readOnly,
				chat: view.chat,
				turn: view.turn,
				item: view.item,
				source: operation.source,
				interaction: yield* readInteraction(
					ownerKey(identity),
					view.chat,
					view.operationId,
				),
			}
		})
	return {
		open: (
			identity: typeof Identity.Service,
			operationId: string,
			chatId: Chat.Id,
			itemId: Item.Id,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { operation, item } = yield* historyBinding(
						identity,
						operationId,
						chatId,
						itemId,
					)
					if (operation.source.kind !== "tool")
						return yield* viewUnavailable("Declaration")
					const opened = yield* openClient(
						identity,
						operation.source.connectionId,
					)
					if (opened.stored.revision !== operation.source.revision)
						return yield* viewUnavailable("ConnectionChanged")
					const tool = Arr.findFirst(
						opened.tools,
						(tool) => tool.name === operation.source.name,
					)
					if (
						Option.isNone(tool) ||
						operation.source.definition === undefined ||
						!Schema.toEquivalence(Schema.Json)(
							operation.source.definition,
							yield* json(tool.value).pipe(
								replaceUnavailable(
									"OpenBot could not read the tool of an App view as JSON",
									"Protocol",
								),
							),
						)
					)
						return yield* viewUnavailable("Declaration")
					const uri = yield* AppUi.toolResourceUri(tool.value).pipe(
						replaceUnavailable(
							"The tool of an App view names no view resource",
							"Declaration",
						),
					)
					const content = yield* opened.client
						.readResource({ uri }, { source: "host", readOnly: true })
						.pipe(
							replaceUnavailable(
								"OpenBot could not read the resource of an App view",
								"Resource",
							),
						)
					if (content._tag !== "Completed")
						return yield* viewUnavailable("Resource")
					const resource = yield* AppUi.readResource(uri, content.result).pipe(
						replaceUnavailable(
							"The resource of an App view is not a view",
							"Resource",
						),
					)
					const view: View = {
						id: yield* newId,
						operationId,
						readOnly: false,
						chat: chatId,
						turn: operation.turn,
						item: item.id,
						connectionId: operation.source.connectionId,
						revision: operation.source.revision,
						expiresAt: (yield* Clock.currentTimeMillis) + 7_200_000,
					}
					yield* openView(ownerKey(identity), view)
					const result =
						operation.result !== null && operation.result._tag === "Completed"
							? yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
									operation.result.result,
								).pipe(
									replaceUnavailable(
										"The saved result of an App operation is not a JSON object",
										"Protocol",
									),
								)
							: undefined
					return {
						...(yield* binding(identity, view)),
						resource,
						tools: yield* Effect.forEach(opened.tools, (tool) =>
							jsonObject(tool).pipe(
								replaceUnavailable(
									"A tool of an App view is not a JSON object",
									"Protocol",
								),
							),
						),
						arguments: operation.arguments,
						...(result === undefined ? {} : { result }),
					}
				}),
			),
		get: (identity: typeof Identity.Service, id: string) =>
			Effect.flatMap(bound(identity, id), (view) => binding(identity, view)),
		close: (identity: typeof Identity.Service, id: string) =>
			locked(identity, id, closeView(ownerKey(identity), id)),
		read: (
			identity: typeof Identity.Service,
			id: string,
			method: Api.ViewReadAction,
			params: Schema.JsonObject,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const view = yield* bound(identity, id)
					const opened = yield* openClient(identity, view.connectionId)
					if (opened.stored.revision !== view.revision)
						return yield* viewUnavailable("ConnectionChanged")
					const cursor = yield* Schema.decodeEffect(
						Schema.Struct({ cursor: Schema.optionalKey(Schema.String) }),
					)(params).pipe(
						Effect.mapError((error) =>
							ExperienceInputInvalid.make({ message: error.message }),
						),
					)
					const result = yield* Match.value(method).pipe(
						Match.when("tools/list", () =>
							opened.client.listTools({ ...cursor, source: "app" }),
						),
						Match.when("resources/list", () =>
							opened.client.listResources(cursor.cursor, "app"),
						),
						Match.when("resources/templates/list", () =>
							opened.client.listResourceTemplates(cursor.cursor, "app"),
						),
						Match.exhaustive,
						replaceUnavailable(
							"OpenBot could not list the capabilities of an App view",
							"Protocol",
						),
					)
					return yield* jsonObject(result).pipe(
						replaceUnavailable(
							"The list result of an App is not a JSON object",
							"Protocol",
						),
					)
				}),
			),
		act: (
			identity: typeof Identity.Service,
			id: string,
			request: Api.ActionRequest,
		) =>
			locked(
				identity,
				id,
				Effect.scoped(
					Effect.gen(function* () {
						const view = yield* bound(identity, id)
						if (view.readOnly) return yield* viewChanged()
						const existing = yield* findAction(
							ownerKey(identity),
							id,
							request.requestId,
						)
						if (Option.isSome(existing)) {
							yield* claimAction(ownerKey(identity), view, {
								requestId: request.requestId,
								kind: request.kind,
								target: request.kind === "tool" ? request.name : request.uri,
								arguments: request.kind === "tool" ? request.arguments : {},
								ticket: null,
							})
							if (existing.value.ticket === null) return yield* viewChanged()
							return existing.value.ticket
						}

						const service = yield* chats(identity)
						const current = yield* service
							.get(view.chat)
							.pipe(fromChats("OpenBot could not read the Chat of an App view"))
						if (
							current.activity === "historical" ||
							(current.activity === "active" && current.turn?.id !== view.turn)
						)
							return yield* viewChanged()
						const opened = yield* openClient(identity, view.connectionId)
						if (opened.stored.revision !== view.revision)
							return yield* viewUnavailable("ConnectionChanged")
						const target = request.kind === "tool" ? request.name : request.uri
						if (
							request.kind === "tool"
								? !Arr.some(opened.tools, (tool) => tool.name === target)
								: !Arr.some(
										opened.resources,
										(resource) => resource.uri === target,
									)
						)
							return yield* viewUnavailable("Declaration")
						const args = request.kind === "tool" ? request.arguments : {}
						// A client that goes away must not cut the action apart from its receipt.
						return yield* Effect.uninterruptible(
							Effect.gen(function* () {
								const first = yield* claimAction(ownerKey(identity), view, {
									requestId: request.requestId,
									kind: request.kind,
									target,
									arguments: args,
									ticket: null,
								})
								if (!first) {
									const saved = yield* readAction(
										ownerKey(identity),
										id,
										request.requestId,
									)
									if (saved.ticket !== null) return saved.ticket
									// Admission may have worked before the receipt failed to save. Never submit it again.
									return yield* viewChanged()
								}
								const source: Api.ActionSource = {
									_tag: "AppUiAction",
									viewId: id,
									requestId: request.requestId,
									connectionId: view.connectionId,
									revision: view.revision,
									kind: request.kind,
									target,
								}
								const actionId = yield* newId
								const ticket = yield* service
									.startAction(view.chat, {
										author: identity.userId,
										action: {
											name: "openbot_ui_" + Str.replaceAll("-", "")(actionId),
											arguments: args,
											source,
										},
										...(current.activity === "active"
											? { turn: view.turn }
											: {}),
									})
									.pipe(
										fromChats(
											"OpenBot could not start the action of an App view",
										),
									)
								yield* acceptAction(
									ownerKey(identity),
									view,
									request.requestId,
									ticket,
								)
								return ticket
							}),
						)
					}),
				),
			),
		operation: (
			identity: typeof Identity.Service,
			id: string,
			requestId: string,
		) =>
			Effect.gen(function* () {
				yield* bound(identity, id)
				const saved = yield* readAction(ownerKey(identity), id, requestId)
				if (saved.ticket === null) return yield* viewChanged()
				const ticket = saved.ticket
				const recorded = Arr.findFirst(
					yield* StoredInvocations.list(
						db,
						secrets,
						ownerKey(identity),
						ticket.chat,
					),
					(operation) =>
						operation.turn === ticket.turn &&
						operation.callId === ticket.callId,
				)
				if (Option.isSome(recorded))
					return {
						ticket,
						status: recorded.value.status,
						operation: recorded.value,
					}
				const service = yield* chats(identity)
				const turn = yield* service.turn(ticket.chat, ticket.turn).pipe(
					Effect.map((found) => Option.some(found.turn)),
					Effect.catchTag("ChatConflict", () => Effect.succeedNone),
					fromChats("OpenBot could not read the Turn of an App view action"),
				)
				return {
					ticket,
					status: Option.exists(turn, (turn) => turn.status._tag === "Running")
						? ("Queued" as const)
						: ("Failed" as const),
					operation: null,
				}
			}),
		confirmContext: (
			identity: typeof Identity.Service,
			id: string,
			revision: number,
			context: Schema.JsonObject,
		) =>
			locked(
				identity,
				id,
				Effect.flatMap(bound(identity, id), (view) =>
					view.readOnly
						? Effect.fail(viewChanged())
						: confirmInteraction(ownerKey(identity), view, revision, context),
				),
			),
		interaction: (
			identity: typeof Identity.Service,
			operationId: string,
			chatId: Chat.Id,
		) =>
			Effect.gen(function* () {
				yield* historyBinding(identity, operationId, chatId)
				return yield* readInteraction(ownerKey(identity), chatId, operationId)
			}),
		message: (
			identity: typeof Identity.Service,
			id: string,
			content: Schema.JsonObject,
		) =>
			locked(
				identity,
				id,
				Effect.gen(function* () {
					const view = yield* bound(identity, id)
					if (view.readOnly) return yield* viewChanged()
					const message = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							content: Schema.Array(
								Schema.Struct({
									type: Schema.Literal("text"),
									text: Schema.String,
								}),
							),
						}),
					)(content).pipe(
						replaceUnavailable(
							"An App view sent a message that is not only text",
							"Unsupported",
						),
					)
					// The message reaches the Bot at its next step, or starts a Turn.
					const service = yield* chats(identity)
					yield* service
						.deliver(view.chat, {
							input:
								"Confirmed message from App " +
								view.connectionId +
								":\n" +
								pipe(
									message.content,
									Arr.map((part) => part.text),
									Arr.join("\n"),
								),
							author: identity.userId,
							notice: { kind: "app", ref: view.connectionId },
						})
						.pipe(
							fromChats("OpenBot could not deliver the message of an App view"),
						)
				}),
			),
	}
})
export class Views extends Context.Service<
	Views,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/Views") {}
export const layer = Layer.effect(Views, make)
