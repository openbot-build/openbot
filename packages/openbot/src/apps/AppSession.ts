import { Calls } from "../execution/Calls.ts"
import { AppCalls, Authorization, Execution } from "@openbot-build/domain"
import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
} from "effect"
import * as Gate from "../capabilities/Gate.ts"
import { RequestCommands } from "../capabilities/RequestCommands.ts"
import * as CallFrame from "../chats/CallFrame.ts"
import { type Fence } from "../execution/Store.ts"
import { ActionPolicy } from "./ActionPolicy.ts"
import * as AppCall from "./AppCall.ts"
import { AppCommands, continuation } from "./AppCommands.ts"
import { json } from "./AppResults.ts"
import { Capabilities, type Opened } from "./Capabilities.ts"
import { ownerKey, get as connection } from "./StoredConnections.ts"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as AppSecrets from "../vaults/AppSecrets.ts"
import * as VaultCode from "../vaults/CodeMode.ts"

const declaration = (
	opened: Opened,
	source: AppCalls.Source,
): Option.Option<unknown> => {
	switch (source.kind) {
		case "tool":
			return Arr.findFirst(opened.tools, (value) => value.name === source.name)
		case "resource":
			return Arr.findFirst(
				opened.resources,
				(value) => value.uri === source.name,
			)
		case "template":
			return Arr.findFirst(
				opened.resourceTemplates,
				(value) => value.uriTemplate === source.name,
			)
		case "prompt":
			return Arr.findFirst(
				opened.prompts,
				(value) => value.name === source.name,
			)
	}
}
const sameJson = Schema.toEquivalence(Schema.Json)
const strings = Schema.decodeUnknownEffect(
	Schema.Record(Schema.String, Schema.String),
)

/** One phase opens the connection. Waiting and saved results need no live client. */
const open = (fence: Fence) =>
	Effect.gen(function* () {
		const commands = yield* AppCommands
		const checks = yield* Check.make
		const db = yield* Db.make
		const secrets = yield* Secrets
		const requests = yield* RequestCommands
		const frames = yield* CallFrame.make
		const actions = yield* ActionPolicy
		const capabilities = yield* Capabilities
		const executionCalls = yield* Calls
		const calls = yield* AppCall.make
		const vault = yield* AppSecrets.make
		const saved = yield* commands.load(fence)
		const frame = yield* frames.read(fence, saved.input.site)
		const gate = yield* Gate.durable(
			fence,
			{
				identity: frame.identity,
				chat: frame.position.chat,
				turn: frame.position.turn,
			},
			"workflow",
		)
		const input = saved.input
		const source = input.source
		const owner = ownerKey(saved.execution.identity.owner)
		const currentRead = Effect.gen(function* () {
			if (
				(yield* actions.isRead({
					organizationId: saved.execution.identity.owner.organizationId,
					source,
				})) !== input.readOnly
			)
				return yield* Execution.Conflict.make({ id: fence.id })
		})
		const proposal: AppCalls.Invocation = {
			id: saved.id,
			chat: frame.position.chat,
			turn: frame.position.turn,
			callId: input.site.main,
			toolName: input.toolName,
			source,
			arguments: input.arguments,
			readOnly: input.readOnly,
			round: 0,
			status: "PendingApproval",
			result: null,
		}
		const permission = Effect.gen(function* () {
			yield* commands.authorize(
				fence,
				saved.execution.identity.actor,
				"advance",
			)
			yield* currentRead
			yield* vault.check(
				saved.execution.identity,
				source,
				input.arguments,
				input.vault ?? [],
			)
			const answer = yield* gate.check({
				capability: {
					action: "apps.call",
					target: source.connectionId + "/" + source.name,
				},
				reason: input.reason,
				site: input.site,
				app: proposal,
				implicit:
					input.readOnly && VaultCode.find(input.arguments).length === 0,
				...(input.code === undefined ? {} : { code: input.code }),
			})
			if (answer._tag === "Deny") return yield* Execution.Forbidden.make({})
			if (answer._tag === "Allow") return { _tag: "Ready" } as const
			if (answer.executionId === undefined)
				return yield* Execution.Conflict.make({ id: fence.id })
			const key = { namespace: fence.namespace, id: answer.executionId }
			const request = yield* requests.load(key)
			if (
				request.sourceKey.id !== fence.id ||
				request.continuation !== "workflow"
			)
				return yield* Execution.Forbidden.make({})
			if (!Execution.isTerminal(request.execution.record.status))
				return { _tag: "Approval", key } as const
			if (
				request.execution.record.status !== "completed" ||
				request.stored.request.status !== "allowed"
			)
				return yield* Execution.Forbidden.make({})
			return { _tag: "Ready" } as const
		})
		const send = Effect.gen(function* () {
			const phase = yield* commands.current(fence)
			if (phase._tag !== "Send") return
			yield* executionCalls.ready(fence)
			const ready = Effect.gen(function* () {
				if ((yield* permission)._tag !== "Ready")
					return yield* Execution.Conflict.make({ id: fence.id })
				const target = {
					action: "use" as const,
					resource: Authorization.App.make({
						organizationId: saved.execution.identity.owner.organizationId,
						ownerUserId: saved.execution.identity.owner.userId,
					}),
				}
				yield* Check.execution(checks, saved.execution.identity, target)
				if (Option.isSome(phase.answer)) {
					yield* commands.authorize(fence, phase.answer.value.actor, "decide")
					yield* checks.check(phase.answer.value.actor, target)
				}
				const current = yield* connection(
					db,
					secrets,
					owner,
					source.connectionId,
				)
				const cardUrl = yield* Schema.decodeEffect(
					AppCalls.Source.fields.cardUrl,
				)(current.connection.cardUrl)
				if (
					current.revision !== source.revision ||
					current.connection.state !== "Enabled" ||
					cardUrl !== source.cardUrl ||
					current.connection.remoteIndex !== source.remoteIndex
				)
					return yield* Execution.Conflict.make({ id: fence.id })
			})
			yield* ready
			const method =
				source.kind === "tool"
					? "tools/call"
					: source.kind === "prompt"
						? "prompts/get"
						: "resources/read"
			const policy = Client.InvocationPolicy.of({
				check: (invocation) =>
					invocation.connection.owner === owner &&
					invocation.connection.connectionId === source.connectionId &&
					(Schema.is(Client.ListAction)(invocation.action) ||
						(invocation.action === method &&
							(invocation.target === source.name ||
								source.kind === "template")))
						? Effect.void
						: Effect.fail(
								Client.PermissionDenied.make({
									action: invocation.action,
									target: invocation.target,
								}),
							),
			})
			const opened = yield* capabilities.open({
				owner,
				connectionId: source.connectionId,
				policy,
			})
			const found = declaration(opened, source)
			if (
				opened.stored.revision !== source.revision ||
				Option.isNone(found) ||
				source.definition === undefined ||
				!sameJson(source.definition, yield* json(found.value))
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			const prepared = yield* Ref.make<
				Option.Option<Effect.Success<ReturnType<typeof vault.prepare>>>
			>(Option.none())
			const prepare = Effect.gen(function* () {
				yield* ready
				const values = yield* vault.prepare(
					saved.execution.identity,
					source,
					input.arguments,
					input.vault ?? [],
				)
				yield* ready
				yield* Ref.set(prepared, Option.some(values))
			})
			const options = { source: "host", readOnly: input.readOnly } as const
			const operation = Effect.gen(function* (): Effect.fn.Return<
				Client.OperationResult<unknown>,
				Client.Error | Schema.SchemaError
			> {
				const values = Option.getOrThrow(yield* Ref.get(prepared))
				const arguments_ = Redacted.value(values.arguments)
				if (
					phase.input.continuation !== undefined &&
					VaultCode.find(input.arguments).length > 0
				)
					return yield* Client.ClientError.make({
						reason: "InputUnavailable",
						issue: "An App call with Vault values cannot ask for more input.",
					})
				if (phase.input.continuation !== undefined)
					return yield* opened.client.resume(
						continuation(input, phase.input.continuation.request),
						phase.input.continuation.responses,
						options,
					)
				switch (source.kind) {
					case "tool":
						return yield* opened.client.callTool(
							{ name: source.name, arguments: arguments_ },
							options,
						)
					case "resource":
						return yield* opened.client.readResource(
							{ uri: source.name },
							options,
						)
					case "template":
						return yield* opened.client.readTemplate({
							template: source.name,
							values: yield* strings(input.arguments),
							source: "host",
						})
					case "prompt":
						return yield* opened.client.getPrompt(
							{ name: source.name, arguments: yield* strings(input.arguments) },
							options,
						)
				}
			})
			// The common call log checks its fence after this last policy check and before sending.
			yield* calls.invoke(
				fence,
				phase.input,
				operation.pipe(
					Effect.flatMap((result) =>
						Effect.flatMap(Ref.get(prepared), (values) =>
							Option.getOrThrow(values).result(result),
						),
					),
				),
				prepare,
			)
		})
		return { permission, send: send.pipe(Effect.asVoid) }
	})
const make = Effect.gen(function* () {
	const services =
		yield* Effect.context<Effect.Services<ReturnType<typeof open>>>()
	return {
		open: (fence: Fence) => open(fence).pipe(Effect.provideContext(services)),
	}
})
export class AppSession extends Context.Service<
	AppSession,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/AppSession") {}
export const layer = Layer.effect(AppSession, make)
