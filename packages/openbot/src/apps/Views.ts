import { randomUUID } from "node:crypto"
import { Chat, Item } from "@openbot-build/core"
import {
	AppViewsApi as Api,
	ExperienceNotFound,
	Identity,
	ChatConflict,
} from "@openbot-build/api"
import { AppUi, Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Schema,
} from "effect"
import { Backend } from "../app/Backend.ts"
import { Capabilities } from "./Capabilities.ts"
import { ConnectionLocks } from "./ConnectionLocks.ts"
import { eq } from "drizzle-orm"
import { appSecrets } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import * as StoredInvocations from "./StoredInvocations.ts"
import * as StoredViews from "./StoredViews.ts"
import { type Action, type View } from "./StoredViews.ts"
import { json } from "./AppResults.ts"
import * as Db from "../database/Database.ts"

const unavailable = (reason: Api.AppViewUnavailable["reason"] = "Protocol") =>
	Api.AppViewUnavailable.make({
		reason,
		message:
			"This App view is unavailable. Its recorded text and business result are still available.",
	})
const conflict = () =>
	ChatConflict.make({
		message:
			"The Chat or App view changed. Read its current state before continuing.",
	})
export const make = Effect.gen(function* () {
	const backend = yield* Backend
	const capabilities = yield* Capabilities
	const locks = yield* ConnectionLocks
	const db = yield* Db.make
	const secrets = yield* Secrets
	// A view that was open when the host stopped can not continue.
	yield* db
		.update(appSecrets)
		.set({ consumed: true })
		.where(eq(appSecrets.kind, "app-view"))
		.pipe(Effect.mapError(StoredViews.unavailable))
	const read = (owner: string, kind: string, id: string) =>
		db
			.select()
			.from(appSecrets)
			.where(StoredViews.where(owner, kind, id))
			.pipe(Effect.map(Arr.head))
	const required = <A>(found: Option.Option<A>) =>
		Effect.fromOption(found).pipe(Effect.mapError(StoredViews.missing))
	const getView = (owner: string, id: string) =>
		read(owner, "app-view", id).pipe(
			Effect.map(Option.filter((row) => !row.consumed)),
			Effect.flatMap(required),
			Effect.flatMap((row) => StoredViews.open(secrets, StoredViews.View, row)),
			Effect.mapError(StoredViews.failure),
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
		}).pipe(Effect.mapError(StoredViews.failure))
	const closeView = (owner: string, id: string) =>
		db
			.update(appSecrets)
			.set({ consumed: true })
			.where(StoredViews.where(owner, "app-view", id))
			.returning({ id: appSecrets.id })
			.pipe(
				Effect.flatMap((rows) =>
					rows.length === 0 ? Effect.fail(StoredViews.missing()) : Effect.void,
				),
				Effect.mapError(StoredViews.failure),
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
		}).pipe(Effect.mapError(StoredViews.failure))
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
					if (row === undefined) return yield* StoredViews.missing()
					const previous = yield* StoredViews.open(
						secrets,
						Api.Interaction,
						row,
					)
					if (previous.revision !== revision)
						return yield* StoredViews.conflict()
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
		}).pipe(Effect.mapError(StoredViews.failure))
	const readAction = (owner: string, viewId: string, requestId: string) =>
		read(
			owner,
			"app-view-action",
			StoredViews.actionKey(viewId, requestId),
		).pipe(
			Effect.flatMap(required),
			Effect.flatMap((row) =>
				StoredViews.open(secrets, StoredViews.Action, row),
			),
			Effect.mapError(StoredViews.failure),
		)
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
				return yield* StoredViews.conflict()
			return false
		}).pipe(Effect.mapError(StoredViews.failure))
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
					if (row === undefined) return yield* StoredViews.missing()
					const saved = yield* StoredViews.open(
						secrets,
						StoredViews.Action,
						row,
					)
					if (
						saved.ticket !== null &&
						!Schema.toEquivalence(Api.ActionTicket)(saved.ticket, ticket)
					)
						return yield* StoredViews.conflict()
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
			.pipe(Effect.mapError(StoredViews.failure))
	const chats = (identity: typeof Identity.Service) =>
		backend.forCaller(identity).pipe(Effect.mapError(conflict))
	const bound = (identity: typeof Identity.Service, id: string) =>
		Effect.gen(function* () {
			const view = yield* getView(ownerKey(identity), id)
			if (view.expiresAt < (yield* Clock.currentTimeMillis))
				return yield* unavailable("Closed")
			const stored = yield* StoredConnections.get(
				db,
				secrets,
				ownerKey(identity),
				view.connectionId,
			).pipe(Effect.mapError(() => unavailable("ConnectionChanged")))
			if (
				stored.connection.state !== "Enabled" ||
				stored.revision !== view.revision
			)
				return yield* unavailable("ConnectionChanged")
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
	) =>
		capabilities
			.open({
				owner: ownerKey(identity),
				connectionId,
				policy: Client.InvocationPolicy.of({
					check: (invocation) =>
						invocation.connection.owner === ownerKey(identity) &&
						invocation.connection.connectionId === connectionId &&
						(invocation.action.endsWith("/list") ||
							invocation.action === "resources/read")
							? Effect.void
							: Effect.fail(
									new Client.PermissionDenied({
										action: invocation.action,
										target: invocation.target,
									}),
								),
				}),
			})
			.pipe(Effect.mapError(() => unavailable("ConnectionChanged")))
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
				.pipe(Effect.mapError(conflict))
			const item = items.find(
				(item) =>
					(itemId === undefined || item.id === itemId) &&
					item.content.content.some(
						(message) =>
							message.role === "tool" &&
							message.content.some(
								(part) =>
									part.type === "tool-result" && part.id === operation.callId,
							),
					),
			)
			if (item === undefined || item.origin?.turn !== operation.turn)
				return yield* ExperienceNotFound.make({ id: operationId })
			return { operation, item, service }
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
						return yield* unavailable("Declaration")
					const opened = yield* openClient(
						identity,
						operation.source.connectionId,
					)
					if (opened.stored.revision !== operation.source.revision)
						return yield* unavailable("ConnectionChanged")
					const tool = opened.tools.find(
						(tool) => tool.name === operation.source.name,
					)
					if (
						tool === undefined ||
						operation.source.definition === undefined ||
						!Schema.toEquivalence(Schema.Json)(
							operation.source.definition,
							yield* json(tool).pipe(Effect.mapError(() => unavailable())),
						)
					)
						return yield* unavailable("Declaration")
					const uri = yield* AppUi.toolResourceUri(tool).pipe(
						Effect.mapError(() => unavailable("Declaration")),
					)
					const content = yield* opened.client
						.readResource({ uri }, { source: "host", readOnly: true })
						.pipe(Effect.mapError(() => unavailable("Resource")))
					if (content._tag !== "Completed")
						return yield* unavailable("Resource")
					const resource = yield* AppUi.readResource(uri, content.result).pipe(
						Effect.mapError(() => unavailable("Resource")),
					)
					const view: View = {
						id: randomUUID(),
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
								).pipe(Effect.mapError(() => unavailable()))
							: undefined
					return {
						...(yield* binding(identity, view)),
						resource,
						tools: yield* Effect.forEach(opened.tools, (tool) =>
							json(tool).pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
								Effect.mapError(() => unavailable()),
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
						return yield* unavailable("ConnectionChanged")
					const cursor = yield* Schema.decodeEffect(
						Schema.Struct({ cursor: Schema.optionalKey(Schema.String) }),
					)(params).pipe(Effect.mapError(() => unavailable()))
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
						Effect.mapError(() => unavailable()),
					)
					return yield* json(result).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
						Effect.mapError(() => unavailable()),
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
						if (view.readOnly) return yield* conflict()
						const existing = yield* readAction(
							ownerKey(identity),
							id,
							request.requestId,
						).pipe(
							Effect.asSome,
							Effect.catchTag("ExperienceNotFound", () => Effect.succeedNone),
						)
						if (Option.isSome(existing)) {
							yield* claimAction(ownerKey(identity), view, {
								requestId: request.requestId,
								kind: request.kind,
								target: request.kind === "tool" ? request.name : request.uri,
								arguments: request.kind === "tool" ? request.arguments : {},
								ticket: null,
							})
							if (existing.value.ticket === null) return yield* conflict()
							return existing.value.ticket
						}

						const service = yield* chats(identity)
						const current = yield* service
							.get(view.chat)
							.pipe(Effect.mapError(conflict))
						if (
							current.activity === "historical" ||
							(current.activity === "active" && current.turn?.id !== view.turn)
						)
							return yield* conflict()
						const opened = yield* openClient(identity, view.connectionId)
						if (opened.stored.revision !== view.revision)
							return yield* unavailable("ConnectionChanged")
						const target = request.kind === "tool" ? request.name : request.uri
						if (
							request.kind === "tool"
								? !opened.tools.some((tool) => tool.name === target)
								: !opened.resources.some((resource) => resource.uri === target)
						)
							return yield* unavailable("Declaration")
						const args = request.kind === "tool" ? request.arguments : {}
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
							return yield* conflict()
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
						const ticket = yield* service
							.startAction(view.chat, {
								author: identity.userId,
								action: {
									name: "openbot_ui_" + randomUUID().replaceAll("-", ""),
									arguments: args,
									source,
								},
								...(current.activity === "active" ? { turn: view.turn } : {}),
							})
							.pipe(Effect.mapError(conflict))
						yield* acceptAction(
							ownerKey(identity),
							view,
							request.requestId,
							ticket,
						)
						return ticket
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
				if (saved.ticket === null) return yield* conflict()
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
					Effect.mapError(conflict),
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
						? Effect.fail(conflict())
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
					if (view.readOnly) return yield* conflict()
					const message = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							content: Schema.Array(
								Schema.Struct({
									type: Schema.Literal("text"),
									text: Schema.String,
								}),
							),
						}),
					)(content).pipe(Effect.mapError(() => unavailable("Unsupported")))
					// The message reaches the Bot at its next step, or starts a Turn.
					const service = yield* chats(identity)
					yield* service
						.deliver(view.chat, {
							input:
								"Confirmed message from App " +
								view.connectionId +
								":\n" +
								message.content.map((part) => part.text).join("\n"),
							author: identity.userId,
							notice: { kind: "app", ref: view.connectionId },
						})
						.pipe(Effect.mapError(conflict))
				}),
			),
	}
})
export class Views extends Context.Service<
	Views,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/Views") {}
export const layer = Layer.effect(Views, make)
