import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Execution } from "@openbot-build/domain"
import {
	ArtifactVersion,
	CaptureSourceRequest,
	PublishVersionRequest,
	Source,
} from "../src/ArtifactsApi.ts"
import { ChatResponse, OutputText } from "../src/ChatsApi.ts"

const file = {
	id: "file_one",
	object: "file",
	filename: "plan.csv",
	mediaType: "text/csv",
	bytes: 12,
	status: "ready",
	createdAt: 0,
}
const citation = {
	type: "source_reference",
	source_id: "source_one",
	quote: "One saved fact.",
}
const digest =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("Artifact contract", () => {
	it.effect("a response holds text references and a fixed file version", () =>
		Effect.gen(function* () {
			const result = yield* Schema.decodeUnknownEffect(ChatResponse)({
				id: "turn_one",
				object: "response",
				created_at: 0,
				chat: "chat_one",
				background: true,
				status: "completed",
				output: [
					{
						id: "item_one",
						type: "message",
						role: "assistant",
						status: "completed",
						content: [
							{
								type: "output_text",
								text: "The plan is ready.",
								annotations: [citation],
							},
							{
								type: "output_file",
								artifact_id: "artifact_one",
								version: 2,
								file_id: "file_one",
								filename: "plan.csv",
								media_type: "text/csv",
								bytes: 12,
								availability: "ready",
							},
						],
					},
				],
				error: null,
				incomplete_details: null,
			})
			const content = result.output[0]!.content
			assert.strictEqual(content.length, 2)
			assert.strictEqual(content[0]!.type, "output_text")
			assert.strictEqual(content[1]!.type, "output_file")
			assert.deepStrictEqual(
				yield* Schema.encodeEffect(ChatResponse)(result),
				result,
			)
		}),
	)

	it.effect("a new file version needs the current positive version", () =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownEffect(PublishVersionRequest)
			const input = {
				commandKey: "command_one",
				title: "Plan",
				filename: "plan.csv",
				mediaType: "text/csv",
				from: { _tag: "Text", text: "day,hours\n1,4\n" },
				citations: [citation],
				expectedVersion: 1,
			}
			yield* decode(input)
			yield* Effect.flip(decode({ ...input, expectedVersion: 0 }))
			yield* Effect.flip(decode({ ...input, expectedVersion: 1.5 }))
			yield* Effect.flip(decode({ ...input, expectedVersion: undefined }))
		}),
	)

	it.effect(
		"saved file metadata has a digest and does not contain a download token",
		() =>
			Effect.gen(function* () {
				const version = yield* Schema.decodeUnknownEffect(ArtifactVersion)({
					artifactId: "artifact_one",
					version: 1,
					chatId: "chat_one",
					turnId: "turn_one",
					itemId: "item_one",
					file,
					sha256: digest,
					citations: [citation],
					availability: "ready",
					createdAt: 0,
				})
				assert.notProperty(version, "url")
				assert.strictEqual(version.file.id, "file_one")
				yield* Effect.flip(
					Schema.decodeEffect(ArtifactVersion)({
						...version,
						sha256: "wrong",
					}),
				)
			}),
	)

	it.effect("only a public URL source records a final fetched URL", () =>
		Effect.gen(function* () {
			const capture = Schema.decodeUnknownEffect(CaptureSourceRequest)
			for (const from of [
				{ _tag: "PublicUrl", url: "https://docs.test/page" },
				{ _tag: "AppResult", operationId: "operation_one" },
				{
					_tag: "ComputerTextFile",
					computerId: "computer_one",
					path: "/work/source.txt",
				},
			])
				yield* capture({ commandKey: "command_one", from })
			const source = yield* Schema.decodeUnknownEffect(Source)({
				id: "source_one",
				chatId: "chat_one",
				turnId: null,
				title: "Notes",
				reportedUrl: "https://reported.test/page",
				origin: { _tag: "AppResult", operationId: "operation_one" },
				file,
				sha256: digest,
				availability: "ready",
				capturedAt: 0,
			})
			assert.notProperty(source.origin, "finalUrl")
			assert.notProperty(source, "verified")
		}),
	)

	it.effect(
		"reference events round trip through the public execution schema",
		() =>
			Effect.gen(function* () {
				for (const body of [
					{
						_tag: "SourceCaptured",
						chatId: "chat_one",
						sourceId: "source_one",
					},
					{
						_tag: "ArtifactPublished",
						chatId: "chat_one",
						artifactId: "artifact_one",
						version: 2,
					},
					{
						_tag: "CitationRecorded",
						chatId: "chat_one",
						itemId: "item_one",
						citations: [citation],
					},
				]) {
					const decoded = yield* Schema.decodeUnknownEffect(
						Execution.EventBody,
					)(body)
					assert.deepStrictEqual<unknown>(
						yield* Schema.encodeEffect(Execution.EventBody)(decoded),
						body,
					)
				}
				yield* Schema.decodeEffect(OutputText)({
					type: "output_text",
					text: "An old answer.",
					annotations: [],
				})
			}),
	)
})
