import { assert, layer } from "@effect/vitest"
import { ArtifactsApi, ComputersApi, ExecutionsApi } from "@openbot-build/api"
import { Artifacts, Execution } from "@openbot-build/domain"
import { Network } from "@openbot-build/protocol"
import { eq } from "drizzle-orm"
import {
	Array as Arr,
	Crypto,
	Effect,
	HashMap,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { Base64, Hex } from "effect/encoding"
import * as Db from "../src/database/Database.ts"
import {
	artifactJobs,
	executionFailures,
	files,
} from "../src/database/Schema.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Wait from "./Wait.ts"
import * as ComputerScenarios from "./testing/ComputerScenarios.ts"
import * as Devices from "./testing/Devices.ts"

const publicOrigin = "https://artifact-files.example.com"
const storageOrigin = "http://artifact-files.test"
type StorageMode = "normal" | "before" | "after" | "fail"
type Send = Messages.Send
const json = <S extends Schema.Constraint>(
	schema: S,
	call: Caller.Call,
	status = 200,
) => Effect.flatMap(call, Caller.json(schema, status))

/** Read the current address, since a restart gives the host a new port. */
const client =
	(host: BrowserHost.Host, session: Redacted.Redacted<string>): Send =>
	(path, method, payload) =>
		Effect.flatMap(host.address, (address) =>
			Caller.withCookie({ address, publicOrigin })(
				session,
				path,
				method,
				payload,
			),
		)

const terminal = (send: Send, receipt: Execution.Receipt) =>
	Wait.untilTrue(
		"the file command",
		json(
			Execution.Record,
			send(`/v1/executions/${receipt.executionId}`, "GET"),
		),
		(record) => Execution.isTerminal(record.status),
	)
const completed = (
	host: BrowserHost.Host,
	send: Send,
	receipt: Execution.Receipt,
) =>
	terminal(send, receipt).pipe(
		Effect.tap((record) =>
			Effect.gen(function* () {
				let details = "The command has no failure record."
				if (record.failure !== null) {
					const rows = yield* host.run(
						Effect.flatMap(Db.make, (db) =>
							db
								.select()
								.from(executionFailures)
								.where(eq(executionFailures.id, record.failure!.errorId)),
						),
					)
					const secrets = yield* Secrets.Secrets.pipe(
						Effect.provide(
							Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
						),
					)
					if (rows[0] !== undefined)
						details = yield* secrets.open(
							rows[0].cause,
							"failure:" + rows[0].id,
						)
				}
				assert.strictEqual(record.status, "completed", details)
			}),
		),
	)
const text = (call: Caller.Call) =>
	Effect.gen(function* () {
		const reply = yield* call
		const body = yield* reply.text
		assert.strictEqual(reply.status, 200, body)
		return body
	})

/** Real S3 calls stop at selected points, as if the process lost its reply. */
const storage = Effect.gen(function* () {
	const objects = yield* Ref.make(
		HashMap.empty<string, Uint8Array<ArrayBuffer>>(),
	)
	const mode = yield* Ref.make<StorageMode>("normal")
	const stopped = yield* Ref.make(false)
	const writes = yield* Ref.make(0)
	const stop = (request: Request) =>
		Effect.callback<Response>((resume) => {
			const abort = () =>
				resume(Effect.succeed(new Response(null, { status: 503 })))
			request.signal.addEventListener("abort", abort, { once: true })
			if (request.signal.aborted) abort()
			return Effect.sync(() =>
				request.signal.removeEventListener("abort", abort),
			)
		})
	return {
		writes: Ref.get(writes),
		stopped: Ref.get(stopped),
		set: (next: StorageMode) =>
			Ref.set(stopped, false).pipe(Effect.andThen(Ref.set(mode, next))),
		fetch: Effect.fn("ArtifactFiles.storage")(function* (request: Request) {
			const key = new URL(request.url).pathname
			assert.ok(request.headers.has("authorization"))
			switch (request.method) {
				case "PUT": {
					const current = yield* Ref.get(mode)
					if (current === "fail") return new Response(null, { status: 503 })
					if (current === "before") {
						yield* Ref.set(stopped, true)
						return yield* stop(request)
					}
					const bytes = new Uint8Array(
						yield* Effect.promise(() => request.arrayBuffer()),
					)
					yield* Ref.update(objects, HashMap.set(key, bytes))
					yield* Ref.update(writes, (count) => count + 1)
					if (current === "after") {
						yield* Ref.set(stopped, true)
						return yield* stop(request)
					}
					return new Response(null, { status: 200 })
				}
				case "GET":
				case "HEAD": {
					const found = HashMap.get(yield* Ref.get(objects), key)
					if (Option.isNone(found)) return new Response(null, { status: 404 })
					return new Response(
						request.method === "HEAD" ? null : new Blob([found.value]),
						{
							headers: { "content-length": String(found.value.length) },
						},
					)
				}
				case "DELETE":
					yield* Ref.update(objects, HashMap.remove(key))
					return new Response(null, { status: 204 })
			}
			return new Response(null, { status: 405 })
		}),
	}
})

const configure = (
	send: Send,
	limits: Readonly<Record<string, unknown>> = {},
) =>
	Effect.gen(function* () {
		const current = yield* json(
			Schema.Struct({ version: Schema.Finite }),
			send("/v1/platform/settings", "GET"),
		)
		yield* json(
			Schema.Unknown,
			send("/v1/platform/settings", "PATCH", {
				expectedVersion: current.version,
				files: {
					storage: {
						endpoint: storageOrigin,
						publicEndpoint: null,
						region: "us-east-1",
						bucket: "openbot",
						accessKeyId: "test-access-key",
						secretAccessKey: "test-secret-access-key",
						forcePathStyle: true,
					},
					mediaTypes: ["text/plain", "text/markdown", "text/csv"],
					...limits,
				},
			}),
		)
	})
const pendingFile = (id: string) =>
	Effect.flatMap(Db.make, (db) =>
		db
			.select({ file: artifactJobs.file, snapshot: artifactJobs.snapshot })
			.from(artifactJobs)
			.where(eq(artifactJobs.executionId, id)),
	).pipe(Effect.map(Arr.head), Effect.flatMap(Effect.fromOption))
const savedRows = Effect.flatMap(Db.make, (db) => db.select().from(files))
const publishInput = (commandKey: string, body: string) => ({
	commandKey,
	title: "Hours",
	filename: "hours.csv",
	mediaType: "text/csv",
	from: { _tag: "Text", text: body },
	citations: [],
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Computer bytes and source text stay fixed through storage writes, restarts, and removal",
		() =>
			Effect.gen(function* () {
				const store = yield* storage
				const provider = yield* ComputerScenarios.fakeProvider
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformAdmins: ["root@example.com"],
					platformFetch: store.fetch,
					computerDrivers: provider.layer,
					bots: { memory: false },
				})
				const root = yield* host.login("root")
				const alice = yield* host.login("computer-artifact-alice")
				const send = client(host, alice.session)
				yield* configure(client(host, root.session))
				const bot = yield* host.defaultBot(alice.session)
				const receipt = yield* Messages.message(
					send,
					bot,
					"Make the hours file.",
				)
				yield* Messages.settled(send, receipt.chat)
				const path = `/v1/chats/${receipt.chat}`
				const computerProvider = yield* json(
					ComputersApi.ComputerProvider,
					send("/v1/computer-providers", "POST", {
						name: "Files",
						credentials: { kind: "e2b", apiKey: "e2b_test_key_123456" },
					}),
					201,
				)
				const made = yield* json(
					Execution.Receipt,
					send("/v1/computers", "POST", {
						commandKey: "make-computer",
						name: "Files",
						source: {
							_tag: "Provider",
							provider: computerProvider.id,
							template: null,
						},
						desktop: false,
					}),
					202,
				)
				const madeRecord = yield* completed(host, send, made)
				const computer = yield* json(
					ComputersApi.Computer,
					send(`/v1/computers/${madeRecord.resource.id}`, "GET"),
				)
				const machinePath = `/v1/computers/${computer.id}`
				yield* json(
					ComputersApi.ComputerAccess,
					send(`${machinePath}/bots/${bot}`, "PUT"),
				)
				const write = (path: string, content: string) =>
					send(machinePath + "/files", "PUT", {
						path,
						encoding: "base64",
						content: Base64.encode(new TextEncoder().encode(content)),
					}).pipe(
						Effect.tap((reply) =>
							Effect.sync(() => assert.strictEqual(reply.status, 204)),
						),
					)
				const sourceText = "The team  works five days.\r\nKeep this line.\r\n"
				yield* write("/source.txt", sourceText)
				const captured = yield* json(
					Execution.Receipt,
					send(path + "/sources", "POST", {
						commandKey: "capture-computer-text",
						reportedUrl: "https://notes.example.com/reported",
						from: {
							_tag: "ComputerTextFile",
							computerId: computer.id,
							path: "/source.txt",
						},
					}),
					202,
				)
				yield* completed(host, send, captured)
				const sources = yield* json(
					ArtifactsApi.SourcePage,
					send(path + "/sources", "GET"),
				)
				assert.strictEqual(sources.items.length, 1)
				const source = sources.items[0]!
				assert.deepStrictEqual(source.origin, {
					_tag: "ComputerTextFile",
					computerId: computer.id,
					path: "/source.txt",
				})
				assert.strictEqual(
					source.reportedUrl,
					"https://notes.example.com/reported",
				)
				yield* write("/source.txt", "The source changed.")
				assert.strictEqual(
					yield* text(send(`${path}/sources/${source.id}/content`, "GET")),
					sourceText,
				)
				const firstText = "person,hours\nme,4\n"
				yield* write("/hours.csv", firstText)
				const command = {
					...publishInput("publish-computer", ""),
					from: {
						_tag: "ComputerPath",
						computerId: computer.id,
						path: "/hours.csv",
					},
					citations: [
						{
							type: "source_reference",
							source_id: source.id,
							quote: "works five days.",
						},
					],
				}
				const first = yield* json(
					Execution.Receipt,
					send(path + "/artifacts", "POST", command),
					202,
				)
				yield* completed(host, send, first)
				const list = yield* json(
					ArtifactsApi.ArtifactPage,
					send(path + "/artifacts", "GET"),
				)
				assert.strictEqual(list.items.length, 1)
				const artifactPath = `${path}/artifacts/${list.items[0]!.id}`
				const firstVersion = yield* json(
					Artifacts.ArtifactVersion,
					send(artifactPath + "/versions/1", "GET"),
				)
				assert.strictEqual(
					yield* text(send(artifactPath + "/versions/1/content", "GET")),
					firstText,
				)
				const crypto = yield* Crypto.Crypto
				assert.strictEqual(
					firstVersion.sha256,
					Hex.encode(
						yield* crypto.digest(
							"SHA-256",
							new TextEncoder().encode(firstText),
						),
					),
				)
				for (const mode of ["before", "after"] as const) {
					const version = mode === "before" ? 2 : 3
					const body = `person,hours\nme,${version + 3}\n`
					yield* write("/hours.csv", body)
					yield* store.set(mode)
					const update = {
						...command,
						commandKey: "publish-" + mode,
						expectedVersion: version - 1,
					}
					const updating = yield* json(
						Execution.Receipt,
						send(artifactPath + "/versions", "POST", update),
						202,
					)
					yield* Wait.untilTrue(
						"the held storage call",
						store.stopped,
						(value) => value,
					)
					const saved = yield* host.run(pendingFile(updating.executionId))
					assert.ok(saved.snapshot !== null)
					const old = yield* json(
						ArtifactsApi.ArtifactDetail,
						send(artifactPath, "GET"),
					)
					assert.strictEqual(old.artifact.latestVersion, version - 1)
					yield* host.run(Devices.ageFiles)
					yield* host.run(Devices.collectFiles)
					assert.strictEqual(
						(yield* host.run(Devices.savedFiles(saved.file)))[0]
							?.cleanupExecutionId,
						null,
					)
					assert.strictEqual(
						(yield* send(`/v1/files/${saved.file}`, "DELETE")).status,
						409,
					)
					yield* write("/hours.csv", "This is a later file of the same path.")
					const writes = yield* store.writes
					yield* store.set("normal")
					yield* host.restart
					yield* completed(host, send, updating)
					assert.strictEqual(
						yield* text(
							send(`${artifactPath}/versions/${version}/content`, "GET"),
						),
						body,
					)
					assert.strictEqual(
						yield* store.writes,
						writes + (mode === "before" ? 1 : 0),
					)
					assert.deepStrictEqual(
						yield* json(
							Execution.Receipt,
							send(artifactPath + "/versions", "POST", update),
							202,
						),
						updating,
					)
				}
				const removed = yield* json(
					Execution.Receipt,
					send(machinePath, "DELETE", { commandKey: "remove-computer" }),
					202,
				)
				yield* completed(host, send, removed)
				yield* provider.reachable(false)
				assert.strictEqual(
					yield* text(send(artifactPath + "/versions/1/content", "GET")),
					firstText,
				)
				assert.strictEqual(
					(yield* send(`/v1/files/${firstVersion.file.id}`, "DELETE")).status,
					204,
				)
				yield* Wait.untilTrue(
					"the removed file bytes",
					host.run(Devices.savedFiles(firstVersion.file.id)),
					(rows) => rows.length === 0,
				)
				const gone = yield* json(
					Artifacts.ArtifactVersion,
					send(artifactPath + "/versions/1", "GET"),
				)
				assert.strictEqual(gone.availability, "unavailable")
				assert.strictEqual(
					(yield* send(artifactPath + "/versions/1/content", "GET")).status,
					404,
				)
				assert.deepStrictEqual(
					yield* json(
						Execution.Receipt,
						send(path + "/artifacts", "POST", command),
						202,
					),
					first,
				)
				yield* host.restart
				assert.strictEqual(
					(yield* send(artifactPath + "/versions/1/content", "GET")).status,
					404,
				)
				assert.strictEqual(
					(yield* json(ArtifactsApi.ArtifactDetail, send(artifactPath, "GET")))
						.artifact.latestVersion,
					3,
				)
			}),
		{ timeout: 90_000 },
	)

	it.effect(
		"sources and all versions use quota, and failed changes keep the current file",
		() =>
			Effect.gen(function* () {
				const store = yield* storage
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformAdmins: ["root@example.com"],
					platformFetch: store.fetch,
					indexPublicNetwork: Layer.succeed(Network.PublicNetwork, {
						readDocument: ({ url }) =>
							Effect.succeed({
								url,
								status: 200,
								headers: { "content-type": "text/plain" },
								text: "note",
							}),
					}),
					bots: { memory: false },
				})
				const root = yield* host.login("root")
				const alice = yield* host.login("quota-artifact-alice")
				const send = client(host, alice.session)
				const admin = client(host, root.session)
				yield* configure(admin, { quotaBytes: 12 })
				const bot = yield* host.defaultBot(alice.session)
				const receipt = yield* Messages.message(send, bot, "Make a file.")
				yield* Messages.settled(send, receipt.chat)
				const path = `/v1/chats/${receipt.chat}/artifacts`
				const captured = yield* json(
					Execution.Receipt,
					send(`/v1/chats/${receipt.chat}/sources`, "POST", {
						commandKey: "quota-source",
						from: { _tag: "PublicUrl", url: "https://notes.example.com/size" },
					}),
					202,
				)
				yield* completed(host, send, captured)
				const first = yield* json(
					Execution.Receipt,
					send(path, "POST", publishInput("first", "a,1\n")),
					202,
				)
				yield* completed(host, send, first)
				const list = yield* json(ArtifactsApi.ArtifactPage, send(path, "GET"))
				const artifactPath = `${path}/${list.items[0]!.id}`
				const secondInput = {
					...publishInput("second", "a,2\n"),
					expectedVersion: 1,
				}
				const second = yield* json(
					Execution.Receipt,
					send(artifactPath + "/versions", "POST", secondInput),
					202,
				)
				yield* completed(host, send, second)
				assert.deepStrictEqual(
					yield* json(
						Execution.Receipt,
						send(artifactPath + "/versions", "POST", secondInput),
						202,
					),
					second,
				)
				const used = Arr.reduce(
					yield* host.run(savedRows),
					0,
					(total, row) => total + row.bytes,
				)
				assert.strictEqual(used, 12)
				const noRoom = yield* json(
					Execution.Receipt,
					send(artifactPath + "/versions", "POST", {
						...publishInput("no-room", "x"),
						expectedVersion: 2,
					}),
					202,
				)
				assert.strictEqual((yield* terminal(send, noRoom)).status, "failed")
				assert.strictEqual(
					Arr.reduce(
						yield* host.run(savedRows),
						0,
						(total, row) => total + row.bytes,
					),
					12,
				)
				yield* configure(admin, {
					quotaBytes: null,
					maxBytes: 4,
					mediaTypes: ["text/csv"],
				})
				for (const input of [
					{ ...publishInput("large", "too large"), expectedVersion: 2 },
					{
						...publishInput("type", "a"),
						mediaType: "text/plain",
						expectedVersion: 2,
					},
				]) {
					const rejected = yield* json(
						Execution.Receipt,
						send(artifactPath + "/versions", "POST", input),
						202,
					)
					assert.strictEqual((yield* terminal(send, rejected)).status, "failed")
				}
				yield* store.set("fail")
				const failed = yield* json(
					Execution.Receipt,
					send(artifactPath + "/versions", "POST", {
						...publishInput("storage-failed", "a,3\n"),
						expectedVersion: 2,
					}),
					202,
				)
				const uncertain = yield* Wait.untilTrue(
					"the stored storage failure",
					json(
						Execution.Record,
						send(`/v1/executions/${failed.executionId}`, "GET"),
					),
					(record) => record.status === "outcome_unknown",
				)
				assert.ok(uncertain.failure !== null)
				yield* store.set("normal")
				const detail = yield* json(
					ArtifactsApi.ArtifactDetail,
					send(artifactPath, "GET"),
				)
				assert.strictEqual(detail.artifact.latestVersion, 2)
				assert.strictEqual(
					yield* text(send(artifactPath + "/versions/1/content", "GET")),
					"a,1\n",
				)
				assert.strictEqual(
					yield* text(send(artifactPath + "/versions/2/content", "GET")),
					"a,2\n",
				)
				assert.strictEqual(
					(yield* json(
						ArtifactsApi.VersionPage,
						send(artifactPath + "/versions", "GET"),
					)).items.length,
					2,
				)
				const cancelled = yield* json(
					Execution.Receipt,
					send(`/v1/executions/${failed.executionId}/cancel`, "POST", {
						commandKey: "stop-storage-failure",
					}),
					200,
				)
				const decision = yield* Wait.until(
					"the storage stop choice",
					json(
						ExecutionsApi.EventPage,
						send(`/v1/executions/${failed.executionId}/events`, "GET"),
					).pipe(
						Effect.map((page) =>
							Arr.findLast(
								page.events,
								(event) =>
									event.sequence > cancelled.sequence &&
									event.body._tag === "DecisionNeeded" &&
									event.body.choices.length === 1 &&
									event.body.choices[0] === "stop",
							),
						),
					),
				)
				assert.ok(decision.body._tag === "DecisionNeeded")
				yield* json(
					Execution.Receipt,
					send(`/v1/executions/${failed.executionId}/decisions`, "POST", {
						commandKey: "stop-storage-choice",
						decisionId: decision.body.decisionId,
						answer: "stop",
					}),
				)
				assert.strictEqual(
					(yield* terminal(send, failed)).status,
					"interrupted",
				)
			}),
	)
})
