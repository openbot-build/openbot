import type { Session } from "@openbot-build/core"
import { AgentsApi } from "@openbot-build/api"
import * as AgentMemory from "../plugins/memory/AgentMemory.ts"
import type * as Memory from "../plugins/memory/Memory.ts"
import { Clock, Context, Effect, Layer, Option, Record, Schema } from "effect"
import type { LanguageModel } from "effect/ai"
import { AgentRecords } from "./AgentRecords.ts"

/** Agent memory keeps only the lasting kinds of Session memory. */
const isLastingKind = Schema.is(AgentMemory.Kind)

const Stored = Schema.Struct({
	agent: AgentsApi.AgentId,
	state: AgentMemory.State,
})
const Logged = Schema.Struct({
	agent: AgentsApi.AgentId,
	entry: AgentMemory.LogEntry,
})

/** The long-term memory of each Agent. It does not follow any Timeline. */
export class AgentMemories extends Context.Service<
	AgentMemories,
	{
		readonly get: (
			organizationId: string,
			agent: AgentsApi.AgentId,
		) => Effect.Effect<AgentMemory.State, AgentsApi.AgentStorageUnavailable>
		readonly edit: (
			organizationId: string,
			agent: AgentsApi.AgentId,
			input: AgentsApi.UpdateAgentMemoryRequest,
		) => Effect.Effect<
			AgentMemory.State,
			AgentsApi.AgentConflict | AgentsApi.AgentStorageUnavailable
		>
		readonly log: (
			organizationId: string,
			agent: AgentsApi.AgentId,
		) => Effect.Effect<
			ReadonlyArray<AgentMemory.LogEntry>,
			AgentsApi.AgentStorageUnavailable
		>
		/** Learns from finished work. The model runs before the write, so a person's edit is kept. */
		readonly consolidate: (
			organizationId: string,
			input: Omit<AgentMemory.ExtractionInput, "state"> & {
				readonly agentId: AgentsApi.AgentId
			},
		) => Effect.Effect<
			AgentMemory.State,
			AgentsApi.AgentStorageUnavailable,
			LanguageModel.LanguageModel
		>
		/** Adds the lasting entries of a Session memory, when a Session Agent is promoted. */
		readonly adopt: (
			organizationId: string,
			agent: AgentsApi.AgentId,
			session: Session.Id,
			memory: Memory.State,
		) => Effect.Effect<AgentMemory.State, AgentsApi.AgentStorageUnavailable>
	}
>()("@openbot-build/openbot/agents/AgentMemories") {}

export const make: Effect.Effect<
	typeof AgentMemories.Service,
	never,
	AgentRecords
> = Effect.gen(function* () {
	const records = yield* AgentRecords
	const memories = records.collection("memory", Stored)
	const logs = records.collection("memory_log", Logged)
	const get = (organizationId: string, agent: AgentsApi.AgentId) =>
		memories.find(organizationId, agent).pipe(
			Effect.map(
				Option.match({
					onNone: () => AgentMemory.empty(),
					onSome: (stored) => stored.state,
				}),
			),
		)
	/** Writes a new state and its log entry, when something changed. */
	const write = (
		organizationId: string,
		agent: AgentsApi.AgentId,
		previous: AgentMemory.State,
		state: AgentMemory.State,
		by: AgentMemory.LogEntry["by"],
	) =>
		Effect.gen(function* () {
			if (state.version === previous.version) return state
			const now = yield* Clock.currentTimeMillis
			yield* memories.put(
				{ organizationId, id: agent, owner: agent, scope: "", status: "" },
				{ agent, state },
			)
			yield* logs.put(
				{
					organizationId,
					id: agent + ":" + String(state.version).padStart(12, "0"),
					owner: agent,
					scope: "",
					status: "",
				},
				{
					agent,
					entry: {
						version: state.version,
						at: now,
						by,
						keys: Record.keys(state.entries).filter(
							(key) =>
								previous.entries[key] === undefined ||
								previous.entries[key] !== state.entries[key],
						),
					},
				},
			)
			return state
		})
	const locked = <A, E, R>(
		organizationId: string,
		agent: AgentsApi.AgentId,
		operation: Effect.Effect<A, E, R>,
	) => records.transaction("memory:" + organizationId + ":" + agent, operation)
	return AgentMemories.of({
		get,
		edit: (organizationId, agent, input) =>
			locked(
				organizationId,
				agent,
				Effect.gen(function* () {
					const state = yield* get(organizationId, agent)
					if (state.version !== input.expected)
						return yield* AgentsApi.AgentConflict.make({
							message: "The Agent memory changed. Read it again and retry.",
						})
					const now = yield* Clock.currentTimeMillis
					const next = AgentMemory.edit({ state, change: input.command, now })
					return yield* write(organizationId, agent, state, next, "person")
				}),
			),
		log: (organizationId, agent) =>
			logs
				.list(organizationId, { owner: agent })
				.pipe(Effect.map((list) => list.map((logged) => logged.entry))),
		consolidate: (organizationId, input) =>
			Effect.gen(function* () {
				if (input.evidence.length === 0)
					return yield* get(organizationId, input.agentId)
				const before = yield* get(organizationId, input.agentId)
				const extraction = yield* AgentMemory.extract({
					agent: input.agent,
					user: input.user,
					evidence: input.evidence,
					state: before,
				}).pipe(
					Effect.catch((error) =>
						Effect.logWarning("Agent memory was not changed", error).pipe(
							Effect.as({ changes: [] }),
						),
					),
				)
				if (extraction.changes.length === 0) return before
				return yield* locked(
					organizationId,
					input.agentId,
					Effect.gen(function* () {
						const state = yield* get(organizationId, input.agentId)
						const now = yield* Clock.currentTimeMillis
						const next = yield* AgentMemory.apply({
							state,
							evidence: input.evidence,
							changes: extraction.changes,
							now,
						}).pipe(
							Effect.catch((error) =>
								Effect.logWarning(
									"Agent memory changes were not valid",
									error,
								).pipe(Effect.as(state)),
							),
						)
						return yield* write(
							organizationId,
							input.agentId,
							state,
							next,
							"consolidation",
						)
					}),
				)
			}),
		adopt: (organizationId, agent, session, memory) =>
			locked(
				organizationId,
				agent,
				Effect.gen(function* () {
					const state = yield* get(organizationId, agent)
					const now = yield* Clock.currentTimeMillis
					const lasting = Object.values(memory.entries).filter(
						(entry): entry is typeof entry & { kind: AgentMemory.Kind } =>
							entry.status === "active" && isLastingKind(entry.kind),
					)
					if (lasting.length === 0) return state
					const next: AgentMemory.State = {
						version: state.version + 1,
						entries: lasting.reduce(
							(entries, entry) =>
								Record.set(entries, entry.key, {
									key: entry.key,
									content: entry.content,
									kind: entry.kind,
									sources: entry.sources.map((item) => ({ session, item })),
									updatedAt: now,
									status: "active" as const,
								}),
							state.entries,
						),
					}
					return yield* write(organizationId, agent, state, next, "promotion")
				}),
			),
	})
})
export const layer = Layer.effect(AgentMemories, make)
