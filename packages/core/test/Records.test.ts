import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Prompt } from "effect/ai"
import {
	Item,
	Timeline,
	TimelineState,
	MemoryPersistence,
	RecordSerialization,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
const metadata = {
	archived: false,
	title: "native",
}

test("complete records keep native bytes, opaque provider items and original Item IDs", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "timeline/1",
				})
				const store = yield* SessionStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const content = Prompt.make([
					{
						role: "user",
						content: [
							Prompt.filePart({
								mediaType: "image/png",
								data: new Uint8Array([0, 255, 1]),
							}),
						],
					},
				])
				const value = TimelineState.initial({
					unknown: { archived: [1, null] },
				})
				const created = yield* store.create({
					metadata,
					value: {
						...value,
						conversation: {
							...value.conversation,
							history: [{ id: Item.Id.make("media"), content }],
							context: {
								_tag: "Native",
								provider:
									"provider" as import("@openbot-build/core").Provider.Id,
								model: "model" as import("@openbot-build/core").Model.Id,
								items: [{ type: "reasoning", encrypted_content: "opaque" }],
								prompt: content,
							},
						},
					},
				})
				const codec = RecordSerialization.make<{}>(),
					exported = yield* store.export(created.session.id)
				const record = yield* codec.decode({
					definition,
					input: yield* codec.encode({ definition, record: exported }),
				})
				const restored = yield* codec.materialize({ definition, record })
				assert.deepEqual(restored.value, created.state.value)
				assert.equal(restored.value.conversation.history[0]!.id, "media")
				assert.equal(
					Timeline.VersionId.make(created.session.head),
					restored.version.id,
				)
			}),
		),
	)
})
