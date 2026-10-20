import { randomUUID } from "node:crypto"
import { Item, Memory, Session } from "@openbot-build/core"
import {
	AppViewsApi as Api,
	ExperienceNotFound,
	Identity,
	SessionConflict,
} from "@openbot-build/platform-api"
import { AppUi, Client } from "@openbot-build/protocol"
import { Context, Effect, Layer, Match, Schema } from "effect"
import { Backend } from "../app/Backend.ts"
import { Capabilities } from "./Capabilities.ts"
import { ConnectionLocks } from "./ConnectionLocks.ts"
import { InvocationRepository } from "./InvocationRepository.ts"
import { Repository, ownerKey } from "./Repository.ts"
import { ViewRepository, type View } from "./ViewRepository.ts"
import { json } from "./AppResults.ts"

const unavailable = (reason: Api.AppViewUnavailable["reason"] = "Protocol") =>
	Api.AppViewUnavailable.make({
		reason,
		message:
			"This App view is unavailable. Its recorded text and business result are still available.",
	})
const conflict = () =>
	SessionConflict.make({
		message:
			"The Session or App view changed. Read its current state before continuing.",
	})
export const make = Effect.gen(function* () {
	const backend = yield* Backend
	const capabilities = yield* Capabilities
	const records = yield* InvocationRepository
	const views = yield* ViewRepository
	const connections = yield* Repository
	const locks = yield* ConnectionLocks
	const sessions = (identity: typeof Identity.Service) =>
		backend.get(identity.tenantId, identity).pipe(Effect.mapError(conflict))
	const bound = (identity: typeof Identity.Service, id: string) =>
		Effect.gen(function* () {
			const view = yield* views.get(ownerKey(identity), id)
			if (view.expiresAt < Date.now()) return yield* unavailable("Closed")
			const stored = yield* connections
				.get(ownerKey(identity), view.connectionId)
				.pipe(Effect.mapError(() => unavailable("ConnectionChanged")))
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
	const historyBinding = (
		identity: typeof Identity.Service,
		operationId: string,
		sessionId: Session.Id,
		itemId?: Item.Id,
		version?: Memory.VersionId,
	) =>
		Effect.gen(function* () {
			const operation = yield* records.get(ownerKey(identity), operationId)
			const service = yield* sessions(identity)
			const history = yield* service
				.history(sessionId, version)
				.pipe(Effect.mapError(conflict))
			const item = history.value.memory.history.find(
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
			const operation = yield* records.get(ownerKey(identity), view.operationId)
			return {
				id: view.id,
				operationId: view.operationId,
				readOnly: view.readOnly,
				session: view.session,
				turn: view.turn,
				item: view.item,
				source: operation.source,
				interaction: yield* views.interaction(
					ownerKey(identity),
					view.session,
					view.operationId,
				),
			}
		})
	return {
		open: (
			identity: typeof Identity.Service,
			operationId: string,
			sessionId: Session.Id,
			itemId: Item.Id,
			version?: Memory.VersionId,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { operation, item } = yield* historyBinding(
						identity,
						operationId,
						sessionId,
						itemId,
						version,
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
						readOnly: version !== undefined,
						session: sessionId,
						turn: operation.turn,
						item: item.id,
						connectionId: operation.source.connectionId,
						revision: operation.source.revision,
						expiresAt: Date.now() + 7_200_000,
					}
					yield* views.open(ownerKey(identity), view)
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
			locked(identity, id, views.close(ownerKey(identity), id)),
		read: (
			identity: typeof Identity.Service,
			id: string,
			method: "tools/list" | "resources/list" | "resources/templates/list",
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
						const existing = yield* views
							.action(ownerKey(identity), id, request.requestId)
							.pipe(Effect.catchTag("ExperienceNotFound", () => Effect.void))
						if (existing !== undefined) {
							yield* views.claim(ownerKey(identity), view, {
								requestId: request.requestId,
								kind: request.kind,
								target: request.kind === "tool" ? request.name : request.uri,
								arguments: request.kind === "tool" ? request.arguments : {},
								ticket: null,
							})
							if (existing.ticket === null) return yield* conflict()
							return existing.ticket
						}

						const service = yield* sessions(identity)
						const current = yield* service
							.get(view.session)
							.pipe(Effect.mapError(conflict))
						if (
							current.activity === "historical" ||
							(current.activity === "active" &&
								Session.currentTurn(current.session)?.id !== view.turn)
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
						const first = yield* views.claim(ownerKey(identity), view, {
							requestId: request.requestId,
							kind: request.kind,
							target,
							arguments: args,
							ticket: null,
						})
						if (!first) {
							const saved = yield* views.action(
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
							.startAction(view.session, {
								expected: current.session.revision,
								action: {
									name: "openbot_ui_" + randomUUID().replaceAll("-", ""),
									arguments: args,
									source,
								},
								...(current.activity === "active" ? { turn: view.turn } : {}),
							})
							.pipe(Effect.mapError(conflict))
						yield* views.accepted(
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
				const saved = yield* views.action(ownerKey(identity), id, requestId)
				if (saved.ticket === null) return yield* conflict()
				const ticket = saved.ticket
				const operation =
					(yield* records.list(ownerKey(identity), ticket.session)).find(
						(operation) =>
							operation.turn === ticket.turn &&
							operation.callId === ticket.callId,
					) ?? null
				if (operation !== null)
					return { ticket, status: operation.status, operation }
				const service = yield* sessions(identity)
				const current = yield* service
					.get(ticket.session)
					.pipe(Effect.mapError(conflict))
				const turn = current.session.turns.find(
					(turn) => turn.id === ticket.turn,
				)
				return {
					ticket,
					status:
						turn === undefined ||
						(turn.status._tag !== "Running" &&
							turn.status._tag !== "WaitingApproval")
							? ("Failed" as const)
							: ("Queued" as const),
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
						: views.confirm(ownerKey(identity), view, revision, context),
				),
			),
		interaction: (
			identity: typeof Identity.Service,
			operationId: string,
			sessionId: Session.Id,
		) =>
			Effect.gen(function* () {
				yield* historyBinding(identity, operationId, sessionId)
				return yield* views.interaction(
					ownerKey(identity),
					sessionId,
					operationId,
				)
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
					const service = yield* sessions(identity)
					const current = yield* service
						.get(view.session)
						.pipe(Effect.mapError(conflict))
					if (current.activity !== "inactive") return yield* conflict()
					yield* service
						.send(view.session, {
							expected: current.session.revision,
							input:
								"Confirmed message from App " +
								view.connectionId +
								":\n" +
								message.content.map((part) => part.text).join("\n"),
						})
						.pipe(Effect.mapError(conflict))
				}),
			),
	}
})
export class Views extends Context.Service<
	Views,
	Effect.Success<typeof make>
>()("@openbot-build/platform/apps/Views") {}
export const layer = Layer.effect(Views, make)
