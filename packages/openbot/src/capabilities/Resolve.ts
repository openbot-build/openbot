import * as ChatHost from "../chats/ChatHost.ts"
import {
	Caller,
	Authorization,
	Execution,
	Requests as RequestDomain,
} from "@openbot-build/domain"
import { and, eq, or, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import * as Check from "../authorization/Check.ts"
import { toWhere } from "../authorization/Sql.ts"
import { botRecords } from "../database/Schema.ts"
import { deciderKey } from "./Rules.ts"
import { executions } from "../database/ExecutionSchema.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import * as Imported from "../database/conversion/Executions.ts"
import * as ImportedWorkflow from "../database/conversion/ImportedWorkflow.ts"
import { Store, storage } from "../execution/Store.ts"
import { RequestCommands, workflowName } from "./RequestCommands.ts"
import { Requests } from "./Requests.ts"

/** HTTP and Channel decisions use the same saved command and current rights. */
export const make = Effect.gen(function* () {
	const requests = yield* Requests
	const commands = yield* RequestCommands
	const db = yield* Db.make
	const checks = yield* Check.make
	const imported = yield* ImportedWorkflow.make
	const store = yield* Store
	const visible = (caller: Caller, id: string) =>
		requests.find(caller.organizationId, id).pipe(
			Effect.flatMap((found) =>
				Option.isSome(found) && found.value.chain.userId === caller.userId
					? Effect.succeed(found.value)
					: Effect.fail(
							RequestDomain.RequestNotFound.make({
								request: RequestDomain.CapabilityRequestId.make(id),
							}),
						),
			),
		)
	const execution = Effect.fn("RequestResolution.execution")(function* (
		caller: Caller,
		id: string,
	) {
		const stored = yield* visible(caller, id)
		const rows = yield* db
			.select({ namespace: executions.namespace, id: executions.id })
			.from(executions)
			.where(
				and(
					eq(executions.organizationId, caller.organizationId),
					or(
						and(
							eq(executions.workflow, workflowName),
							eq(executions.userId, ChatHost.ownerOf(stored.chain)),
						),
						and(
							eq(executions.workflow, Imported.workflowName),
							eq(
								executions.namespace,
								ownerKey({
									organizationId: caller.organizationId,
									userId: ChatHost.ownerOf(stored.chain),
								}),
							),
						),
					),
					eq(executions.resourceKind, "Request"),
					eq(executions.resourceId, id),
				),
			)
			.limit(2)
			.pipe(storage)
		if (rows.length !== 1 || rows[0] === undefined)
			return yield* RequestDomain.RequestConflict.make({
				message: "The request has no single execution.",
			})
		return {
			namespace: rows[0].namespace,
			id: yield* Schema.decodeEffect(Execution.Id)(rows[0].id).pipe(storage),
		}
	})
	const view = Effect.fn("RequestResolution.view")(function* (
		caller: Caller,
		id: string,
	) {
		const key = yield* execution(caller, id)
		const saved = yield* store.load(key)
		if (saved.workflow === Imported.workflowName) {
			yield* imported.read(key, caller)
			yield* checks
				.check(caller, {
					action: "resolve",
					resource: Authorization.Request.make({
						organizationId: caller.organizationId,
						ownerUserId: caller.userId,
						id: RequestDomain.CapabilityRequestId.make(id),
					}),
				})
				.pipe(
					Effect.catchTags({
						Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
						Pending: () => Effect.fail(Execution.Forbidden.make({})),
					}),
					storage,
				)
		} else yield* commands.authorize(key, caller, "read")
		return {
			...(yield* visible(caller, id)).request,
			executionId: key.id,
			executionStatus: saved.record.status,
		}
	})
	const resolveAsPerson = Effect.fn("RequestResolution.decide")(function* (
		caller: Caller,
		id: string,
		payload: RequestDomain.PersonDecision,
	) {
		const key = yield* execution(caller, id)
		if ((yield* store.load(key)).workflow === Imported.workflowName) {
			yield* view(caller, id)
			return yield* RequestDomain.RequestConflict.make({
				message:
					"This request belongs to old work. Send new Chat input to ask again.",
			})
		}
		return yield* commands.decide(key, caller, {
			commandKey: payload.commandKey,
			decisionId: `request:${payload.expected}`,
			answer: payload.decision,
			details: {
				...(payload.scope === undefined ? {} : { scope: payload.scope }),
				...(payload.reason === undefined ? {} : { reason: payload.reason }),
				...(payload.rule === undefined ? {} : { rule: payload.rule }),
			},
		})
	})
	const list = Effect.fn("RequestResolution.list")(function* (
		caller: Caller,
		status?: RequestDomain.RequestStatus,
	) {
		const condition = yield* checks.filter(caller, {
			action: "resolve",
			kind: "Request",
			within: ($) =>
				$.and(
					$.eq("organizationId", caller.organizationId),
					$.eq("ownerUserId", caller.userId),
				),
		})
		const allowed = yield* toWhere(condition, {
			organizationId: botRecords.organizationId,
			ownerUserId: sql`${caller.userId}`,
			id: botRecords.id,
		})
		const rows = yield* db
			.select({ id: botRecords.id })
			.from(botRecords)
			.where(
				and(
					eq(botRecords.kind, "request"),
					eq(botRecords.organizationId, caller.organizationId),
					eq(
						botRecords.owner,
						deciderKey({ _tag: "Person", userId: caller.userId }),
					),
					status === undefined ? undefined : eq(botRecords.status, status),
					allowed,
				),
			)
			.orderBy(botRecords.id)
			.pipe(storage)
		return yield* Effect.forEach(rows, (row) => view(caller, row.id))
	})
	return { visible, view, list, resolveAsPerson }
})
