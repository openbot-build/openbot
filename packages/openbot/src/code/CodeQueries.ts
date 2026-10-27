import * as Imported from "../database/conversion/Executions.ts"
import * as ImportedHistory from "../apps/ImportedHistory.ts"
import { AppCommands } from "../apps/AppCommands.ts"
import { CallInput, Submitted } from "./CodeCall.ts"
import { type Chat } from "@openbot-build/core"
import {
	Authorization,
	type Caller,
	Execution,
	ExperienceNotFound,
	CodeRuns as Domain,
} from "@openbot-build/domain"
import { and, asc, eq, or } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Option,
	Schema,
	String as Str,
	Order,
	Number as Num,
} from "effect"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import {
	executions,
	toolOrigins,
	toolExecutions,
} from "../database/ExecutionSchema.ts"
import { Store, transactionFailures } from "../execution/Store.ts"
import { ownerKey } from "../apps/StoredConnections.ts"
import { CodeCommands } from "./CodeCommands.ts"

/** Lists and single reads use the same saved source Chat and current rights. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const checks = yield* Check.make
	const history = yield* ImportedHistory.make
	const work = yield* CodeCommands
	const apps = yield* AppCommands
	const store = yield* Store
	const locate = Effect.fn("CodeQueries.locate")(function* (
		caller: Caller,
		id: Domain.CodeRunId,
	) {
		const found = Arr.head(
			yield* db
				.select({
					id: executions.id,
					namespace: executions.namespace,
					workflow: executions.workflow,
				})
				.from(executions)
				.where(
					and(
						eq(executions.namespace, ownerKey(caller)),
						eq(executions.organizationId, caller.organizationId),
						eq(executions.resourceKind, "CodeRun"),
						eq(executions.resourceId, id),
					),
				)
				.limit(1),
		)
		if (Option.isNone(found)) return yield* ExperienceNotFound.make({ id })
		const key = {
			namespace: found.value.namespace,
			id: Execution.Id.make(found.value.id),
		}
		const old = found.value.workflow === Imported.workflowName
		if (!old) yield* work.authorize(key, caller, "read")
		return { key, old }
	}, transactionFailures)
	const read = Effect.fn("CodeQueries.read")(function* (
		caller: Caller,
		id: Domain.CodeRunId,
	) {
		const { key, old } = yield* locate(caller, id)
		if (old) return yield* history.code(key, caller)
		const calls = yield* Effect.forEach(
			Arr.filter(yield* store.calls(key), (call) =>
				Str.startsWith("code:")(call.step),
			),
			(call) =>
				Effect.gen(function* () {
					const input = yield* Schema.decodeUnknownEffect(CallInput)(call.input)
					if (call.status !== "completed")
						return {
							index: input.index,
							binding: input.binding,
							app: null,
							rejection: null,
						}
					const result = yield* Schema.decodeUnknownEffect(Submitted)(
						call.result,
					)
					if (result._tag === "Rejected")
						return {
							index: input.index,
							binding: input.binding,
							app: null,
							rejection: { name: result.name, message: result.message },
						}
					const child = { namespace: key.namespace, id: result.executionId }
					const saved = yield* apps.load(child)
					if (
						saved.sourceKey.id !== key.id ||
						saved.input.code?.run !== id ||
						saved.input.code.index !== input.index
					)
						return yield* Execution.Conflict.make({ id: key.id })
					yield* apps.authorize(child, caller, "read")
					return {
						index: input.index,
						binding: input.binding,
						app: yield* apps.view(child),
						rejection: null,
					}
				}),
		)
		return Domain.ExecutionView.make({
			...(yield* work.view(key)),
			calls: Arr.sort(
				calls,
				Order.mapInput(Num.Order, (call: Domain.CallView) => call.index),
			),
		})
	}, transactionFailures)
	const list = Effect.fn("CodeQueries.list")(function* (
		caller: Caller,
		chat: Chat.Id,
	) {
		yield* checks.check(caller, {
			action: "read",
			resource: Authorization.Chat.make({
				organizationId: caller.organizationId,
				ownerUserId: caller.userId,
				id: chat,
			}),
		})
		const rows = yield* db
			.select({ id: executions.resourceId })
			.from(executions)
			.leftJoin(
				toolOrigins,
				and(
					eq(toolOrigins.namespace, executions.namespace),
					eq(toolOrigins.executionId, executions.id),
				),
			)
			.leftJoin(
				toolExecutions,
				and(
					eq(toolExecutions.namespace, toolOrigins.namespace),
					eq(toolExecutions.executionId, toolOrigins.toolExecutionId),
				),
			)
			.where(
				and(
					eq(executions.namespace, ownerKey(caller)),
					eq(executions.organizationId, caller.organizationId),
					eq(executions.resourceKind, "CodeRun"),
					or(
						eq(toolExecutions.chat, chat),
						and(
							eq(executions.workflow, Imported.workflowName),
							eq(executions.contextKind, "Chat"),
							eq(executions.contextId, chat),
						),
					),
				),
			)
			.orderBy(asc(executions.createdAt), asc(executions.id))
		return yield* Effect.forEach(rows, (row) =>
			read(caller, Domain.CodeRunId.make(row.id)),
		)
	}, transactionFailures)
	return { read, list }
})
