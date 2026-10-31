import type { Chat, Item } from "@openbot-build/core"
import { Artifacts } from "@openbot-build/domain"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Array as Arr, Effect, Schema } from "effect"
import type { Database } from "../database/Database.ts"
import { artifactVersions, files } from "../database/Schema.ts"
import * as Citations from "./Citations.ts"

/** Read saved links after the caller has checked the Chat read rule. */
export const items = (
	db: Database,
	namespace: string,
	chat: Chat.Id,
	items: ReadonlyArray<Item.Record>,
) =>
	Effect.gen(function* () {
		if (items.length === 0) return []
		const rows = yield* db
			.select({ body: artifactVersions.body, status: files.status })
			.from(artifactVersions)
			.leftJoin(files, eq(files.id, artifactVersions.file))
			.where(
				and(
					eq(artifactVersions.namespace, namespace),
					eq(artifactVersions.chat, chat),
					inArray(
						artifactVersions.item,
						Arr.map(items, (item) => item.id),
					),
				),
			)
			.orderBy(asc(artifactVersions.artifact), asc(artifactVersions.version))
		const versions = yield* Effect.forEach(rows, (row) =>
			Schema.decodeEffect(Schema.fromJsonString(Artifacts.ArtifactVersion))(
				row.body,
			).pipe(
				Effect.map((version) => ({
					...version,
					availability:
						row.status === "ready"
							? ("ready" as const)
							: ("unavailable" as const),
				})),
			),
		)
		return yield* Citations.enrich(
			db,
			namespace,
			chat,
			Arr.map(items, (item) => ({
				...item,
				citations: [],
				artifacts: Arr.filter(
					versions,
					(version) => version.itemId === item.id,
				),
			})),
		)
	})
