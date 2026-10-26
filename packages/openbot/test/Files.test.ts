import { assert, layer } from "@effect/vitest"
import { FilesApi, MessageReceipt, UserTokensApi } from "@openbot-build/api"
import { eq } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	HashMap,
	Option,
	pipe,
	Redacted,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt } from "effect/ai"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as Db from "../src/database/Database.ts"
import { fileRefs, files } from "../src/database/Schema.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { settled, type Send } from "./Messages.ts"

const publicOrigin = "https://files.example.com"
const storageOrigin = "http://s3.test"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** A condition of the test did not come true in time. */
class TimedOut extends Schema.TaggedError<
	TimedOut,
	{ readonly brand: unique symbol }
>()("TimedOut", { label: Schema.String }) {
	override get message() {
		return "The condition did not come true in time: " + this.label
	}
}

const Versioned = Schema.Struct({ version: Schema.Finite })

/** The answer of the server when a member has no space left. */
const QuotaExceeded = Schema.Struct({
	_tag: Schema.String,
	quotaBytes: Schema.Finite,
	usedBytes: Schema.Finite,
})

/** An object storage in memory. It only checks that each request is signed. */
const fakeStorage = Effect.gen(function* () {
	const objects = yield* Ref.make(
		HashMap.empty<
			string,
			{ readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }
		>(),
	)
	const handle = Effect.fn("Files.storage")(function* (request: Request) {
		const url = new URL(request.url)
		const signed =
			request.headers.has("authorization") ||
			url.searchParams.has("X-Amz-Signature")
		if (!signed) return new Response("unsigned", { status: 403 })
		const key = url.pathname
		switch (request.method) {
			case "PUT": {
				const bytes = new Uint8Array(
					yield* Effect.promise(() => request.arrayBuffer()),
				)
				const length = request.headers.get("content-length")
				if (length !== null && Number(length) !== bytes.length)
					return new Response("bad length", { status: 400 })
				yield* Ref.update(objects, (current) =>
					HashMap.set(current, key, {
						bytes,
						type: request.headers.get("content-type") ?? "",
					}),
				)
				return new Response(null, { status: 200 })
			}
			case "GET":
			case "HEAD": {
				const found = HashMap.get(yield* Ref.get(objects), key)
				if (Option.isNone(found)) return new Response(null, { status: 404 })
				return new Response(
					request.method === "HEAD" ? null : new Blob([found.value.bytes]),
					{
						headers: {
							"content-length": String(found.value.bytes.length),
							"content-type": found.value.type,
						},
					},
				)
			}
			case "DELETE":
				yield* Ref.update(objects, HashMap.remove(key))
				return new Response(null, { status: 204 })
		}
		return new Response(null, { status: 405 })
	})
	return {
		/** Whether the storage keeps an object at this path. */
		has: (key: string) => Effect.map(Ref.get(objects), HashMap.has(key)),
		fetch: handle,
	}
})

/** The files in the user messages of a prompt. */
const userFiles = (prompt: Prompt.Prompt) =>
	pipe(
		prompt.content,
		Arr.flatMap((message) => (message.role === "user" ? message.content : [])),
		Arr.filter((part): part is Prompt.FilePart => part.type === "file"),
	)

/** A model that writes down the files that it sees. */
const recordingModel = Effect.gen(function* () {
	const seen = yield* Ref.make<ReadonlyArray<Prompt.FilePart>>([])
	const model = yield* LanguageModel.make({
		generateText: () => Effect.succeed([]),
		streamText: ({ prompt }) =>
			Stream.unwrap(
				Ref.update(seen, Arr.appendAll(userFiles(prompt))).pipe(
					Effect.as(
						Stream.make(
							{ type: "text-start", id: "a" } as const,
							{ type: "text-delta", id: "a", delta: "Seen." } as const,
							{ type: "text-end", id: "a" } as const,
							{
								type: "finish",
								reason: "stop",
								usage,
								response: undefined,
							} as const,
						),
					),
				),
			),
	})
	return { seen: Ref.get(seen), model }
})

/** Runs a check again until it is true, at most 100 times, 100 milliseconds apart. */
const until = <E, R>(label: string, check: Effect.Effect<boolean, E, R>) =>
	check.pipe(
		Effect.repeat({
			until: (done) => done,
			schedule: Schedule.spaced("100 millis"),
			times: 99,
		}),
		Effect.flatMap((done) =>
			done ? Effect.void : Effect.fail(TimedOut.make({ label })),
		),
	)

const form = (name: string, type: string, text: string) => {
	const body = new FormData()
	body.append("purpose", "user_data")
	body.append("file", new Blob([text], { type }), name)
	return body
}

/** Uploads a file through the server, with a session cookie or a user token. */
const upload = (
	address: string,
	credential: { readonly cookie?: string; readonly token?: string },
	body: FormData,
) =>
	HttpClientRequest.post(address + "/v1/files", {
		headers: {
			origin: publicOrigin,
			...(credential.cookie === undefined ? {} : { cookie: credential.cookie }),
			...(credential.token === undefined
				? {}
				: { authorization: "Bearer " + credential.token }),
		},
	}).pipe(HttpClientRequest.bodyFormData(body), HttpClient.execute)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"files upload to S3, go to the model, and go away when nothing uses them",
		() =>
			Effect.gen(function* () {
				const storage = yield* fakeStorage
				const { seen, model } = yield* recordingModel
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformAdmins: ["root@example.com"],
					platformFetch: storage.fetch,
					model,
					fileIntervalMs: 100,
				})
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const root = yield* host.login("root")
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const asAlice: Send = (path, method, payload) =>
					call(alice.session, path, method, payload)

				// Without storage, nobody can upload.
				const early = yield* upload(
					address,
					{ cookie: Caller.sessionCookie(alice.session) },
					form("a.txt", "text/plain", "hi"),
				)
				assert.strictEqual(early.status, 409, yield* early.text)

				/** Changes the file settings, and gives the answer as text. */
				const patch = (files: unknown) =>
					Effect.gen(function* () {
						const current = yield* Effect.flatMap(
							call(root.session, "/v1/platform/settings"),
							Caller.json(Versioned),
						)
						const response = yield* call(
							root.session,
							"/v1/platform/settings",
							"PATCH",
							{ expectedVersion: current.version, files },
						)
						const body = yield* response.text
						assert.strictEqual(response.status, 200, body)
						return body
					})
				const updated = yield* patch({
					storage: {
						endpoint: storageOrigin,
						publicEndpoint: null,
						region: "us-east-1",
						bucket: "openbot",
						accessKeyId: "test-access-key",
						secretAccessKey: "test-secret-access-key",
						forcePathStyle: true,
					},
				})
				// The secret never comes back.
				assert.strictEqual(Str.includes("test-secret")(updated), false)

				// Through the server, with the session cookie.
				const image = yield* Effect.flatMap(
					upload(
						address,
						{ cookie: Caller.sessionCookie(alice.session) },
						form("dot.png", "image/png", "PNGDATA"),
					),
					Caller.json(FilesApi.FileObject, 201),
				)
				assert.strictEqual(image.status, "ready")
				assert.strictEqual(image.bytes, 7)
				assert.ok(yield* storage.has(`/openbot/files/${image.id}`))

				// Through the server, with a user token.
				const { secret } = yield* Effect.flatMap(
					call(alice.session, "/v1/user/tokens", "POST", { name: "files" }),
					Caller.json(UserTokensApi.CreatedToken),
				)
				const noteFile = yield* Effect.flatMap(
					upload(
						address,
						{ token: secret },
						form("note.txt", "text/plain", "a note"),
					),
					Caller.json(FilesApi.FileObject, 201),
				)
				const keyed = Caller.withToken(address)
				assert.strictEqual(
					(yield* keyed(secret, `/v1/files/${noteFile.id}`)).status,
					200,
				)

				// A type that the platform does not take.
				const zip = yield* upload(
					address,
					{ cookie: Caller.sessionCookie(alice.session) },
					form("a.zip", "application/zip", "zip"),
				)
				assert.strictEqual(zip.status, 400)

				// A file name that ends like a key of every JavaScript object, with
				// no type, still gets the default type.
				const odd = yield* upload(
					address,
					{ cookie: Caller.sessionCookie(alice.session) },
					form("a.constructor", "", "odd"),
				)
				const oddBody = yield* odd.text
				assert.strictEqual(odd.status, 400, oddBody)
				assert.ok(
					Str.includes("files of type application/octet-stream")(oddBody),
					oddBody,
				)

				// Directly to storage at a signed address, then complete.
				const direct = yield* Effect.flatMap(
					asAlice("/v1/files/uploads", "POST", {
						filename: "direct.txt",
						mediaType: "text/plain",
						bytes: 6,
					}),
					Caller.json(FilesApi.DirectUpload),
				)
				assert.strictEqual(direct.file.status, "pending")
				assert.ok(Str.startsWith(storageOrigin + "/openbot/files/")(direct.url))
				const put = yield* storage.fetch(
					new Request(direct.url, {
						method: "PUT",
						headers: direct.headers,
						body: "direct",
					}),
				)
				assert.strictEqual(put.status, 200)
				const completed = yield* Effect.flatMap(
					asAlice(`/v1/files/${direct.file.id}/complete`, "POST"),
					Caller.json(FilesApi.FileObject, 200),
				)
				assert.strictEqual(completed.status, "ready")
				const content = yield* asAlice(
					`/v1/files/${direct.file.id}/content`,
					"GET",
				)
				assert.strictEqual(yield* content.text, "direct")

				// Completing before the bytes arrive does not work.
				const early2 = yield* Effect.flatMap(
					asAlice("/v1/files/uploads", "POST", {
						filename: "later.txt",
						mediaType: "text/plain",
						bytes: 5,
					}),
					Caller.json(FilesApi.DirectUpload),
				)
				assert.strictEqual(
					(yield* asAlice(`/v1/files/${early2.file.id}/complete`, "POST"))
						.status,
					400,
				)

				// Other people cannot see the file.
				assert.strictEqual(
					(yield* call(bob.session, `/v1/files/${image.id}`, "GET")).status,
					404,
				)

				// The file goes to the model as bytes, and the Chat names it.
				const bot = yield* host.defaultBot(alice.session)
				const receipt = yield* Effect.flatMap(
					asAlice(`/v1/bots/${bot}/messages`, "POST", {
						input: [
							{
								role: "user",
								content: [
									{ type: "input_text", text: "What is in the picture?" },
									{ type: "input_image", file_id: image.id },
								],
							},
						],
					}),
					Caller.json(MessageReceipt, 202),
				)
				yield* settled(asAlice, receipt.chat)
				const part = Arr.last(yield* seen)
				assert.ok(Option.isSome(part))
				assert.strictEqual(part.value.mediaType, "image/png")
				assert.ok(part.value.data instanceof Uint8Array)
				assert.strictEqual(new TextDecoder().decode(part.value.data), "PNGDATA")

				// A text file is not an image, and a file of another person is not yours.
				const wrong = yield* asAlice(`/v1/bots/${bot}/messages`, "POST", {
					input: [
						{
							role: "user",
							content: [{ type: "input_image", file_id: noteFile.id }],
						},
					],
				})
				assert.strictEqual(wrong.status, 400)

				const refs = yield* host.run(
					Effect.flatMap(Db.make, (db) =>
						db.select().from(fileRefs).where(eq(fileRefs.file, image.id)),
					),
				)
				assert.strictEqual(refs.length, 1)

				// Make every file look old. The garbage collector then takes the
				// files that no Chat uses, and the pending files.
				const age = host.run(
					Effect.flatMap(Db.make, (db) =>
						db.update(files).set({ updatedAt: 0 }),
					),
				)
				yield* age
				const rows = host.run(
					Effect.flatMap(Db.make, (db) =>
						db.select({ id: files.id }).from(files),
					),
				)
				const unused = [noteFile.id, direct.file.id, early2.file.id]
				// The garbage collector takes the bytes first and the row after
				// them, so the test waits for both.
				yield* until(
					"the files that nothing uses go away",
					Effect.map(
						Effect.all([
							storage.has(`/openbot/files/${noteFile.id}`),
							storage.has(`/openbot/files/${direct.file.id}`),
							rows,
						]),
						([note, pending, current]) =>
							!note &&
							!pending &&
							!Arr.some(current, (row) => Arr.contains(unused, row.id)),
					),
				)
				const left = yield* rows
				assert.deepStrictEqual(
					Arr.map(left, (row) => row.id),
					[image.id],
				)
				assert.ok(yield* storage.has(`/openbot/files/${image.id}`))

				// When the Chat is deleted, nothing uses the picture any more.
				assert.strictEqual(
					(yield* asAlice(`/v1/chats/${receipt.chat}`, "DELETE")).status,
					204,
				)
				yield* age
				yield* until(
					"the picture goes away",
					Effect.map(
						storage.has(`/openbot/files/${image.id}`),
						(found) => !found,
					),
				)
				assert.strictEqual(
					(yield* asAlice(`/v1/files/${image.id}`, "GET")).status,
					404,
				)

				// A person can delete a file at once.
				const goneFile = yield* Effect.flatMap(
					upload(
						address,
						{ cookie: Caller.sessionCookie(alice.session) },
						form("gone.txt", "text/plain", "bye"),
					),
					Caller.json(FilesApi.FileObject),
				)
				assert.strictEqual(
					(yield* asAlice(`/v1/files/${goneFile.id}`, "DELETE")).status,
					204,
				)
				assert.strictEqual(
					(yield* asAlice(`/v1/files/${goneFile.id}`, "GET")).status,
					404,
				)
				yield* until(
					"the deleted file goes away",
					Effect.map(
						storage.has(`/openbot/files/${goneFile.id}`),
						(found) => !found,
					),
				)

				// An admin can turn the upload through the server off.
				yield* patch({ uploads: { server: false, direct: true } })
				const off = yield* upload(
					address,
					{ cookie: Caller.sessionCookie(alice.session) },
					form("off.txt", "text/plain", "off"),
				)
				assert.strictEqual(off.status, 409)
			}),
	)

	it.effect(
		"each member keeps files only up to the quota, and no file is larger than the limit",
		() =>
			Effect.gen(function* () {
				const storage = yield* fakeStorage
				const { model } = yield* recordingModel
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformAdmins: ["root@example.com"],
					platformFetch: storage.fetch,
					model,
				})
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const root = yield* host.login("root")
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")
				const send = (session: Redacted.Redacted<string>, text: string) =>
					upload(
						address,
						{ cookie: Caller.sessionCookie(session) },
						form("a.txt", "text/plain", text),
					)
				const direct = (session: Redacted.Redacted<string>, bytes: number) =>
					call(session, "/v1/files/uploads", "POST", {
						filename: "b.txt",
						mediaType: "text/plain",
						bytes,
					})
				const patch = (files: unknown) =>
					Effect.gen(function* () {
						const current = yield* Effect.flatMap(
							call(root.session, "/v1/platform/settings"),
							Caller.json(Versioned),
						)
						return yield* Effect.flatMap(
							call(root.session, "/v1/platform/settings", "PATCH", {
								expectedVersion: current.version,
								files,
							}),
							Caller.json(
								Schema.Struct({
									files: Schema.Struct({
										quotaBytes: Schema.NullOr(Schema.Finite),
									}),
								}),
								200,
							),
						)
					})

				// Before an admin sets a quota, there is none.
				const first = yield* patch({
					storage: {
						endpoint: storageOrigin,
						publicEndpoint: null,
						region: "us-east-1",
						bucket: "openbot",
						accessKeyId: "test-access-key",
						secretAccessKey: "test-secret-access-key",
						forcePathStyle: true,
					},
				})
				assert.strictEqual(first.files.quotaBytes, null)
				const set = yield* patch({ maxBytes: 8, quotaBytes: 10 })
				assert.strictEqual(set.files.quotaBytes, 10)

				// A file larger than the limit does not go in, by either way.
				assert.strictEqual(
					(yield* send(alice.session, "123456789")).status,
					400,
				)
				assert.strictEqual((yield* direct(alice.session, 9)).status, 400)

				// Ready and pending files both use the quota.
				const keptFile = yield* Effect.flatMap(
					send(alice.session, "123456"),
					Caller.json(FilesApi.FileObject, 201),
				)
				yield* Effect.flatMap(
					direct(alice.session, 3),
					Caller.json(FilesApi.DirectUpload, 201),
				)

				const error = yield* Effect.flatMap(
					send(alice.session, "12"),
					Caller.json(QuotaExceeded, 413),
				)
				assert.strictEqual(error._tag, "FileQuotaExceeded")
				assert.strictEqual(error.quotaBytes, 10)
				assert.strictEqual(error.usedBytes, 9)
				assert.strictEqual((yield* direct(alice.session, 2)).status, 413)
				// The last byte still fits.
				assert.strictEqual((yield* send(alice.session, "1")).status, 201)

				// The quota is for each member, so Bob has a separate space.
				assert.strictEqual((yield* send(bob.session, "12345678")).status, 201)

				// Deleting a file gives its space back at once.
				assert.strictEqual(
					(yield* call(alice.session, `/v1/files/${keptFile.id}`, "DELETE"))
						.status,
					204,
				)
				assert.strictEqual((yield* send(alice.session, "123456")).status, 201)

				// Uploads at the same time cannot both take the last space.
				const carol = yield* host.login("carol")
				const statuses = yield* Effect.all(
					Arr.replicate(
						Effect.map(direct(carol.session, 3), (response) => response.status),
						5,
					),
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(
					Arr.countBy(statuses, (status) => status === 201),
					3,
				)
				assert.strictEqual(
					Arr.countBy(statuses, (status) => status === 413),
					2,
				)

				// Null takes the quota away.
				yield* patch({ quotaBytes: null })
				assert.strictEqual((yield* send(alice.session, "12345678")).status, 201)

				// With a wildcard in the list, an odd file name with no type is
				// still a file of the wrong type, not a server error.
				yield* patch({ mediaTypes: ["image/*"] })
				const odd = yield* upload(
					address,
					{ cookie: Caller.sessionCookie(alice.session) },
					form("a.__proto__", "", "odd"),
				)
				assert.strictEqual(odd.status, 400, yield* odd.text)
			}),
	)
})
