import { type Ui, AppUi, Client } from "@openbot-build/protocol"
import {
	type ChatNotFound,
	type ChatStorageUnavailable,
	type AppIndex,
	ExperienceInputInvalid,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	ChatConflict,
	Identity,
	Execution,
	AppCalls,
	AppViews,
} from "@openbot-build/domain"
import type { Errors } from "../authorization/Check.ts"
import {
	type PlatformError,
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
} from "effect"
import { Chat, Item, Turn } from "@openbot-build/core"

import * as AppQueries from "./AppQueries.ts"
import * as ChatQueries from "../chats/ChatQueries.ts"
import * as ChatErrors from "../chats/ChatErrors.ts"
import * as TaskMessages from "../chats/TaskMessages.ts"
import { Store, transactionFailures } from "../execution/Store.ts"
import { ActionPolicy } from "./ActionPolicy.ts"
import * as Hex from "effect/encoding/Hex"
import { Prompt } from "effect/ai"
import { SqlClient } from "effect/sql"
import * as Failures from "../errors/Failures.ts"
import * as Capabilities from "./Capabilities.ts"
import { ConnectionSessions, type Opened } from "./ConnectionSessions.ts"
import { appSecrets } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import * as StoredViews from "./StoredViews.ts"
import { type View } from "./StoredViews.ts"
import { json, jsonObject } from "./AppResults.ts"
import * as Db from "../database/Database.ts"

/** The error of a view that can not go on. The text and the result of its operation stay. */
const viewUnavailable = (reason: AppViews.AppViewUnavailable["reason"]) =>
	AppViews.AppViewUnavailable.make({
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
	reason: AppViews.AppViewUnavailable["reason"],
) => Failures.replace(message, () => viewUnavailable(reason))
/** Logs a storage failure, then fails with `ExperienceStorageUnavailable` in its place. */
const replaceStorage = (message: string) =>
	Failures.replace(message, () => ExperienceStorageUnavailable.make({}))
export interface Service {
	readonly open: (
		identity: typeof Identity.Service,
		operationId: string,
		chatId: Chat.Id,
		itemId: Item.Id,
	) => Effect.Effect<
		{
			id: AppViews.AppViewId
			operationId: AppCalls.AppOperationId
			readOnly: boolean
			chat: Chat.Id
			turn: Turn.Id
			item: Item.Id
			source: AppCalls.Source
			interaction: AppViews.Interaction
			resource: Ui.Resource
			tools: { readonly [x: string]: Schema.Json }[]
			arguments: { readonly [x: string]: Schema.Json }
			result?: { readonly [x: string]: Schema.Json }
		},
		| AppIndex.AppRestricted
		| AppViews.AppViewUnavailable
		| Execution.Conflict
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
	>
	readonly get: (
		identity: typeof Identity.Service,
		id: string,
	) => Effect.Effect<
		{
			id: AppViews.AppViewId
			operationId: AppCalls.AppOperationId
			readOnly: boolean
			chat: Chat.Id
			turn: Turn.Id
			item: Item.Id
			source: AppCalls.Source
			interaction: AppViews.Interaction
		},
		| AppViews.AppViewUnavailable
		| Execution.Conflict
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
	>
	readonly close: (
		identity: typeof Identity.Service,
		id: string,
	) => Effect.Effect<
		void,
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
	>
	readonly read: (
		identity: typeof Identity.Service,
		id: string,
		method: AppViews.ViewReadAction,
		params: Schema.JsonObject,
	) => Effect.Effect<
		{ readonly [x: string]: Schema.Json },
		| AppIndex.AppRestricted
		| AppViews.AppViewUnavailable
		| ExperienceInputInvalid
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
	>
	readonly act: (
		identity: typeof Identity.Service,
		id: string,
		request: AppViews.ActionRequest,
	) => Effect.Effect<
		{
			executionId: Execution.Id
			commandKey: Execution.CommandKey
			sequence: number
			chat: Chat.Id
			turn: Turn.Id
		},
		| AppIndex.AppRestricted
		| AppViews.AppViewUnavailable
		| Execution.Conflict
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| Execution.KeyConflict
		| PlatformError.PlatformError
		| Schema.SchemaError
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
	readonly confirmContext: (
		identity: typeof Identity.Service,
		id: string,
		revision: number,
		context: Schema.JsonObject,
	) => Effect.Effect<
		AppViews.Interaction,
		| AppViews.AppViewUnavailable
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
	>
	readonly interaction: (
		identity: typeof Identity.Service,
		operationId: string,
		chatId: Chat.Id,
	) => Effect.Effect<
		AppViews.Interaction,
		| Execution.Conflict
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| Execution.Forbidden
		| Execution.NotFound
		| Execution.StorageError
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
	>
	readonly message: (
		identity: typeof Identity.Service,
		id: string,
		content: Schema.JsonObject,
		commandKey: Execution.CommandKey,
	) => Effect.Effect<
		{
			executionId: Execution.Id
			commandKey: Execution.CommandKey
			sequence: number
			chat: Chat.Id
			turn: Turn.Id
		},
		| AppViews.AppViewUnavailable
		| Execution.Conflict
		| ExperienceNotFound
		| ExperienceStorageUnavailable
		| Execution.KeyConflict
		| Schema.SchemaError
		| (ChatConflict | ChatNotFound | ChatStorageUnavailable)
		| Errors
		| (Execution.Forbidden | Execution.NotFound | Execution.StorageError)
	>
}

export class Views extends Context.Service<Views, Service>()(
	"@openbot-build/openbot/apps/Views",
) {}

export const make = Effect.gen(function* () {
	const apps = yield* AppQueries.make
	const chats = yield* ChatQueries.make
	const inputs = yield* TaskMessages.make
	const store = yield* Store
	const policy = yield* ActionPolicy
	const sql = yield* SqlClient.SqlClient
	const sessions = yield* ConnectionSessions
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
				onSome: (row) => StoredViews.open(secrets, AppViews.Interaction, row),
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
				AppViews.Interaction,
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
						AppViews.Interaction,
						row,
					)
					if (previous.revision !== revision) return yield* interactionChanged()
					const next: AppViews.Interaction = { revision: revision + 1, context }
					const body = yield* StoredViews.seal(
						secrets,
						AppViews.Interaction,
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
	const bound = (identity: typeof Identity.Service, id: string) =>
		Effect.gen(function* () {
			const view = yield* getView(ownerKey(identity), id)
			yield* chats.read(identity, view.chat).pipe(ChatErrors.map)
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
		sql
			.withTransaction(
				Effect.gen(function* () {
					// The row lock also guards requests from another server.
					yield* db
						.select({ id: appSecrets.id })
						.from(appSecrets)
						.where(StoredViews.where(ownerKey(identity), "app-view", id))
						.for("update")
					return yield* task
				}),
			)
			.pipe(
				Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (error) =>
					Effect.fail(error).pipe(
						replaceStorage("OpenBot could not change an App view"),
					),
				),
			)
	const openClient = (
		identity: typeof Identity.Service,
		connectionId: string,
	): Effect.Effect<
		Opened,
		| AppIndex.AppRestricted
		| ExperienceStorageUnavailable
		| AppViews.AppViewUnavailable,
		Scope.Scope
	> =>
		sessions
			.open({
				owner: ownerKey(identity),
				connectionId,
				policy: Client.InvocationPolicy.of({
					check: (invocation) =>
						invocation.connection.owner === ownerKey(identity) &&
						invocation.connection.connectionId === connectionId &&
						((invocation.action === "connect" &&
							invocation.target === invocation.connection.endpoint) ||
							Schema.is(Client.ListAction)(invocation.action) ||
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
						ExperienceStorageUnavailable | AppViews.AppViewUnavailable
					> =>
						error._tag === "StoreError" && error.reason === "Unavailable"
							? Effect.fail(error).pipe(
									replaceStorage(
										"OpenBot could not read the App view connection",
									),
								)
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
			const { operation, position } = yield* apps.history(
				identity,
				AppCalls.AppOperationId.make(operationId),
			)
			if (operation.chat !== chatId)
				return yield* ExperienceNotFound.make({ id: operationId })
			const { items } = yield* chats
				.turn(identity, chatId, operation.turn)
				.pipe(ChatErrors.map)
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
				Option.filter(
					(item) =>
						item.origin?.chat === position.chat &&
						item.origin.turn === position.turn &&
						item.origin.step === position.step,
				),
			)
			if (Option.isNone(item))
				return yield* ExperienceNotFound.make({ id: operationId })
			return { operation, item: item.value }
		})
	const binding = (identity: typeof Identity.Service, view: View) =>
		Effect.gen(function* () {
			const operation = yield* apps.read(identity, view.operationId)
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
	return Views.of({
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
					const tools = yield* Capabilities.tools(opened.client).pipe(
						replaceUnavailable(
							"OpenBot could not read the tools of an App view",
							"Protocol",
						),
					)
					const tool = Arr.findFirst(
						tools,
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
						id: AppViews.AppViewId.make(yield* newId),
						operationId: operation.id,
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
						tools: yield* Effect.forEach(tools, (tool) =>
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
			locked(
				identity,
				id,
				getView(ownerKey(identity), id).pipe(
					Effect.flatMap((view) =>
						chats.read(identity, view.chat).pipe(ChatErrors.map),
					),
					Effect.andThen(closeView(ownerKey(identity), id)),
				),
			),
		read: (
			identity: typeof Identity.Service,
			id: string,
			method: AppViews.ViewReadAction,
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
						Failures.replace("An App view sent an invalid page cursor", () =>
							ExperienceInputInvalid.make({
								message: "The page cursor must be text.",
							}),
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
			request: AppViews.ActionRequest,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const view = yield* bound(identity, id)
					if (view.readOnly) return yield* viewChanged()
					const namespace = ownerKey(identity)
					const name =
						"openbot_ui_" +
						Hex.encode(
							yield* crypto.digest(
								"SHA-256",
								new TextEncoder().encode(
									yield* Schema.encodeEffect(
										Schema.fromJsonString(Schema.Array(Schema.String)),
									)([id, request.commandKey]),
								),
							),
						)
					const target = request.kind === "tool" ? request.name : request.uri
					const args = request.kind === "tool" ? request.arguments : {}
					const source: AppViews.ActionSource = {
						_tag: "AppUiAction",
						viewId: view.id,
						requestId: request.commandKey,
						connectionId: view.connectionId,
						revision: view.revision,
						kind: request.kind,
						target,
					}
					const action = { name, arguments: args, source }
					// The public command is checked before discovery. A retry keeps its first definition.
					const command = {
						actor: identity,
						body: { kind: "app-view-action", view: id, request },
					}
					const previous = yield* store.receipt(
						namespace,
						request.commandKey,
						command,
					)
					if (Option.isSome(previous)) {
						const execution = yield* store.get({
							namespace,
							id: previous.value.executionId,
						})
						return {
							...previous.value,
							chat: view.chat,
							turn: Turn.Id.make(execution.resource.id),
						}
					}
					const opened = yield* openClient(identity, view.connectionId)
					if (opened.stored.revision !== view.revision)
						return yield* viewUnavailable("ConnectionChanged")
					const resolved = yield* opened.client
						.resolve({ kind: request.kind, name: target }, "host")
						.pipe(
							replaceUnavailable(
								"OpenBot could not read the action of an App view",
								"Declaration",
							),
						)
					if (Option.isNone(resolved))
						return yield* viewUnavailable("Declaration")
					const declaration = resolved.value
					const original = yield* apps.read(identity, view.operationId)
					const origin: AppCalls.Source = {
						...original.source,
						kind: request.kind,
						name: target,
						definition: yield* json(declaration.definition),
					}
					const parameters =
						declaration.kind === "tool"
							? yield* jsonObject(declaration.definition.inputSchema)
							: { type: "object", properties: {}, additionalProperties: false }
					const actionDefinition = {
						name,
						parameters,
						readOnly: yield* policy.isRead({
							organizationId: identity.organizationId,
							source: origin,
						}),
						local: true,
						idempotent: false,
						inputState: yield* json({
							kind: "app",
							input: "host",
							source: origin,
						}),
					}
					const receipt = yield* sql
						.withTransaction(
							store.accept(namespace, request.commandKey, command, () =>
								Effect.gen(function* () {
									yield* db
										.select()
										.from(appSecrets)
										.where(StoredViews.where(namespace, "app-view", id))
										.for("update")
									yield* bound(identity, id)
									const receipt = yield* inputs
										.message(
											namespace,
											Execution.CommandKey.make(yield* newId),
											{
												caller: identity,
												chat: view.chat,
												content: Prompt.make("Host-selected action: " + name),
												queue: true,
												action,
												actionDefinition,
											},
										)
										.pipe(ChatErrors.map)
									return { executionId: receipt.executionId, start: false }
								}),
							),
						)
						.pipe(transactionFailures)
					const execution = yield* store.get({
						namespace,
						id: receipt.executionId,
					})
					return {
						...receipt,
						chat: view.chat,
						turn: Turn.Id.make(execution.resource.id),
					}
				}),
			),
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
			commandKey: Execution.CommandKey,
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
					const receipt = yield* inputs
						.message(ownerKey(identity), commandKey, {
							caller: identity,
							chat: view.chat,
							queue: false,
							notice: { kind: "app", ref: view.id },
							content: Prompt.make(
								"Confirmed message from App " +
									view.connectionId +
									":\n" +
									Arr.join(
										Arr.map(message.content, (part) => part.text),
										"\n",
									),
							),
						})
						.pipe(ChatErrors.map)
					const execution = yield* store.get({
						namespace: ownerKey(identity),
						id: receipt.executionId,
					})
					return {
						...receipt,
						chat: view.chat,
						turn: Turn.Id.make(execution.resource.id),
					}
				}),
			),
	})
})

export const layer = Layer.effect(Views, make)
