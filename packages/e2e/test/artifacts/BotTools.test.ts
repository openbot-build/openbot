import { assert, layer } from "@effect/vitest"
import { ArtifactsApi, ChatItem, ExecutionsApi } from "@openbot-build/api"
import { Artifacts } from "@openbot-build/domain"
import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"
import {
	Array as Arr,
	Effect,
	Option,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Prompt, Response } from "effect/ai"
import * as Fixtures from "./Fixtures.ts"

const usage = {
	inputTokens: { total: 5, uncached: 5, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const plan1 =
	"# Plan\n\nOne week, Monday to Friday. My coworker and I each work 8 hours each day, or 40 hours each. The team works 80 hours.\n"
const plan2 =
	"# Plan\n\nOne week, Monday to Friday. I work 4 hours each day, or 20 hours. The same coworker works 2, 2, 2, 4, and 4 hours on these five days, or 14 hours. Daily team hours are 6, 6, 6, 8, and 8. The team works 34 hours.\n"
const csv1 =
	"day,my_hours,coworker_hours,total_hours\nMonday,8,8,16\nTuesday,8,8,16\nWednesday,8,8,16\nThursday,8,8,16\nFriday,8,8,16\nTotal,40,40,80\n"
const csv2 =
	"day,my_hours,coworker_hours,total_hours\nMonday,4,2,6\nTuesday,4,2,6\nWednesday,4,2,6\nThursday,4,4,8\nFriday,4,4,8\nTotal,20,14,34\n"
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(schema, status))
const resultsOf = (prompt: Prompt.Prompt) =>
	Arr.flatMap(prompt.content, (message) =>
		message.role === "tool"
			? Arr.filter(message.content, (part) => part.type === "tool-result")
			: [],
	)
const call = (
	id: string,
	name: string,
	params: unknown,
): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("tool-call", {
			id,
			name,
			params,
			providerExecuted: false,
		}),
		Response.makePart("finish", { reason: "tool-calls", usage }),
	)
const answer = (): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", {
			id: "answer",
			delta: "Both files are ready with the saved sources.",
		}),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/** The model gets every ID from a real tool result before using it again. */
const model = LanguageModel.make({
	generateText: () => Effect.die("This test uses the model stream."),
	streamText: ({ prompt }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const results = resultsOf(prompt)
				assert.ok(Arr.every(results, (part) => !part.isFailure))
				const user = Arr.findLast(
					prompt.content,
					(message): message is Prompt.UserMessage => message.role === "user",
				)
				const changing =
					Option.isSome(user) &&
					Arr.some(
						user.value.content,
						(part) =>
							part.type === "text" &&
							Str.includes("Change the last files")(part.text),
					)
				const captured = Arr.filter(
					results,
					(part) => part.name === "openbot_capture_source",
				)
				if (captured.length < 2)
					return call(`capture-${captured.length}`, "openbot_capture_source", {
						from: {
							_tag: "PublicUrl",
							url:
								captured.length === 0 ? Fixtures.hoursUrl : Fixtures.scopeUrl,
						},
					})
				const sources = yield* Effect.forEach(captured, (part) =>
					Schema.decodeUnknownEffect(Artifacts.Source)(part.result),
				)
				const citations = Arr.map(sources, (source) => ({
					type: "source_reference",
					source_id: source.id,
				}))
				const published = yield* Effect.forEach(
					Arr.filter(
						results,
						(part) => part.name === "openbot_publish_artifact",
					),
					(part) =>
						Schema.decodeUnknownEffect(Artifacts.ArtifactVersion)(part.result),
				)
				if (changing && !Arr.some(results, (part) => part.id === "list-again"))
					return call("list-again", "openbot_list_artifacts", {})
				if (
					changing &&
					!Arr.some(results, (part) => part.id === "read-again")
				) {
					const listed = Arr.findFirst(
						results,
						(part) => part.id === "list-again",
					)
					assert.ok(Option.isSome(listed))
					const page = yield* Schema.decodeUnknownEffect(
						ArtifactsApi.ArtifactPage,
					)(listed.value.result)
					assert.strictEqual(page.items.length, 2)
					return call("read-again", "openbot_read_artifact", {
						artifactId: published[0]!.artifactId,
					})
				}
				if (changing) {
					const read = Arr.findFirst(
						results,
						(part) => part.id === "read-again",
					)
					assert.ok(Option.isSome(read))
					const saved = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ text: Schema.String }),
					)(read.value.result)
					assert.strictEqual(saved.text, plan1)
				}
				const target = changing ? 4 : 2
				if (published.length < target) {
					const index = published.length % 2
					return call(
						`publish-${published.length}`,
						"openbot_publish_artifact",
						{
							title: index === 0 ? "Plan" : "Hours",
							filename: index === 0 ? "plan.md" : "hours.csv",
							mediaType: index === 0 ? "text/markdown" : "text/csv",
							citations,
							from: {
								_tag: "Text",
								text:
									index === 0
										? changing
											? plan2
											: plan1
										: changing
											? csv2
											: csv1,
							},
							...(changing
								? {
										artifactId: published[index]!.artifactId,
										expectedVersion: published[index]!.version,
									}
								: {}),
						},
					)
				}
				const citeId = changing ? "cite-again" : "cite-first"
				if (!Arr.some(results, (part) => part.id === citeId))
					return call(citeId, "openbot_cite_sources", { citations })
				return answer()
			}).pipe(Effect.orDie),
		),
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"the Bot captures sources, publishes two files, cites its answer, and changes the same files",
		() =>
			Effect.gen(function* () {
				const storage = yield* Fixtures.storage
				const network = yield* Fixtures.network
				const host = yield* BrowserHost.start({
					publicOrigin: Fixtures.publicOrigin,
					platformAdmins: ["root@example.com"],
					platformFetch: storage.fetch,
					indexPublicNetwork: network.layer,
					model: yield* model,
					bots: { memory: false },
				})
				const root = yield* host.login("root")
				const alice = yield* host.login("bot-artifacts")
				const address = yield* host.address
				const cookie = Caller.withCookie({
					address,
					publicOrigin: Fixtures.publicOrigin,
				})
				const send: Messages.Send = (path, method, payload) =>
					cookie(alice.session, path, method, payload)
				const current = yield* json(
					Schema.Struct({ version: Schema.Finite }),
					cookie(root.session, "/v1/platform/settings"),
				)
				yield* json(
					Schema.Unknown,
					cookie(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: current.version,
						files: {
							mediaTypes: ["text/plain", "text/markdown", "text/csv"],
							storage: {
								endpoint: Fixtures.storageOrigin,
								publicEndpoint: null,
								region: "us-east-1",
								bucket: "openbot",
								accessKeyId: "test-access-key",
								secretAccessKey: "test-secret-access-key",
								forcePathStyle: true,
							},
						},
					}),
				)
				const bot = yield* host.defaultBot(alice.session)
				const first = yield* Messages.message(
					send,
					bot,
					"Make a one-week work plan and an hours table. Save and cite the sources.",
				)
				const before = yield* Messages.settled(send, first.chat)
				assert.strictEqual(before.response?.status, "completed")
				const path = `/v1/chats/${first.chat}`
				const sources = yield* json(
					ArtifactsApi.SourcePage,
					send(path + "/sources", "GET"),
				)
				assert.strictEqual(sources.items.length, 2)
				const annotations = Arr.flatMap(
					before.response?.output ?? [],
					(message) =>
						Arr.flatMap(message.content, (part) =>
							part.type === "output_text" ? part.annotations : [],
						),
				)
				assert.strictEqual(annotations.length, 2)
				const initial = yield* json(
					ArtifactsApi.ArtifactPage,
					send(path + "/artifacts", "GET"),
				)
				assert.strictEqual(initial.items.length, 2)
				const second = yield* Messages.send(
					send,
					first.chat,
					"Change the last files. I work four hours each day from Monday to Friday. The same coworker works two hours on Monday, two on Tuesday, two on Wednesday, four on Thursday, and four on Friday.",
				)
				const after = yield* Messages.settled(send, second.chat)
				assert.strictEqual(after.response?.status, "completed")
				const updated = yield* json(
					ArtifactsApi.ArtifactPage,
					send(path + "/artifacts", "GET"),
				)
				assert.deepStrictEqual(
					Arr.map(updated.items, (entry) => entry.id),
					Arr.map(initial.items, (entry) => entry.id),
				)
				assert.ok(
					Arr.every(updated.items, (entry) => entry.latestVersion === 2),
				)
				for (const artifact of updated.items) {
					const detail = yield* json(
						ArtifactsApi.ArtifactDetail,
						send(`${path}/artifacts/${artifact.id}`, "GET"),
					)
					for (const version of [1, 2]) {
						const response = yield* send(
							`${path}/artifacts/${artifact.id}/versions/${version}/content`,
							"GET",
						)
						assert.strictEqual(response.status, 200)
						const body = yield* response.text
						if (detail.latest.file.filename === "hours.csv" && version === 2)
							Fixtures.assertHours(body)
						assert.strictEqual(
							body,
							detail.latest.file.filename === "plan.md"
								? version === 1
									? plan1
									: plan2
								: version === 1
									? csv1
									: csv2,
						)
					}
				}
				const history = yield* json(
					Schema.Struct({ items: Schema.Array(ChatItem) }),
					send(path + "/items?limit=100", "GET"),
				)
				assert.strictEqual(
					Arr.countBy(history.items, (item) => item.citations.length === 2),
					2,
				)
				assert.strictEqual(
					Arr.reduce(
						history.items,
						0,
						(count, item) => count + item.artifacts.length,
					),
					4,
				)
				const recorded = yield* json(
					ExecutionsApi.EventPage,
					send(`/v1/executions/${second.executionId}/events`, "GET"),
				)
				assert.strictEqual(
					Arr.countBy(
						recorded.events,
						(event) => event.body._tag === "CitationRecorded",
					),
					1,
				)
			}),
		120000,
	)
})
