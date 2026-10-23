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
	person: Schema.String,
	state: AgentMemory.State,
})
const Logged = Schema.Struct({
	agent: AgentsApi.AgentId,
	person: Schema.String,
	entry: AgentMemory.LogEntry,
})

/**
 * Where the memory of an Agent lives. A linked Agent shares the memory of its source,
 * so every person who uses a shared Agent adds to one memory, one part for each person.
 */
// It reads two plain values, like the helpers of SessionHost. A pipeable form does not help.
// @effect-diagnostics-next-line missingPipeableSignature:off
export const homeOf = (organizationId: string, agent: AgentsApi.Agent) =>
	agent.source ?? { organizationId, agent: agent.id }

/** One memory: what one Agent remembers about one person. `person` is a user id. */
export interface Whose {
	readonly agent: AgentsApi.AgentId
	readonly person: string
}

/**
 * The long-term memory of each Agent, with one memory for each person.
 * It does not follow any Timeline.
 */
export class AgentMemories extends Context.Service<
	AgentMemories,
	{
		readonly get: (
			organizationId: string,
			whose: Whose,
		) => Effect.Effect<AgentMemory.State, AgentsApi.AgentStorageUnavailable>
		/** The people that an Agent has memory about, the most recently changed first. */
		readonly people: (
			organizationId: string,
			agent: AgentsApi.AgentId,
		) => Effect.Effect<
			ReadonlyArray<AgentsApi.AgentMemoryPerson>,
			AgentsApi.AgentStorageUnavailable
		>
		readonly edit: (
			organizationId: string,
			whose: Whose,
			input: AgentsApi.UpdateAgentMemoryRequest,
		) => Effect.Effect<
			AgentMemory.State,
			AgentsApi.AgentConflict | AgentsApi.AgentStorageUnavailable
		>
		readonly log: (
			organizationId: string,
			whose: Whose,
		) => Effect.Effect<
			ReadonlyArray<AgentMemory.LogEntry>,
			AgentsApi.AgentStorageUnavailable
		>
		/**
		 * Learns from finished work, into the memory about `user`.
		 * The model runs before the write, so a person's edit is kept.
		 */
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
		/**
		 * Adds the lasting entries of a Session memory, when a Session Agent is promoted.
		 * They go into the memory about the person that promotes it.
		 */
		readonly adopt: (
			organizationId: string,
			whose: Whose,
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
	const memories = records.collection("person_memory", Stored)
	const logs = records.collection("person_memory_log", Logged)
	// The person is a user id. Encoding keeps a slash in it from looking like a new part.
	const idOf = (whose: Whose) =>
		whose.agent + "/" + encodeURIComponent(whose.person)
	const get = (organizationId: string, whose: Whose) =>
		memories.find(organizationId, idOf(whose)).pipe(
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
		whose: Whose,
		previous: AgentMemory.State,
		state: AgentMemory.State,
		by: AgentMemory.LogEntry["by"],
	) =>
		Effect.gen(function* () {
			if (state.version === previous.version) return state
			const now = yield* Clock.currentTimeMillis
			yield* memories.put(
				{
					organizationId,
					id: idOf(whose),
					owner: whose.agent,
					scope: whose.person,
					status: "",
				},
				{ agent: whose.agent, person: whose.person, state },
			)
			yield* logs.put(
				{
					organizationId,
					id: idOf(whose) + ":" + String(state.version).padStart(12, "0"),
					owner: whose.agent,
					scope: whose.person,
					status: "",
				},
				{
					agent: whose.agent,
					person: whose.person,
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
		whose: Whose,
		operation: Effect.Effect<A, E, R>,
	) =>
		records.transaction(
			"memory:" + organizationId + ":" + idOf(whose),
			operation,
		)
	return AgentMemories.of({
		get,
		people: (organizationId, agent) =>
			memories.list(organizationId, { owner: agent }).pipe(
				Effect.map((list) =>
					list
						.map((stored) => ({
							person: stored.person,
							entries: Object.values(stored.state.entries).filter(
								(entry) => entry.status === "active",
							).length,
							version: stored.state.version,
							updatedAt: Math.max(
								0,
								...Object.values(stored.state.entries).map(
									(entry) => entry.updatedAt,
								),
							),
						}))
						.sort((a, b) => b.updatedAt - a.updatedAt)
						.map(({ updatedAt: _, ...person }) => person),
				),
			),
		edit: (organizationId, whose, input) =>
			locked(
				organizationId,
				whose,
				Effect.gen(function* () {
					const state = yield* get(organizationId, whose)
					if (state.version !== input.expected)
						return yield* AgentsApi.AgentConflict.make({
							message: "The Agent memory changed. Read it again and retry.",
						})
					const now = yield* Clock.currentTimeMillis
					const next = AgentMemory.edit({ state, change: input.command, now })
					return yield* write(organizationId, whose, state, next, "person")
				}),
			),
		log: (organizationId, whose) =>
			logs
				.list(organizationId, { owner: whose.agent, scope: whose.person })
				.pipe(Effect.map((list) => list.map((logged) => logged.entry))),
		consolidate: (organizationId, input) =>
			Effect.gen(function* () {
				const whose = { agent: input.agentId, person: input.user.id }
				if (input.evidence.length === 0)
					return yield* get(organizationId, whose)
				const before = yield* get(organizationId, whose)
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
					whose,
					Effect.gen(function* () {
						const state = yield* get(organizationId, whose)
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
							whose,
							state,
							next,
							"consolidation",
						)
					}),
				)
			}),
		adopt: (organizationId, whose, session, memory) =>
			locked(
				organizationId,
				whose,
				Effect.gen(function* () {
					const state = yield* get(organizationId, whose)
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
					return yield* write(organizationId, whose, state, next, "promotion")
				}),
			),
	})
})
export const layer = Layer.effect(AgentMemories, make)
