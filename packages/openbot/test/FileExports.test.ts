import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { Authorization } from "@openbot-build/domain"
import { eq } from "drizzle-orm"
import { Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import { files, fileRefs, organizations } from "../src/database/Schema.ts"
import * as Files from "../src/files/Files.ts"
import { FileTasks } from "../src/files/FileTasks.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import { Settings } from "../src/settings/Settings.ts"
import { filesDefaults } from "../src/settings/Documents.ts"
import * as Postgres from "./PostgresTest.ts"

const database = Layer.effectDiscard(Database.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (db) =>
				Database.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)
const caller = {
	kind: "member",
	organizationId: "file-exports",
	userId: "member",
} as const
const content = {
	fileName: "result.txt",
	mediaType: "text/plain",
	bytes: new TextEncoder().encode("result"),
}
const reference = { namespace: "file-exports:member", chat: "chat-output" }

/** Real File rows with an S3-compatible in-memory transport. */
const fixture = () => {
	const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>()
	let puts = 0
	let failure: "none" | "before" | "after" = "none"
	const client = HttpClient.make((request) =>
		Effect.sync(() => {
			let status = 200
			let headers: Record<string, string> = {}
			let body: Uint8Array | null = null
			if (request.method === "PUT") {
				puts++
				if (request.body._tag !== "Uint8Array")
					assert.fail("Expected file bytes")
				if (failure !== "before")
					objects.set(request.url, {
						bytes: request.body.body,
						mediaType: request.headers["content-type"]!,
					})
				if (failure !== "none") status = 503
			} else {
				const object = objects.get(request.url)
				if (object === undefined) status = 404
				else {
					headers = {
						"content-length": String(object.bytes.length),
						"content-type": object.mediaType,
					}
					if (request.method === "GET") body = object.bytes
				}
			}
			return HttpClientResponse.fromWeb(
				request,
				new Response(body === null ? null : new Uint8Array(body).buffer, {
					status,
					headers,
				}),
			)
		}),
	)
	const service = Files.layer.pipe(
		Layer.provide([
			Layer.succeed(HttpClient.HttpClient, client),
			Layer.mock(Secrets, { open: () => Effect.succeed("test-secret") }),
			Layer.mock(FileTasks, {}),
			Authorizer.layer(Authorization.Auth, {
				policy: () =>
					Effect.succeed(
						Policy.define(Authorization.OpenBot)(function* (_) {
							yield* _.allow("*", "*")
						}),
					),
			}),
			Layer.mock(Settings, {
				platform: Effect.succeedSome({
					version: 0,
					updatedAt: 0,
					document: {
						publicOrigin: "https://openbot.example.com",
						authSecret: "test",
						identityProvider: null,
						organizationCreation: "anyone" as const,
						ceiling: Authorization.emptyPolicy,
						appRestrictions: [],
						files: {
							...filesDefaults,
							maxBytes: 12,
							quotaBytes: 12,
							mediaTypes: [
								"text/plain",
								"application/vnd.openxmlformats-officedocument.presentationml.presentation",
							],
							storage: {
								endpoint: "https://storage.example.com",
								publicEndpoint: null,
								region: "local",
								bucket: "files",
								accessKeyId: "test",
								secretAccessKey: "sealed",
								secretAccessKeyHint: null,
								forcePathStyle: true,
							},
						},
					},
				}),
			}),
		]),
	)
	return {
		service,
		puts: () => puts,
		fail: (mode: typeof failure) => {
			failure = mode
		},
	}
}
const seed = Effect.gen(function* () {
	const db = yield* Db.make
	yield* db
		.insert(organizations)
		.values({
			id: caller.organizationId,
			name: "Exports",
			status: "active",
			createdAt: 0,
		})
		.onConflictDoNothing()
})
layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"concurrent saves share one file and keep its Chat reference after temporary storage is gone",
		() =>
			Effect.gen(function* () {
				yield* seed
				const f = fixture()
				yield* Effect.gen(function* () {
					const api = yield* Files.Files
					const owner = { ...caller, userId: "concurrent" }
					const input = { key: "durable-call", content, reference }
					const results = yield* Effect.all(
						[api.save(owner, input), api.save(owner, input)],
						{ concurrency: 2 },
					)
					assert.strictEqual(results[0].id, results[1].id)
					const db = yield* Db.make
					assert.strictEqual(
						(yield* db
							.select()
							.from(files)
							.where(eq(files.userId, owner.userId))).length,
						1,
					)
					assert.deepStrictEqual(
						yield* db
							.select()
							.from(fileRefs)
							.where(eq(fileRefs.file, results[0].id)),
						[{ file: results[0].id, ...reference }],
					)
					const downloaded = yield* api.content(owner, results[0].id)
					assert.strictEqual(
						yield* downloaded.pipe(Stream.decodeText, Stream.mkString),
						"result",
					)
					assert.strictEqual(
						(yield* api
							.get({ ...owner, userId: "other" }, results[0].id)
							.pipe(Effect.flip))._tag,
						"FileNotFound",
					)
				}).pipe(Effect.provide(f.service))
			}),
	)
	it.effect(
		"a lost upload reply is recovered after rebuilding the service without another upload",
		() =>
			Effect.gen(function* () {
				yield* seed
				const f = fixture()
				const owner = { ...caller, userId: "lost-reply" }
				f.fail("after")
				const first = yield* Effect.flatMap(Files.Files, (api) =>
					api.save(owner, { key: "lost", content, reference }),
				).pipe(Effect.provide(f.service))
				assert.strictEqual(first.status, "ready")
				// The durable state after PUT, if the process exits before the ready update.
				const db = yield* Db.make
				yield* db
					.update(files)
					.set({ status: "pending" })
					.where(eq(files.id, first.id))
				f.fail("none")
				yield* Effect.gen(function* () {
					const api = yield* Files.Files
					const recovered = yield* api.saved(owner, "lost")
					assert.ok(Option.isSome(recovered))
					assert.strictEqual(recovered.value.status, "ready")
					assert.strictEqual(f.puts(), 1)
					const again = yield* api.save(owner, {
						key: "lost",
						content: { ...content, bytes: new TextEncoder().encode("changed") },
						reference,
					})
					assert.strictEqual(again.id, recovered.value.id)
					assert.strictEqual(f.puts(), 1)
				}).pipe(Effect.provide(f.service))
			}),
	)
	it.effect(
		"a pending export cannot overwrite changed source bytes; retrying its original bytes is safe",
		() =>
			Effect.gen(function* () {
				yield* seed
				const f = fixture()
				const owner = { ...caller, userId: "changed-source" }
				yield* Effect.gen(function* () {
					const api = yield* Files.Files
					f.fail("before")
					yield* api
						.save(owner, { key: "pending", content, reference })
						.pipe(Effect.flip)
					f.fail("none")
					const changed = yield* api
						.save(owner, {
							key: "pending",
							content: {
								...content,
								bytes: new TextEncoder().encode("change"),
							},
							reference,
						})
						.pipe(Effect.flip)
					assert.strictEqual(changed._tag, "FileInvalid")
					assert.strictEqual(f.puts(), 1)
					const ready = yield* api.save(owner, {
						key: "pending",
						content,
						reference,
					})
					assert.strictEqual(ready.status, "ready")
					assert.strictEqual(f.puts(), 2)
				}).pipe(Effect.provide(f.service))
			}),
	)
	it.effect(
		"PPT exports infer their Office type and still use the configured allowlist",
		() =>
			Effect.gen(function* () {
				yield* seed
				const f = fixture()
				yield* Effect.gen(function* () {
					const api = yield* Files.Files
					const pptx = yield* api.save(
						{ ...caller, userId: "pptx" },
						{
							key: "slides",
							content: {
								...content,
								fileName: "slides.pptx",
								mediaType: "application/octet-stream",
							},
							reference,
						},
					)
					assert.strictEqual(
						pptx.mediaType,
						"application/vnd.openxmlformats-officedocument.presentationml.presentation",
					)
					const docx = yield* api
						.save(
							{ ...caller, userId: "docx" },
							{
								key: "document",
								content: {
									...content,
									fileName: "document.docx",
									mediaType: "application/octet-stream",
								},
								reference,
							},
						)
						.pipe(Effect.flip)
					assert.strictEqual(docx._tag, "FileInvalid")
					assert.strictEqual(f.puts(), 1)
				}).pipe(Effect.provide(f.service))
			}),
	)

	it.effect(
		"generated files obey size, media type and atomic member quota limits",
		() =>
			Effect.gen(function* () {
				yield* seed
				const f = fixture()
				const owner = { ...caller, userId: "quota" }
				yield* Effect.gen(function* () {
					const api = yield* Files.Files
					assert.strictEqual(
						(yield* api
							.save(owner, {
								key: "type",
								content: {
									...content,
									mediaType: "application/octet-stream",
									fileName: "out.bin",
								},
								reference,
							})
							.pipe(Effect.flip))._tag,
						"FileInvalid",
					)
					assert.strictEqual(
						(yield* api
							.save(owner, {
								key: "large",
								content: { ...content, bytes: new Uint8Array(13) },
								reference,
							})
							.pipe(Effect.flip))._tag,
						"FileInvalid",
					)
					yield* api.save(owner, { key: "one", content, reference })
					yield* api.save(owner, { key: "two", content, reference })
					assert.strictEqual(
						(yield* api
							.save(owner, { key: "three", content, reference })
							.pipe(Effect.flip))._tag,
						"FileQuotaExceeded",
					)
					assert.strictEqual(f.puts(), 2)
				}).pipe(Effect.provide(f.service))
			}),
	)
})
