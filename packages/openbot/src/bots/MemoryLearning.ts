import {
	type MemberExecution,
	Store,
	storage,
	type Key,
	type Fence,
} from "../execution/Store.ts"
import type { BillingStorageError } from "../billing/Billing.ts"
import {
	type ChatStore,
	type Config,
	Chat,
	Item,
	Turn,
} from "@openbot-build/core"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { MemoryBudgetSpent } from "./MemoryBot.ts"
import type { Paused } from "../execution/Admission.ts"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import {
	type Settings as SettingsData,
	Bots as Domain,
	Execution,
	ExecutionIdentity,
} from "@openbot-build/domain"
import { type SqlError, SqlClient } from "effect/sql"
import {
	type Cause,
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	HashSet,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import type { Errors } from "../authorization/Check.ts"
import { inExecution } from "../chats/ChatEncoding.ts"
import { and, asc, eq, gt, lte, max } from "drizzle-orm"
import { LanguageModel, Prompt } from "effect/ai"
import * as Db from "../database/Database.ts"
import { chatItems } from "../database/Schema.ts"
import { executions } from "../database/ExecutionSchema.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import { TurnAccess } from "../chats/TurnAccess.ts"
import * as StoredChats from "../chats/StoredChats.ts"
import * as ChatHost from "../chats/ChatHost.ts"
import { Settings } from "../settings/Settings.ts"
import * as Memory from "../plugins/memory/BotMemory.ts"
import { Bots } from "./Bots.ts"
import { BotRecords } from "./BotRecords.ts"
import { BotMemories, homeOf, newId } from "./BotMemories.ts"
import { MemoryModels } from "./MemoryModels.ts"
import * as Evidence from "./MemoryEvidence.ts"
import * as Rules from "./MemoryRules.ts"

export const workflowName = "openbot.memory-learning"
const Input = Schema.Struct({
	parentExecutionId: Execution.Id,
	chat: Chat.Id,
	turn: Turn.Id,
	home: Schema.Struct({ organizationId: Schema.String, bot: Domain.BotId }),
	own: Schema.Array(Schema.String),
})
const sameIdentity = Schema.toEquivalence(ExecutionIdentity)
export interface Service {
	readonly start: (
		source: Fence,
		chat: Chat.Id,
		turn: Turn.Id,
		own: readonly string[],
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			saved: MemberExecution
			input: typeof Input.Type
			parent: {
				key: { namespace: string; id: Execution.Id }
				saved: MemberExecution
			}
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly authorize: Authorize
	readonly learn: (
		fence: Fence,
	) => Effect.Effect<
		undefined,
		| BillingStorageError
		| Domain.BotStorageUnavailable
		| ChatStore.ChatStoreError
		| Execution.Conflict
		| EffectDrizzleQueryError
		| Execution.Forbidden
		| MemoryBudgetSpent
		| Config.ModelConfigurationError
		| Execution.NotFound
		| Execution.OutcomeUnknown
		| Paused
		| Schema.SchemaError
		| SecretStorageError
		| SettingsData.SettingsUnavailable
		| SqlError.SqlError
		| Execution.StorageError
		| Cause.TimeoutError
		| Execution.Failure
		| Errors
	>
	readonly finish: (
		fence: Fence,
		end:
			| { readonly status: "completed" }
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
}

export class MemoryLearning extends Context.Service<MemoryLearning, Service>()(
	"@openbot-build/openbot/bots/MemoryLearning",
) {}

const make = Effect.gen(function* () {
	const store = yield* Store
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const access = yield* TurnAccess
	const records = yield* BotRecords
	const memories = yield* BotMemories
	const models = yield* MemoryModels
	const bots = yield* Bots
	const settings = yield* Settings
	const crypto = yield* Crypto.Crypto
	const observation = yield* Observation
	const cursors = records.collection(
		"memory_cursor",
		Schema.Struct({ after: Schema.Natural }),
	)
	const turnExecution = Effect.fn("MemoryLearning.turnExecution")(function* (
		namespace: string,
		chat: Chat.Id,
		turn: Turn.Id,
	) {
		const rows = yield* db
			.select({ id: executions.id })
			.from(executions)
			.where(
				and(
					eq(executions.namespace, namespace),
					eq(executions.resourceKind, "Turn"),
					eq(executions.resourceId, turn),
				),
			)
			.limit(2)
		if (rows.length !== 1 || rows[0] === undefined)
			return yield* Execution.Forbidden.make({})
		const key = { namespace, id: Execution.Id.make(rows[0].id) }
		const saved = yield* store.loadMember(key)
		const source = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ chat: Chat.Id }),
		)(saved.input)
		if (source.chat !== chat) return yield* Execution.Forbidden.make({})
		return { key, saved }
	}, storage)
	const load = Effect.fn("MemoryLearning.load")(function* (key: Key) {
		const saved = yield* store.loadMember(key)
		const input = yield* Schema.decodeUnknownEffect(Input)(saved.input)
		const parent = yield* turnExecution(key.namespace, input.chat, input.turn)
		if (
			saved.workflow !== workflowName ||
			saved.record.resource.kind !== "MemoryLearning" ||
			parent.key.id !== input.parentExecutionId ||
			!sameIdentity(saved.identity, parent.saved.identity)
		)
			return yield* Execution.Forbidden.make({})
		return { saved, input, parent }
	}, storage)
	const authorize: Authorize = (key, actor, mode) =>
		load(key).pipe(
			Effect.flatMap(({ parent }) =>
				access.authorize(
					parent.key,
					actor,
					mode === "advance" ? "replay" : mode,
				),
			),
		)
	const start = Effect.fn("MemoryLearning.start")(function* (
		source: Fence,
		chat: Chat.Id,
		turn: Turn.Id,
		own: ReadonlyArray<string>,
	) {
		const parent = yield* turnExecution(source.namespace, chat, turn)
		const caller = yield* store.loadMember(source)
		if (!sameIdentity(caller.identity, parent.saved.identity))
			return yield* Execution.Forbidden.make({})
		yield* access.authorize(parent.key, caller.identity.actor, "replay")
		const found = yield* StoredChats.ref(db, source.namespace, chat)
		if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
		const bot = yield* bots.find(
			caller.identity.owner.organizationId,
			ChatHost.hostState(found.value).bot,
		)
		if (Option.isNone(bot)) return yield* Execution.Forbidden.make({})
		const home = homeOf(caller.identity.owner.organizationId, bot.value)
		return yield* store.accept(
			source.namespace,
			Execution.CommandKey.make("memory-learning:" + parent.key.id),
			{
				actor: caller.identity.actor,
				body: { parentExecutionId: parent.key.id },
			},
			(create) =>
				store.commit(
					source,
					{
						events: (receipt) => [
							{
								_tag: "ChildExecution",
								executionId: receipt.executionId,
								step: "memory",
							},
						],
					},
					Effect.gen(function* () {
						const key = yield* create({
							workflow: workflowName,
							context: { kind: "Chat", id: chat },
							resource: { kind: "MemoryLearning", id: parent.key.id },
							identity: parent.saved.identity,
							input: yield* Schema.encodeEffect(Schema.toCodecJson(Input))({
								parentExecutionId: parent.key.id,
								chat,
								turn,
								home,
								own,
							}),
						})
						return { executionId: key.id, start: true }
					}),
				),
		)
	}, storage)
	const finish = (
		fence: Fence,
		end:
			| { readonly status: "completed" }
			| { readonly status: "failed"; readonly failure: Execution.Failure }
			| { readonly status: "cancelled"; readonly epoch: number },
	) =>
		end.status === "cancelled"
			? store.finishCancellation(fence, end.epoch)
			: store.commit(fence, end, Effect.void)
	const learn = Effect.fn("MemoryLearning.learn")(function* (fence: Fence) {
		const { saved, input, parent } = yield* load(fence)
		// Waiting observes the shared log. Closing this scope only closes this observer.
		yield* observation.observe(parent.key, 0).pipe(Stream.runDrain)
		yield* authorize(fence, saved.identity.actor, "advance")
		if (
			(yield* store.get(parent.key)).status !== "completed" ||
			!(yield* settings.organization(saved.identity.owner.organizationId))
				.document.botMemory
		) {
			yield* finish(fence, { status: "completed" })
			return
		}
		const found = yield* StoredChats.ref(db, fence.namespace, input.chat)
		if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
		const chat = found.value
		const bot = yield* bots.find(
			saved.identity.owner.organizationId,
			ChatHost.hostState(chat).bot,
		)
		if (Option.isNone(bot)) return yield* Execution.Forbidden.make({})
		const home = homeOf(saved.identity.owner.organizationId, bot.value)
		if (
			home.organizationId !== input.home.organizationId ||
			home.bot !== input.home.bot
		)
			return yield* Execution.Forbidden.make({})
		const last =
			(yield* db
				.select({ seq: max(chatItems.seq) })
				.from(chatItems)
				.where(
					and(
						eq(chatItems.namespace, fence.namespace),
						eq(chatItems.chat, input.chat),
						eq(chatItems.turn, input.turn),
					),
				))[0]?.seq ?? 0
		const cursorId = home.bot + "/" + input.chat
		const cursor = cursors
			.find(home.organizationId, cursorId)
			.pipe(
				Effect.map(
					Option.match({ onNone: () => 0, onSome: (value) => value.after }),
				),
			)
		while (true) {
			const after = yield* cursor
			if (after >= last) {
				yield* finish(fence, { status: "completed" })
				return
			}
			const rows = yield* db
				.select()
				.from(chatItems)
				.where(
					and(
						eq(chatItems.namespace, fence.namespace),
						eq(chatItems.chat, input.chat),
						gt(chatItems.seq, after),
						lte(chatItems.seq, last),
					),
				)
				.orderBy(asc(chatItems.seq))
			const evidence = Arr.takeRight(
				Arr.flatten(
					yield* Effect.forEach(rows, (row) =>
						Effect.gen(function* () {
							const item = yield* Schema.decodeEffect(
								Schema.fromJsonString(Item.Record),
							)(row.value)
							if (item.origin?.notice !== undefined) return []
							if (row.turn === null) return yield* Execution.Forbidden.make({})
							const source = yield* turnExecution(
								fence.namespace,
								input.chat,
								Turn.Id.make(row.turn),
							)
							return Evidence.evidence(
								chat,
								item,
								source.saved.identity,
								HashSet.fromIterable(input.own),
							)
						}),
					),
				),
				60,
			)
			const plan =
				evidence.length === 0
					? { operations: [] }
					: yield* models.run(
							fence,
							"memory:learn:" + after + ":" + last,
							home,
							{
								schema: Schema.toCodecJson(Memory.Plan),
								kind: "object",
								name: "bot_memory_operations",
								send: (prompt) =>
									LanguageModel.generateObject({
										prompt,
										objectName: "bot_memory_operations",
										schema: Memory.Plan,
									}).pipe(
										Effect.map((response) => ({
											value: response.value,
											usage: response.usage,
										})),
									),
								prompt: (instructions) =>
									Effect.gen(function* () {
										return Prompt.make([
											{
												role: "system",
												content:
													Rules.learnRules +
													"\n\nRules of the owner of the Bot:\n" +
													instructions,
											},
											{
												role: "user",
												content: yield* Schema.encodeEffect(
													Schema.fromJsonString(Schema.Unknown),
												)(
													Rules.learningInput(
														yield* memories.learningContext(home),
														evidence,
														bot.value,
													),
												),
											},
										])
									}).pipe(storage),
							},
						)
			const now = yield* Clock.currentTimeMillis
			const ids = yield* Effect.replicateEffect(
				newId(crypto),
				plan.operations.length,
			)
			const settled = yield* records.transaction(
				"memory_cursor:" + home.organizationId + ":" + cursorId,
				Effect.gen(function* () {
					// Another execution can move the cursor while the model runs. Read a new window in that case.
					if ((yield* cursor) !== after) return false
					yield* authorize(fence, saved.identity.actor, "advance")
					yield* store.commit(
						fence,
						{ status: "completed" },
						Effect.gen(function* () {
							yield* memories.applyLearning(home, {
								evidence,
								operations: plan.operations,
								now,
								ids,
							})
							yield* cursors.put(
								{
									organizationId: home.organizationId,
									id: cursorId,
									owner: home.bot,
									scope: input.chat,
									status: "",
								},
								{ after: last },
							)
						}),
					)
					return true
				}).pipe(sql.withTransaction),
			)
			if (settled) return
		}
	}, inExecution)
	return MemoryLearning.of({ start, load, authorize, learn, finish })
})

export const layer = Layer.effect(MemoryLearning, make)
