import { NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Chat, type ChatStore, Item, Turn } from "@openbot-build/core"
import { Artifacts, Execution, Files } from "@openbot-build/domain"
import { Effect, Layer, Option, Redacted, Schema, String as Str } from "effect"
import { Prompt } from "effect/ai"
import { describe, expect, it } from "vitest"
import * as Citations from "../src/artifacts/Citations.ts"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as ResponseMapping from "../src/chats/ResponseMapping.ts"
import * as PostgresTest from "./PostgresTest.ts"

const chat = Chat.Id.make("chat")
const turn = Turn.Id.make("turn")
const reference = Artifacts.SourceReference.make({
	type: "source_reference",
	source_id: Artifacts.SourceId.make("source"),
	quote: "A source.",
})
const entry = (
	id: string,
	step: number,
	content: Prompt.Prompt,
	originTurn = turn,
): Item.Entry => ({
	id: Item.Id.make(id),
	content,
	origin: { chat, turn: originTurn, step },
})
const answer = entry(
	"answer",
	4,
	Prompt.make([
		Prompt.assistantMessage({
			content: [Prompt.textPart({ text: "The answer." })],
		}),
	]),
)
const tool = entry(
	"tool",
	2,
	Prompt.make([
		Prompt.assistantMessage({
			content: [
				Prompt.toolCallPart({
					id: "call",
					name: "cite_sources",
					params: {},
					providerExecuted: false,
				}),
			],
		}),
	]),
)
const mixed = entry(
	"mixed",
	3,
	Prompt.make([
		Prompt.assistantMessage({
			content: [
				Prompt.textPart({ text: "I will read the file." }),
				Prompt.toolCallPart({
					id: "read",
					name: "read_artifact",
					params: {},
					providerExecuted: false,
				}),
			],
		}),
	]),
)
const empty = entry(
	"empty",
	3,
	Prompt.make([
		Prompt.assistantMessage({ content: [Prompt.textPart({ text: " " })] }),
	]),
)
const savedTurn: Turn.Record = {
	id: turn,
	chat,
	settings: { mode: "build" },
	status: Turn.Status.Completed({
		result: { text: "The answer.", finishReason: "stop" },
	}),
	steps: 4,
	input: [],
	items: [answer.id],
	startedAt: 0,
}

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)
const delta = (
	items: ReadonlyArray<Item.Entry>,
	terminal = false,
	status: Turn.Status = savedTurn.status,
) =>
	Effect.gen(function* () {
		return {
			chat,
			ref: {},
			revision: 1,
			expected: 0,
			items: yield* Effect.forEach(items, (item, index) =>
				Schema.encodeEffect(Schema.toCodecJson(Item.Entry))(item).pipe(
					Effect.map((value) => ({
						seq: index + 1,
						id: item.id,
						turn: item.origin?.turn ?? null,
						value,
					})),
				),
			),
			...(terminal
				? {
						turn: {
							id: turn,
							value: yield* Schema.encodeEffect(
								Schema.toCodecJson(Turn.Record),
							)({ ...savedTurn, status }),
						},
					}
				: {}),
		} satisfies ChatStore.Delta
	})

describe("saved output links", () => {
	it("selects the first later answer in the same Turn", () => {
		const other = entry(
			"other",
			3,
			Prompt.make([
				Prompt.assistantMessage({
					content: [Prompt.textPart({ text: "Other." })],
				}),
			]),
			Turn.Id.make("other-turn"),
		)
		expect(
			Citations.target([tool, mixed, empty, other, answer], turn, 2),
		).toEqual(Option.some(answer))
		expect(Citations.target([answer], turn, 4)).toEqual(Option.none())
	})
	it("keeps the saved version and source in the response", () => {
		const version = Artifacts.ArtifactVersion.make({
			artifactId: Artifacts.ArtifactId.make("artifact"),
			version: 1,
			chatId: chat,
			turnId: turn,
			itemId: answer.id,
			file: {
				id: Files.FileId.make("file"),
				object: "file",
				filename: "work.md",
				mediaType: "text/markdown",
				bytes: 12,
				status: "ready",
				createdAt: 0,
			},
			sha256: Str.repeat(64)("a"),
			citations: [reference],
			availability: "ready",
			createdAt: 0,
		})
		const response = ResponseMapping.response(chat, savedTurn, [
			{ ...answer, citations: [reference], artifacts: [version] },
		])
		expect(response.output[0]?.content).toEqual([
			{ type: "output_text", text: "The answer.", annotations: [reference] },
			{
				type: "output_file",
				artifact_id: "artifact",
				version: 1,
				file_id: "file",
				filename: "work.md",
				media_type: "text/markdown",
				bytes: 12,
				availability: "ready",
			},
		])
		expect(
			ResponseMapping.response(chat, savedTurn, [answer]).output[0]?.content,
		).toEqual([{ type: "output_text", text: "The answer.", annotations: [] }])
	})
})

layer(database, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"binds an intent once with the saved answer and rolls back a failed save",
		() =>
			Effect.gen(function* () {
				const db = yield* Db.make
				const input = {
					namespace: "bind",
					chat,
					turn,
					callId: Execution.CallId.make("call"),
					afterStep: 2,
					citations: [reference],
				}
				yield* Citations.remember(db, input)
				yield* Citations.remember(db, input)
				assert.deepStrictEqual(
					yield* Citations.bind(
						db,
						input.namespace,
						turn,
						yield* delta([tool, mixed, empty]),
					),
					[],
				)
				const commit = Citations.bind(
					db,
					input.namespace,
					turn,
					yield* delta([answer]),
				)
				yield* db
					.transaction(() =>
						commit.pipe(Effect.andThen(Effect.fail("save failed"))),
					)
					.pipe(Effect.flip)
				const events = yield* db.transaction(() => commit)
				assert.deepStrictEqual(events, [
					{
						_tag: "CitationRecorded",
						chatId: chat,
						itemId: answer.id,
						citations: [reference],
					},
				])
				assert.deepStrictEqual(yield* commit, [])
				const records = [
					{ ...answer, seq: Item.Seq.make(1), citations: [], artifacts: [] },
				]
				assert.deepStrictEqual(
					(yield* Citations.enrich(db, input.namespace, chat, records))[0]
						?.citations,
					[reference],
				)
			}),
	)
	it.effect("drops unused source links when a model Turn fails", () =>
		Effect.gen(function* () {
			const db = yield* Db.make
			yield* Citations.remember(db, {
				namespace: "ended",
				chat,
				turn,
				callId: Execution.CallId.make("ended-call"),
				afterStep: 2,
				citations: [reference],
			})
			assert.deepStrictEqual(
				yield* Citations.bind(db, "ended", turn, yield* delta([], true)),
				[],
			)
			assert.deepStrictEqual(
				yield* Citations.bind(db, "ended", turn, yield* delta([answer])),
				[],
			)
		}),
	)
})
