import {
	Array as EffectArray,
	Effect,
	Graph,
	HashMap,
	HashSet,
	JsonPatch,
	Option,
	Predicate,
} from "effect"
import { dual } from "effect/Function"
import { batches } from "./GraphTraversal.ts"
import type * as Session from "../session/Session.ts"
import * as Memory from "../memory/Memory.ts"
import type * as SessionStore from "./SessionStore.ts"
import { readRaw } from "./Snapshots.ts"
import { error } from "./StoreErrors.ts"

interface Indexed {
	readonly graph: Graph.DirectedGraph<Memory.Version, 0 | 1>
	readonly indexes: HashMap.HashMap<Memory.VersionId, Graph.NodeIndex>
}

const index = (versions: ReadonlyArray<Memory.Version>): Indexed => {
	let indexes = HashMap.empty<Memory.VersionId, Graph.NodeIndex>()
	const graph = Graph.directed<Memory.Version, 0 | 1>((mutable) => {
		versions.forEach((version) => {
			indexes = HashMap.set(
				indexes,
				version.id,
				Graph.addNode(mutable, version),
			)
		})
		versions.forEach((version) => {
			version.parents.forEach((parent, order) => {
				const target = HashMap.get(indexes, parent)
				if (Option.isSome(target))
					Graph.addEdge(
						mutable,
						HashMap.getUnsafe(indexes, version.id),
						target.value,
						order === 0 ? 0 : 1,
					)
			})
		})
	})
	return { graph, indexes }
}

/** Submitted dependencies are resolved separately, before their local edges are validated. */
export const acyclic = (
	versions: HashMap.HashMap<Memory.VersionId, Memory.Version>,
): boolean => Graph.isAcyclic(index(Array.from(HashMap.values(versions))).graph)

const load = (
	storage: SessionStore.Persistence,
	roots: ReadonlyArray<Memory.VersionId>,
) =>
	Effect.gen(function* () {
		let found = HashMap.empty<Memory.VersionId, Memory.Version>()
		let ordered: ReadonlyArray<Memory.Version> = []
		const visit = (
			pending: ReadonlyArray<Memory.VersionId>,
		): Effect.Effect<void, SessionStore.SessionStoreError> => {
			const ids = EffectArray.dedupe(
				pending.filter((id) => !HashMap.has(found, id)),
			)
			if (ids.length === 0) return Effect.void
			return Effect.gen(function* () {
				const rows = HashMap.fromIterable(
					(yield* batches(ids, storage.headers)).map(
						(row) => [row.id, row] as const,
					),
				)
				for (const id of ids) {
					const row = HashMap.get(rows, id)
					if (Option.isNone(row))
						return yield* error("parent-missing", {
							message: "A version or its parent is missing",
							version: id,
						})
					found = HashMap.set(found, id, row.value)
					ordered = EffectArray.append(ordered, row.value)
				}
				return yield* visit(
					ids.flatMap((id) => HashMap.getUnsafe(found, id).parents),
				)
			})
		}
		yield* visit(roots)
		const indexed = index(ordered)
		if (!Graph.isAcyclic(indexed.graph))
			return yield* error("version-cycle", {
				message: "The version ancestry contains a cycle",
			})
		return { ...indexed, versions: found }
	})

/** Return only domain headers. Graph indexes stay inside this module. */
export const graph: {
	(
		head: Memory.VersionId,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<
		HashMap.HashMap<Memory.VersionId, Memory.Version>,
		SessionStore.SessionStoreError
	>
	(
		storage: SessionStore.Persistence,
		head: Memory.VersionId,
	): Effect.Effect<
		HashMap.HashMap<Memory.VersionId, Memory.Version>,
		SessionStore.SessionStoreError
	>
} = dual(2, (storage: SessionStore.Persistence, head: Memory.VersionId) =>
	load(storage, [head]).pipe(Effect.map((loaded) => loaded.versions)),
)

export const log: {
	(
		head: Memory.VersionId,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<
		ReadonlyArray<Memory.Version>,
		SessionStore.SessionStoreError
	>
	(
		storage: SessionStore.Persistence,
		head: Memory.VersionId,
	): Effect.Effect<
		ReadonlyArray<Memory.Version>,
		SessionStore.SessionStoreError
	>
} = dual(2, (storage: SessionStore.Persistence, head: Memory.VersionId) =>
	load(storage, [head]).pipe(
		Effect.map((loaded) => Array.from(Graph.values(Graph.topo(loaded.graph)))),
	),
)

/** Reachability can choose to follow only first-parent links. */
export const reaches: {
	(
		from: Memory.VersionId,
		to: Memory.VersionId,
		firstParent?: boolean,
	): (versions: HashMap.HashMap<Memory.VersionId, Memory.Version>) => boolean
	(
		versions: HashMap.HashMap<Memory.VersionId, Memory.Version>,
		from: Memory.VersionId,
		to: Memory.VersionId,
		firstParent?: boolean,
	): boolean
} = dual(
	(args) => HashMap.isHashMap(args[0]),
	(
		versions: HashMap.HashMap<Memory.VersionId, Memory.Version>,
		from: Memory.VersionId,
		to: Memory.VersionId,
		firstParent: boolean = false,
	): boolean => {
		const loaded = index(Array.from(HashMap.values(versions)))
		const source = HashMap.get(loaded.indexes, from),
			target = HashMap.get(loaded.indexes, to)
		if (Option.isNone(source) || Option.isNone(target)) return false
		const selected = firstParent
			? Graph.mutate(loaded.graph, (mutable) => {
					Graph.filterEdges(mutable, (order) => order === 0)
				})
			: loaded.graph
		return Graph.hasPath(selected, source.value, target.value)
	},
)

interface MergeBases {
	readonly alreadyMerged: boolean
	readonly candidates: ReadonlyArray<Memory.VersionId>
}
export const mergeBases: {
	(
		target: Memory.VersionId,
		source: Memory.VersionId,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<MergeBases, SessionStore.SessionStoreError>
	(
		storage: SessionStore.Persistence,
		target: Memory.VersionId,
		source: Memory.VersionId,
	): Effect.Effect<MergeBases, SessionStore.SessionStoreError>
} = dual(
	3,
	(
		storage: SessionStore.Persistence,
		target: Memory.VersionId,
		source: Memory.VersionId,
	) =>
		load(storage, [target, source]).pipe(
			Effect.map((loaded) => {
				const targetIndex = HashMap.getUnsafe(loaded.indexes, target),
					sourceIndex = HashMap.getUnsafe(loaded.indexes, source)
				const ancestors = (start: Graph.NodeIndex) =>
					HashSet.fromIterable(
						Graph.indices(
							Graph.dfs(loaded.graph, {
								start: [start],
								direction: "outgoing",
							}),
						),
					)
				const common = Array.from(
					HashSet.intersection(ancestors(targetIndex), ancestors(sourceIndex)),
				)
				return {
					alreadyMerged: Graph.hasPath(loaded.graph, targetIndex, sourceIndex),
					candidates: common
						.filter(
							(candidate) =>
								!common.some(
									(other) =>
										other !== candidate &&
										Graph.hasPath(loaded.graph, other, candidate),
								),
						)
						.map(
							(candidate) =>
								Option.getOrThrow(Graph.getNode(loaded.graph, candidate)).id,
						),
				}
			}),
		),
)

export const exportRecord: {
	(
		ref: Session.Ref,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<SessionStore.Record, SessionStore.SessionStoreError>
	(
		storage: SessionStore.Persistence,
		ref: Session.Ref,
	): Effect.Effect<SessionStore.Record, SessionStore.SessionStoreError>
} = dual(
	2,
	(
		storage: SessionStore.Persistence,
		ref: Session.Ref,
	): Effect.Effect<SessionStore.Record, SessionStore.SessionStoreError> =>
		Effect.gen(function* () {
			const headers = yield* graph(storage, ref.head)
			let versions: ReadonlyArray<SessionStore.Snapshot> = [],
				messages = HashMap.empty<string, SessionStore.Content>()
			for (const id of HashMap.keys(headers)) {
				const loaded = yield* readRaw(storage, id)
				versions = EffectArray.append(versions, loaded.snapshot)
				for (const content of loaded.messages)
					messages = HashMap.set(messages, content.id, content)
			}
			return {
				formatVersion: 3,
				session: ref,
				versions,
				messages: Array.from(HashMap.values(messages)),
			}
		}),
)

/** Build a Diff from raw snapshots. The default base is the first parent. */
export const diff: {
	(
		version: Memory.VersionId,
		base?: Memory.VersionId | null,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<JsonPatch.JsonPatch, SessionStore.SessionStoreError>
	(
		storage: SessionStore.Persistence,
		version: Memory.VersionId,
		base?: Memory.VersionId | null,
	): Effect.Effect<JsonPatch.JsonPatch, SessionStore.SessionStoreError>
} = dual(
	(args) => Predicate.isObjectOrArray(args[0]),
	(
		storage: SessionStore.Persistence,
		version: Memory.VersionId,
		base?: Memory.VersionId | null,
	) =>
		Effect.gen(function* () {
			const target = yield* readRaw(storage, version)
			const parent =
				base === null ? undefined : (base ?? target.snapshot.parents[0])
			return JsonPatch.get(
				parent === undefined ? {} : (yield* readRaw(storage, parent)).raw,
				target.raw,
			)
		}),
)
