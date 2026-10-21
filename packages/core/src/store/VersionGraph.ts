import {
	Array as EffectArray,
	Effect,
	Graph,
	HashMap,
	JsonPatch,
	Option,
} from "effect"
import { dual } from "effect/Function"
import { batches } from "./GraphTraversal.ts"
import type * as Session from "../session/Session.ts"
import * as Timeline from "../timeline/Timeline.ts"
import type * as SessionStore from "./SessionStore.ts"
import { readRaw } from "./Snapshots.ts"
import { error } from "./StoreErrors.ts"

interface Indexed {
	readonly graph: Graph.DirectedGraph<Timeline.Version, 0 | 1>
	readonly indexes: HashMap.HashMap<Timeline.VersionId, Graph.NodeIndex>
}

const index = (versions: ReadonlyArray<Timeline.Version>): Indexed => {
	let indexes = HashMap.empty<Timeline.VersionId, Graph.NodeIndex>()
	const graph = Graph.directed<Timeline.Version, 0 | 1>((mutable) => {
		versions.forEach((version) => {
			indexes = HashMap.set(
				indexes,
				version.id,
				Graph.addNode(mutable, version),
			)
		})
		versions.forEach((version) => {
			version.parents.forEach((parent, order) => {
				Option.match(
					Option.all([
						HashMap.get(indexes, version.id),
						HashMap.get(indexes, parent),
					]),
					{
						onNone: () => {},
						onSome: ([source, target]) => {
							Graph.addEdge(mutable, source, target, order === 0 ? 0 : 1)
						},
					},
				)
			})
		})
	})
	return { graph, indexes }
}

/** Submitted dependencies are resolved separately, before their local edges are validated. */
export const acyclic = (
	versions: HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
): boolean => Graph.isAcyclic(index(Array.from(HashMap.values(versions))).graph)

const load = (
	storage: SessionStore.Persistence,
	roots: ReadonlyArray<Timeline.VersionId>,
) =>
	Effect.gen(function* () {
		// Read the ancestry one generation at a time. Each generation is one batch of reads.
		const visit = (
			pending: ReadonlyArray<Timeline.VersionId>,
			found: HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
			ordered: ReadonlyArray<Timeline.Version>,
		): Effect.Effect<
			{
				readonly found: HashMap.HashMap<Timeline.VersionId, Timeline.Version>
				readonly ordered: ReadonlyArray<Timeline.Version>
			},
			SessionStore.SessionStoreError
		> => {
			const ids = EffectArray.dedupe(
				pending.filter((id) => !HashMap.has(found, id)),
			)
			if (ids.length === 0) return Effect.succeed({ found, ordered })
			return batches(ids, storage.headers).pipe(
				Effect.flatMap((headers) => {
					const rows = HashMap.fromIterable(
						headers.map((row) => [row.id, row] as const),
					)
					return Effect.forEach(ids, (id) =>
						Effect.fromOption(HashMap.get(rows, id), () =>
							error("parent-missing", {
								message: "A version or its parent is missing",
								version: id,
							}),
						),
					)
				}),
				Effect.flatMap((generation) =>
					visit(
						generation.flatMap((version) => version.parents),
						generation.reduce(
							(found, version) => HashMap.set(found, version.id, version),
							found,
						),
						[...ordered, ...generation],
					),
				),
			)
		}
		const { found, ordered } = yield* visit(roots, HashMap.empty(), [])
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
		head: Timeline.VersionId,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<
		HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
		SessionStore.SessionStoreError
	>
	(
		storage: SessionStore.Persistence,
		head: Timeline.VersionId,
	): Effect.Effect<
		HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
		SessionStore.SessionStoreError
	>
} = dual(2, (storage: SessionStore.Persistence, head: Timeline.VersionId) =>
	load(storage, [head]).pipe(Effect.map((loaded) => loaded.versions)),
)

export const log: {
	(
		head: Timeline.VersionId,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<
		ReadonlyArray<Timeline.Version>,
		SessionStore.SessionStoreError
	>
	(
		storage: SessionStore.Persistence,
		head: Timeline.VersionId,
	): Effect.Effect<
		ReadonlyArray<Timeline.Version>,
		SessionStore.SessionStoreError
	>
} = dual(2, (storage: SessionStore.Persistence, head: Timeline.VersionId) =>
	load(storage, [head]).pipe(
		Effect.map((loaded) => Array.from(Graph.values(Graph.topo(loaded.graph)))),
	),
)

/** Reachability can choose to follow only first-parent links. */
export const reaches: {
	(
		from: Timeline.VersionId,
		to: Timeline.VersionId,
		firstParent?: boolean,
	): (
		versions: HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
	) => boolean
	(
		versions: HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
		from: Timeline.VersionId,
		to: Timeline.VersionId,
		firstParent?: boolean,
	): boolean
} = dual(
	(args) => HashMap.isHashMap(args[0]),
	(
		versions: HashMap.HashMap<Timeline.VersionId, Timeline.Version>,
		from: Timeline.VersionId,
		to: Timeline.VersionId,
		firstParent: boolean = false,
	): boolean => {
		const loaded = index(Array.from(HashMap.values(versions)))
		const selected = firstParent
			? Graph.mutate(loaded.graph, (mutable) => {
					Graph.filterEdges(mutable, (order) => order === 0)
				})
			: loaded.graph
		return Option.exists(
			Option.all([
				HashMap.get(loaded.indexes, from),
				HashMap.get(loaded.indexes, to),
			]),
			([source, target]) => Graph.hasPath(selected, source, target),
		)
	},
)

interface MergeBases {
	readonly alreadyMerged: boolean
	readonly candidates: ReadonlyArray<Timeline.VersionId>
}
export const mergeBases: {
	(
		target: Timeline.VersionId,
		source: Timeline.VersionId,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<MergeBases, SessionStore.SessionStoreError>
	(
		storage: SessionStore.Persistence,
		target: Timeline.VersionId,
		source: Timeline.VersionId,
	): Effect.Effect<MergeBases, SessionStore.SessionStoreError>
} = dual(
	3,
	(
		storage: SessionStore.Persistence,
		target: Timeline.VersionId,
		source: Timeline.VersionId,
	) =>
		Effect.gen(function* () {
			const loaded = yield* load(storage, [target, source])
			// load fails when a root is missing, so both roots have an index here.
			const [targetIndex, sourceIndex] = yield* Effect.fromOption(
				Option.all([
					HashMap.get(loaded.indexes, target),
					HashMap.get(loaded.indexes, source),
				]),
				() =>
					error("parent-missing", {
						message: "A version or its parent is missing",
					}),
			)
			const ancestors = (start: Graph.NodeIndex) =>
				HashMap.fromIterable(
					Graph.entries(
						Graph.dfs(loaded.graph, { start: [start], direction: "outgoing" }),
					),
				)
			const sourceAncestors = ancestors(sourceIndex)
			const common = Array.from(ancestors(targetIndex)).filter(([index]) =>
				HashMap.has(sourceAncestors, index),
			)
			return {
				alreadyMerged: Graph.hasPath(loaded.graph, targetIndex, sourceIndex),
				candidates: common
					.filter(
						([candidate]) =>
							!common.some(
								([other]) =>
									other !== candidate &&
									Graph.hasPath(loaded.graph, other, candidate),
							),
					)
					.map(([, version]) => version.id),
			}
		}),
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
			const loaded = yield* Effect.forEach(HashMap.keys(headers), (id) =>
				readRaw(storage, id),
			)
			return {
				formatVersion: 3,
				session: ref,
				versions: loaded.map(({ snapshot }) => snapshot),
				messages: Array.from(
					HashMap.values(
						HashMap.fromIterable(
							loaded.flatMap(({ messages }) =>
								messages.map((content) => [content.id, content] as const),
							),
						),
					),
				),
			}
		}),
)

/** Build a Diff from raw snapshots. A null base compares with an empty value. */
export const diff: {
	(
		version: Timeline.VersionId,
		base: Timeline.VersionId | null,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<JsonPatch.JsonPatch, SessionStore.SessionStoreError>
	(
		storage: SessionStore.Persistence,
		version: Timeline.VersionId,
		base: Timeline.VersionId | null,
	): Effect.Effect<JsonPatch.JsonPatch, SessionStore.SessionStoreError>
} = dual(
	3,
	(
		storage: SessionStore.Persistence,
		version: Timeline.VersionId,
		base: Timeline.VersionId | null,
	) =>
		Effect.gen(function* () {
			const target = yield* readRaw(storage, version)
			const before = base === null ? {} : (yield* readRaw(storage, base)).raw
			return JsonPatch.get(before, target.raw)
		}),
)
