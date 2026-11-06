import { CapabilityRequestId } from "@openbot-build/domain/CapabilityRequestId"
import type { Caller } from "@openbot-build/domain/Identity"
import * as ChatHost from "../chats/ChatHost.ts"
import { Execution, Requests as RequestDomain } from "@openbot-build/domain"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import * as Db from "@openbot-build/server-database/Database"
import * as Check from "@openbot-build/identity-contract/authorization/Check"
import { toWhere } from "@openbot-build/identity-contract/authorization/Sql"
import { botRecords } from "@openbot-build/server-database/Schema"
import { deciderKey } from "./Rules.ts"
import { executions } from "@openbot-build/server-database/ExecutionSchema"
import { Store, storage } from "@openbot-build/server-execution/Store"
import { RequestCommands, workflowName } from "./RequestCommands.ts"
import { Requests } from "./Requests.ts"

/** HTTP and Channel decisions use the same saved command and current rights. */
export const make = Effect.gen(function* () {
	const requests = yield* Requests
	const commands = yield* RequestCommands
	const db = yield* Db.make
	const checks = yield* Check.make
	const store = yield* Store
	const visible = (caller: Caller, id: string) =>
		requests.find(caller.organizationId, id).pipe(
			Effect.flatMap((found) =>
				Option.isSome(found) && found.value.chain.userId === caller.userId
					? Effect.succeed(found.value)
					: Effect.fail(
							RequestDomain.RequestNotFound.make({
								request: CapabilityRequestId.make(id),
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
					eq(executions.workflow, workflowName),
					eq(executions.userId, ChatHost.ownerOf(stored.chain)),
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
		yield* commands.authorize(key, caller, "read")
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
