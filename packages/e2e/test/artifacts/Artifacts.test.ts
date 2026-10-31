import { assert, layer } from "@effect/vitest"
import {
	ArtifactsApi,
	ChatItem,
	ChatView,
	ExecutionsApi,
	UserTokensApi,
} from "@openbot-build/api"
import { Artifacts, Authorization, Execution } from "@openbot-build/domain"
import * as Client from "@openbot-build/client"
import {
	BrowserHost,
	Caller,
	Devices,
	Messages,
	Policies,
	Wait,
} from "@openbot-build/openbot/testing"
import { Array as Arr, Crypto, Effect, Option, Schema, Stream } from "effect"
import { Hex } from "effect/encoding"
import * as Fixtures from "./Fixtures.ts"

type Send = Messages.Send
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(schema, status))
const text = (call: Caller.Call) =>
	Effect.gen(function* () {
		const reply = yield* call
		const body = yield* reply.text
		assert.strictEqual(reply.status, 200, body)
		return body
	})
const events = (send: Send, receipt: Execution.Receipt) =>
	Wait.until(
		"the artifact command",
		json(
			Execution.Record,
			send(`/v1/executions/${receipt.executionId}`, "GET"),
		).pipe(
			Effect.map((record) =>
				Execution.isTerminal(record.status)
					? Option.some(record)
					: Option.none(),
			),
		),
	).pipe(
		Effect.tap((record) =>
			Effect.sync(() => assert.strictEqual(record.status, "completed")),
		),
		Effect.andThen(
			json(
				ExecutionsApi.EventPage,
				send(`/v1/executions/${receipt.executionId}/events`, "GET"),
			),
		),
	)
const Items = Schema.Struct({ items: Schema.Array(ChatItem) })

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"HTTP sources and files keep versions, citations, and Chat access after a new connection",
		() =>
			Effect.gen(function* () {
				const storage = yield* Fixtures.storage
				const network = yield* Fixtures.network
				const host = yield* BrowserHost.start({
					publicOrigin: Fixtures.publicOrigin,
					platformAdmins: ["root@example.com"],
					platformFetch: storage.fetch,
					indexPublicNetwork: network.layer,
					model: yield* Fixtures.model,
					bots: { memory: false },
				})
				const root = yield* host.login("root")
				const alice = yield* host.login("artifact-alice")
				const bob = yield* host.login("artifact-bob")
				const address = yield* host.address
				const cookie = Caller.withCookie({
					address,
					publicOrigin: Fixtures.publicOrigin,
				})
				const send: Send = (path, method, payload) =>
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
				const token = yield* json(
					UserTokensApi.CreatedToken,
					send("/v1/user/tokens", "POST", { name: "Artifacts" }),
					201,
				)
				const keyed: Send = (path, method, payload) =>
					Caller.withToken(address)(token.secret, path, method, payload)
				const { api: client } = yield* Client.Client.pipe(
					Effect.provide(
						Client.layer({ baseUrl: address, token: token.secret }),
					),
				)
				const bot = yield* host.defaultBot(alice.session)
				const first = yield* Messages.message(
					send,
					bot,
					"Make a one-week work plan and an hours table.",
				)
				const view = yield* Messages.settled(send, first.chat)
				const item = view.response?.output[0]?.id
				assert.ok(item !== undefined)
				const path = `/v1/chats/${first.chat}`
				const capture = (commandKey: string, url: string) =>
					json(
						Execution.Receipt,
						keyed(path + "/sources", "POST", {
							commandKey,
							from: { _tag: "PublicUrl", url },
							turnId: first.turn,
						}),
						202,
					).pipe(
						Effect.flatMap((receipt) => events(keyed, receipt)),
						Effect.flatMap((page) =>
							Effect.fromOption(
								Arr.findFirst(
									page.events,
									(event) => event.body._tag === "SourceCaptured",
								),
							),
						),
						Effect.map((event) => {
							assert.ok(event.body._tag === "SourceCaptured")
							return event.body.sourceId
						}),
					)
				const hours = yield* capture("capture-hours", Fixtures.hoursUrl)
				const scope = yield* capture("capture-scope", Fixtures.scopeUrl)
				const citations: ReadonlyArray<Artifacts.SourceReference> = [
					{
						type: "source_reference",
						source_id: hours,
						quote: "A work week has five days.",
					},
					{
						type: "source_reference",
						source_id: scope,
						quote: "The plan covers one week.",
					},
				]
				yield* network.change
				assert.strictEqual(
					yield* text(send(`${path}/sources/${hours}/content`, "GET")),
					Fixtures.hoursText,
				)
				const source = yield* json(
					Artifacts.Source,
					send(`${path}/sources/${hours}`, "GET"),
				)
				assert.deepStrictEqual(source.origin, {
					_tag: "PublicUrl",
					url: Fixtures.hoursUrl,
					finalUrl: Fixtures.hoursUrl + "?copy=1",
				})
				const cited = yield* json(
					Execution.Receipt,
					send(path + "/citations", "POST", {
						commandKey: "cite-first",
						itemId: item,
						citations,
					}),
					202,
				)
				assert.ok(
					Arr.some(
						(yield* events(send, cited)).events,
						(event) => event.body._tag === "CitationRecorded",
					),
				)
				const md1 =
					"# Work plan\n\nOne week. My coworker and I each work 8 hours each day from Monday to Friday. We each work 40 hours. The team works 16 hours each day and 80 hours in all.\n"
				const csv1 =
					"day,my_hours,coworker_hours,total_hours\nMonday,8,8,16\nTuesday,8,8,16\nWednesday,8,8,16\nThursday,8,8,16\nFriday,8,8,16\nTotal,40,40,80\n"
				const publish = (
					commandKey: string,
					title: string,
					filename: string,
					mediaType: string,
					body: string,
					turnId = first.turn,
					itemId = item,
				) => ({
					commandKey,
					title,
					filename,
					mediaType,
					from: { _tag: "Text", text: body },
					citations,
					turnId,
					itemId,
				})
				const mdCommand = publish(
					"publish-plan",
					"Work plan",
					"plan.md",
					"text/markdown",
					md1,
				)
				const mdReceipt = yield* json(
					Execution.Receipt,
					keyed(path + "/artifacts", "POST", mdCommand),
					202,
				)
				const published = (page: typeof ExecutionsApi.EventPage.Type) => {
					const event = Arr.findFirst(
						page.events,
						(event) => event.body._tag === "ArtifactPublished",
					)
					assert.ok(
						Option.isSome(event) &&
							event.value.body._tag === "ArtifactPublished",
					)
					return event.value.body.artifactId
				}
				const md = published(yield* events(keyed, mdReceipt))
				const csvReceipt = yield* json(
					Execution.Receipt,
					send(
						path + "/artifacts",
						"POST",
						publish("publish-hours", "Hours", "hours.csv", "text/csv", csv1),
					),
					202,
				)
				const csv = published(yield* events(send, csvReceipt))
				const count = yield* storage.count
				assert.deepStrictEqual(
					yield* json(
						Execution.Receipt,
						send(path + "/artifacts", "POST", mdCommand),
						202,
					),
					mdReceipt,
				)
				assert.strictEqual(yield* storage.count, count)
				assert.strictEqual(
					(yield* send(path + "/artifacts", "POST", {
						...mdCommand,
						title: "Changed",
					})).status,
					409,
				)
				const second = yield* Messages.send(
					send,
					first.chat,
					"I work four hours each day from Monday to Friday. The same coworker works two hours on Monday, two on Tuesday, two on Wednesday, four on Thursday, and four on Friday.",
				)
				const secondView = yield* Messages.settled(send, second.chat)
				const secondItem = secondView.response?.output[0]?.id
				assert.ok(secondItem !== undefined)
				const md2 =
					"# Work plan\n\nOne week, Monday to Friday. I work 4 hours each day and 20 hours in all. The same coworker works 2, 2, 2, 4, and 4 hours on these five days, or 14 hours in all. We work 6 hours each day from Monday to Wednesday and 8 hours each day on Thursday and Friday. The team works 34 hours in all.\n"
				const csv2 =
					"day,my_hours,coworker_hours,total_hours\nMonday,4,2,6\nTuesday,4,2,6\nWednesday,4,2,6\nThursday,4,4,8\nFriday,4,4,8\nTotal,20,14,34\n"
				const csv2Name = "\u5de5\u65f6 '().csv"
				const update = {
					...publish(
						"update-plan",
						"Work plan",
						"plan.md",
						"text/markdown",
						md2,
						second.turn,
						secondItem,
					),
					expectedVersion: 1,
				}
				const updated = yield* json(
					Execution.Receipt,
					keyed(`${path}/artifacts/${md}/versions`, "POST", update),
					202,
				)
				const updatedEvents = yield* events(keyed, updated)
				assert.strictEqual(published(updatedEvents), md)
				const updatedCsv = yield* json(
					Execution.Receipt,
					send(`${path}/artifacts/${csv}/versions`, "POST", {
						...publish(
							"update-hours",
							"Hours",
							csv2Name,
							"text/csv",
							csv2,
							second.turn,
							secondItem,
						),
						expectedVersion: 1,
					}),
					202,
				)
				yield* events(send, updatedCsv)
				assert.strictEqual(
					(yield* send(`${path}/artifacts/${md}/versions`, "POST", {
						...update,
						commandKey: "stale-plan",
					})).status,
					409,
				)
				const all = yield* json(
					ArtifactsApi.ArtifactPage,
					keyed(path + "/artifacts", "GET"),
				)
				assert.strictEqual(all.items.length, 2)
				assert.ok(Arr.every(all.items, (entry) => entry.latestVersion === 2))
				const crypto = yield* Crypto.Crypto
				for (const [id, before, after] of [
					[md, md1, md2],
					[csv, csv1, csv2],
				] as const) {
					const versions = yield* json(
						ArtifactsApi.VersionPage,
						send(`${path}/artifacts/${id}/versions`, "GET"),
					)
					assert.strictEqual(versions.items.length, 2)
					for (const [version, body] of [
						[1, before],
						[2, after],
					] as const) {
						const saved = yield* json(
							Artifacts.ArtifactVersion,
							keyed(`${path}/artifacts/${id}/versions/${version}`, "GET"),
						)
						if (id === csv)
							assert.strictEqual(
								saved.file.filename,
								version === 1 ? "hours.csv" : csv2Name,
							)
						const download = yield* send(
							`${path}/artifacts/${id}/versions/${version}/content`,
							"GET",
						)
						assert.strictEqual(download.status, 200)
						assert.strictEqual(
							download.headers["content-type"],
							saved.file.mediaType,
						)
						assert.strictEqual(
							download.headers["content-length"],
							String(new TextEncoder().encode(body).length),
						)
						const disposition = download.headers["content-disposition"]
						assert.ok(disposition !== undefined)
						const names =
							/^attachment; filename="([A-Za-z0-9._-]+)"; filename\*=UTF-8''([^;]+)$/.exec(
								disposition,
							)
						assert.ok(names !== null)
						assert.strictEqual(
							decodeURIComponent(names[2]!),
							saved.file.filename,
						)
						assert.strictEqual(/['()*]/.test(names[2]!), false)
						assert.strictEqual(yield* download.text, body)
						const typedDownload = yield* client.artifacts.getArtifactContent({
							params: { chatId: first.chat, artifactId: id, version },
						})
						assert.strictEqual(
							yield* Stream.mkString(Stream.decodeText(typedDownload)),
							body,
						)
						assert.strictEqual(
							saved.sha256,
							Hex.encode(
								yield* crypto.digest("SHA-256", new TextEncoder().encode(body)),
							),
						)
						assert.deepStrictEqual(saved.citations, citations)
						assert.strictEqual(
							saved.file.bytes,
							new TextEncoder().encode(body).length,
						)
						assert.strictEqual(
							(yield* send(`/v1/files/${saved.file.id}/content`, "GET")).status,
							404,
						)
						assert.strictEqual(
							(yield* cookie(
								bob.session,
								`${path}/artifacts/${id}/versions/${version}/content`,
							)).status,
							403,
						)
					}
				}
				Fixtures.assertHours(
					yield* text(
						keyed(`${path}/artifacts/${csv}/versions/2/content`, "GET"),
					),
				)
				const readToken = yield* json(
					UserTokensApi.CreatedToken,
					send("/v1/user/tokens", "POST", {
						name: "Read the plan",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow("read", Authorization.Chat, {
								when: ($) => $.eq("id", first.chat),
							})
						}),
					}),
					201,
				)
				const reader: Send = (route, method, payload) =>
					Caller.withToken(address)(readToken.secret, route, method, payload)
				assert.strictEqual(
					yield* text(
						reader(`${path}/artifacts/${md}/versions/2/content`, "GET"),
					),
					md2,
				)
				assert.strictEqual(
					(yield* reader(path + "/artifacts", "POST", {
						...mdCommand,
						commandKey: "read-cannot-write",
					})).status,
					403,
				)
				assert.strictEqual(
					bob.identity.organizationId,
					alice.identity.organizationId,
				)
				const bobPath = `/v1/organization/members/${bob.identity.userId}`
				const sharedRead = yield* Policies.json(function* (_) {
					yield* _.allow("read", Authorization.Chat, {
						when: ($) => $.eq("id", first.chat),
					})
				})
				yield* json(
					Schema.Unknown,
					cookie(root.session, bobPath, "PATCH", { policy: sharedRead }),
				)
				assert.strictEqual(
					yield* text(
						cookie(bob.session, `${path}/artifacts/${md}/versions/2/content`),
					),
					md2,
				)
				assert.strictEqual(
					yield* text(cookie(bob.session, `${path}/sources/${hours}/content`)),
					Fixtures.hoursText,
				)
				const sharedVersion = yield* json(
					Artifacts.ArtifactVersion,
					cookie(bob.session, `${path}/artifacts/${md}/versions/2`),
				)
				assert.strictEqual(
					(yield* cookie(
						bob.session,
						`/v1/files/${sharedVersion.file.id}/content`,
					)).status,
					404,
				)
				assert.strictEqual(
					(yield* cookie(bob.session, path + "/artifacts", "POST", {
						...mdCommand,
						commandKey: "reader-cannot-publish",
					})).status,
					403,
				)
				const emptyPolicy = yield* Policies.json(function* (_) {})
				yield* json(
					Schema.Unknown,
					cookie(root.session, bobPath, "PATCH", { policy: emptyPolicy }),
				)
				assert.strictEqual(
					(yield* cookie(
						bob.session,
						`${path}/artifacts/${md}/versions/2/content`,
					)).status,
					403,
				)
				assert.strictEqual(
					(yield* cookie(bob.session, `${path}/sources/${hours}/content`))
						.status,
					403,
				)
				const org = yield* json(
					Schema.Struct({ version: Schema.Finite }),
					cookie(root.session, "/v1/organization/settings"),
				)
				yield* json(
					Schema.Unknown,
					cookie(root.session, "/v1/organization/settings", "PATCH", {
						expectedVersion: org.version,
						joinByDomain: false,
					}),
				)
				const outsider = yield* host.login("outside-artifacts")
				assert.notStrictEqual(
					outsider.identity.organizationId,
					alice.identity.organizationId,
				)
				assert.strictEqual(
					(yield* cookie(
						outsider.session,
						`${path}/artifacts/${md}/versions/2/content`,
					)).status,
					403,
				)
				const otherBot = yield* Messages.bot(send, { name: "Other plan" })
				const other = yield* Messages.message(
					send,
					otherBot,
					"Make another plan.",
				)
				const otherView = yield* Messages.settled(send, other.chat)
				assert.strictEqual(
					(yield* send(`/v1/chats/${other.chat}/sources/${hours}`, "GET"))
						.status,
					404,
				)
				assert.strictEqual(
					(yield* send(`/v1/chats/${other.chat}/artifacts`, "POST", {
						...mdCommand,
						commandKey: "wrong-chat",
						turnId: other.turn,
						itemId: otherView.response?.output[0]?.id,
					})).status,
					404,
				)
				assert.strictEqual(
					(yield* send(path + "/artifacts", "POST", {
						...mdCommand,
						commandKey: "wrong-quote",
						citations: [
							{
								type: "source_reference",
								source_id: hours,
								quote: "Missing words",
							},
						],
					})).status,
					400,
				)
				yield* host.run(Devices.ageFiles)
				yield* host.run(Devices.collectFiles)
				assert.strictEqual(
					yield* text(
						keyed(`${path}/artifacts/${md}/versions/1/content`, "GET"),
					),
					md1,
				)
				assert.strictEqual(
					yield* text(keyed(`${path}/sources/${hours}/content`, "GET")),
					Fixtures.hoursText,
				)
				const history = yield* json(Items, send(path + "/items", "GET"))
				const oldItem = Arr.findFirst(
					history.items,
					(entry) => entry.id === item,
				)
				assert.ok(Option.isSome(oldItem))
				assert.deepStrictEqual(oldItem.value.citations, citations)
				assert.deepStrictEqual(
					Arr.map(oldItem.value.artifacts, (entry) => entry.version),
					[1, 1],
				)
				const output = yield* json(ChatView, send(path, "GET"))
				assert.strictEqual(
					Arr.flatMap(output.response?.output ?? [], (message) =>
						Arr.filter(message.content, (part) => part.type === "output_file"),
					).length,
					2,
				)
				const cursor = updatedEvents.events[0]?.sequence ?? 0
				const reconnect: Send = (route, method, payload) =>
					Caller.withToken(address)(token.secret, route, method, payload)
				const rest = yield* json(
					ExecutionsApi.EventPage,
					reconnect(
						`/v1/executions/${updated.executionId}/events?afterSequence=${cursor}`,
						"GET",
					),
				)
				assert.deepStrictEqual(
					rest.events,
					Arr.filter(updatedEvents.events, (entry) => entry.sequence > cursor),
				)
				assert.ok(rest.terminal)
				const empty = yield* json(
					ExecutionsApi.EventPage,
					reconnect(
						`/v1/executions/${updated.executionId}/events?afterSequence=${rest.afterSequence}`,
						"GET",
					),
				)
				assert.deepStrictEqual(empty.events, [])
				assert.deepStrictEqual(
					yield* json(
						ArtifactsApi.ArtifactPage,
						reconnect(path + "/artifacts", "GET"),
					),
					all,
				)
				assert.strictEqual(
					(yield* send(`/v1/user/tokens/${readToken.token.id}`, "DELETE"))
						.status,
					204,
				)
				assert.strictEqual(
					(yield* reader(`${path}/artifacts/${md}/versions/2/content`, "GET"))
						.status,
					401,
				)

				// After the two-file check, one more file covers a concurrent change.
				const raceReceipt = yield* json(
					Execution.Receipt,
					send(
						path + "/artifacts",
						"POST",
						publish("race-create", "Race", "race.md", "text/markdown", "First"),
					),
					202,
				)
				const raceId = published(yield* events(send, raceReceipt))
				const racePath = `${path}/artifacts/${raceId}/versions`
				const raced = yield* Effect.all(
					Arr.map(["left", "right"], (side) =>
						send(racePath, "POST", {
							...publish(
								"race-" + side,
								"Race",
								"race.md",
								"text/markdown",
								side,
							),
							expectedVersion: 1,
						}),
					),
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(
					Arr.countBy(raced, (response) => response.status === 202),
					1,
				)
				assert.strictEqual(
					Arr.countBy(raced, (response) => response.status === 409),
					1,
				)
				const winner = yield* Effect.fromOption(
					Arr.findFirst(raced, (response) => response.status === 202),
				)
				yield* events(send, yield* Caller.json(Execution.Receipt, 202)(winner))
				assert.strictEqual(
					(yield* json(ArtifactsApi.VersionPage, send(racePath, "GET"))).items
						.length,
					2,
				)
			}),
		120000,
	)
})
