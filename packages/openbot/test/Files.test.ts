import { assert, it } from "@effect/vitest"
import { MessageReceipt } from "@openbot-build/api"
import type { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import * as Db from "../src/database/Database.ts"
import { fileRefs, files } from "../src/database/Schema.ts"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"
import { settled, type Send } from "./Messages.ts"

const publicOrigin = "https://files.example.com"
const storageOrigin = "http://s3.test"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** An object storage in memory. It only checks that each request is signed. */
const fakeStorage = () => {
	const objects = new Map<
		string,
		{ readonly bytes: Uint8Array; readonly type: string }
	>()
	const handle = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		const signed =
			request.headers.has("authorization") ||
			url.searchParams.has("X-Amz-Signature")
		if (!signed) return new Response("unsigned", { status: 403 })
		const key = url.pathname
		switch (request.method) {
			case "PUT": {
				const bytes = new Uint8Array(await request.arrayBuffer())
				const length = request.headers.get("content-length")
				if (length !== null && Number(length) !== bytes.length)
					return new Response("bad length", { status: 400 })
				objects.set(key, {
					bytes,
					type: request.headers.get("content-type") ?? "",
				})
				return new Response(null, { status: 200 })
			}
			case "GET":
			case "HEAD": {
				const found = objects.get(key)
				if (found === undefined) return new Response(null, { status: 404 })
				return new Response(
					request.method === "HEAD"
						? null
						: new Blob([found.bytes as Uint8Array<ArrayBuffer>]),
					{
						headers: {
							"content-length": String(found.bytes.length),
							"content-type": found.type,
						},
					},
				)
			}
			case "DELETE":
				objects.delete(key)
				return new Response(null, { status: 204 })
		}
		return new Response(null, { status: 405 })
	}
	return { objects, fetch: handle }
}

/** A model that writes down the files that it sees. */
const recordingModel = () => {
	const seen: Array<Prompt.FilePart> = []
	const model = Effect.runSync(
		LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: ({ prompt }) =>
				Stream.suspend(() => {
					for (const message of prompt.content)
						if (message.role === "user")
							for (const part of message.content)
								if (part.type === "file") seen.push(part)
					return Stream.make(
						{ type: "text-start", id: "a" } as const,
						{ type: "text-delta", id: "a", delta: "Seen." } as const,
						{ type: "text-end", id: "a" } as const,
						{
							type: "finish",
							reason: "stop",
							usage,
							response: undefined,
						} as const,
					)
				}),
		}),
	)
	return { seen, model }
}

const until = async (check: () => boolean | Promise<boolean>) => {
	for (let index = 0; index < 100; index++) {
		if (await check()) return
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error("The condition did not come true in time")
}

const form = (name: string, type: string, text: string) => {
	const body = new FormData()
	body.append("purpose", "user_data")
	body.append("file", new Blob([text], { type }), name)
	return body
}

it("files upload to S3, go to the model, and go away when nothing uses them", async () => {
	const storage = fakeStorage()
	const { seen, model } = recordingModel()
	const host = await BrowserHost.start({
		publicOrigin,
		platformAdmins: ["root@example.com"],
		platformFetch: (input, init) => storage.fetch(input, init),
		model,
		fileIntervalMs: 100,
	})
	try {
		const call = withCookie({ address: host.address, publicOrigin })
		const root = await host.login("root")
		const alice = await host.login("alice")
		const bob = await host.login("bob")
		const asAlice: Send = (path, method, payload) =>
			call(alice.session, path, method, payload)
		const upload = (
			credential: { readonly cookie?: string; readonly token?: string },
			body: FormData,
		) =>
			fetch(host.address + "/v1/files", {
				method: "POST",
				headers: {
					origin: publicOrigin,
					...(credential.cookie === undefined
						? {}
						: { cookie: credential.cookie }),
					...(credential.token === undefined
						? {}
						: { authorization: "Bearer " + credential.token }),
				},
				body,
			})
		const cookie = (session: Redacted.Redacted<string>) =>
			"__Host-openbot-session=" + encodeURIComponent(Redacted.value(session))

		// Without storage, nobody can upload.
		const early = await upload(
			{ cookie: cookie(alice.session) },
			form("a.txt", "text/plain", "hi"),
		)
		assert.strictEqual(early.status, 409, await early.text())

		const settingsOf = async () =>
			(await (await call(root.session, "/v1/platform/settings")).json()) as {
				readonly version: number
			}
		const patch = async (files: unknown) => {
			const response = await call(
				root.session,
				"/v1/platform/settings",
				"PATCH",
				{ expectedVersion: (await settingsOf()).version, files },
			)
			assert.strictEqual(response.status, 200, await response.clone().text())
			return (await response.json()) as {
				readonly files: { readonly storage: unknown }
			}
		}
		const updated = await patch({
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
		assert.strictEqual(JSON.stringify(updated).includes("test-secret"), false)

		// Through the server, with the session cookie.
		const picture = await upload(
			{ cookie: cookie(alice.session) },
			form("dot.png", "image/png", "PNGDATA"),
		)
		assert.strictEqual(picture.status, 201, await picture.clone().text())
		const image = (await picture.json()) as {
			readonly id: string
			readonly status: string
			readonly bytes: number
		}
		assert.strictEqual(image.status, "ready")
		assert.strictEqual(image.bytes, 7)
		assert.ok(storage.objects.has(`/openbot/files/${image.id}`))

		// Through the server, with a user token.
		const created = await call(alice.session, "/v1/user/tokens", "POST", {
			name: "files",
		})
		const { secret } = (await created.json()) as { readonly secret: string }
		const note = await upload(
			{ token: secret },
			form("note.txt", "text/plain", "a note"),
		)
		assert.strictEqual(note.status, 201, await note.clone().text())
		const noteFile = (await note.json()) as { readonly id: string }
		const keyed = withToken(host.address)
		assert.strictEqual(
			(await keyed(secret, `/v1/files/${noteFile.id}`)).status,
			200,
		)

		// A type that the platform does not take.
		const zip = await upload(
			{ cookie: cookie(alice.session) },
			form("a.zip", "application/zip", "zip"),
		)
		assert.strictEqual(zip.status, 400)

		// Directly to storage at a signed address, then complete.
		const direct = (await (
			await asAlice("/v1/files/uploads", "POST", {
				filename: "direct.txt",
				mediaType: "text/plain",
				bytes: 6,
			})
		).json()) as {
			readonly file: { readonly id: string; readonly status: string }
			readonly url: string
			readonly headers: Record<string, string>
		}
		assert.strictEqual(direct.file.status, "pending")
		assert.ok(direct.url.startsWith(storageOrigin + "/openbot/files/"))
		const put = await storage.fetch(direct.url, {
			method: "PUT",
			headers: direct.headers,
			body: "direct",
		})
		assert.strictEqual(put.status, 200)
		const completed = await asAlice(
			`/v1/files/${direct.file.id}/complete`,
			"POST",
		)
		assert.strictEqual(completed.status, 200, await completed.clone().text())
		assert.strictEqual(
			((await completed.json()) as { readonly status: string }).status,
			"ready",
		)
		const content = await asAlice(`/v1/files/${direct.file.id}/content`, "GET")
		assert.strictEqual(await content.text(), "direct")

		// Completing before the bytes arrive does not work.
		const early2 = (await (
			await asAlice("/v1/files/uploads", "POST", {
				filename: "later.txt",
				mediaType: "text/plain",
				bytes: 5,
			})
		).json()) as { readonly file: { readonly id: string } }
		assert.strictEqual(
			(await asAlice(`/v1/files/${early2.file.id}/complete`, "POST")).status,
			400,
		)

		// Other people cannot see the file.
		assert.strictEqual(
			(await call(bob.session, `/v1/files/${image.id}`, "GET")).status,
			404,
		)

		// The file goes to the model as bytes, and the Chat names it.
		const bot = await host.defaultBot(alice.session)
		const sent = await asAlice(`/v1/bots/${bot}/messages`, "POST", {
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "What is in the picture?" },
						{ type: "input_image", file_id: image.id },
					],
				},
			],
		})
		assert.strictEqual(sent.status, 202, await sent.clone().text())
		const receipt = Schema.decodeUnknownSync(MessageReceipt)(await sent.json())
		await settled(asAlice, receipt.chat)
		const part = seen.at(-1)
		assert.ok(part !== undefined)
		assert.strictEqual(part.mediaType, "image/png")
		assert.ok(part.data instanceof Uint8Array)
		assert.strictEqual(new TextDecoder().decode(part.data), "PNGDATA")

		// A text file is not an image, and a file of another person is not yours.
		const wrong = await asAlice(`/v1/bots/${bot}/messages`, "POST", {
			input: [
				{
					role: "user",
					content: [{ type: "input_image", file_id: noteFile.id }],
				},
			],
		})
		assert.strictEqual(wrong.status, 400)

		const db = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) =>
			host.runtime.runPromise(effect)
		const refs = (await db(
			Effect.flatMap(Db.make, (db) =>
				db.select().from(fileRefs).where(eq(fileRefs.file, image.id)),
			),
		)) as ReadonlyArray<unknown>
		assert.strictEqual(refs.length, 1)

		// Make every file look old. The garbage collector then takes the
		// files that no Chat uses, and the pending files.
		const age = () =>
			db(
				Effect.flatMap(Db.make, (db) => db.update(files).set({ updatedAt: 0 })),
			)
		await age()
		await until(
			() =>
				!storage.objects.has(`/openbot/files/${noteFile.id}`) &&
				!storage.objects.has(`/openbot/files/${direct.file.id}`),
		)
		const left = (await db(
			Effect.flatMap(Db.make, (db) => db.select({ id: files.id }).from(files)),
		)) as ReadonlyArray<{ readonly id: string }>
		assert.deepStrictEqual(
			left.map((row) => row.id),
			[image.id],
		)
		assert.ok(storage.objects.has(`/openbot/files/${image.id}`))

		// When the Chat is deleted, nothing uses the picture any more.
		assert.strictEqual(
			(await asAlice(`/v1/chats/${receipt.chat}`, "DELETE")).status,
			204,
		)
		await age()
		await until(() => !storage.objects.has(`/openbot/files/${image.id}`))
		assert.strictEqual(
			(await asAlice(`/v1/files/${image.id}`, "GET")).status,
			404,
		)

		// A person can delete a file at once.
		const gone = await upload(
			{ cookie: cookie(alice.session) },
			form("gone.txt", "text/plain", "bye"),
		)
		const goneFile = (await gone.json()) as { readonly id: string }
		assert.strictEqual(
			(await asAlice(`/v1/files/${goneFile.id}`, "DELETE")).status,
			204,
		)
		assert.strictEqual(
			(await asAlice(`/v1/files/${goneFile.id}`, "GET")).status,
			404,
		)
		await until(() => !storage.objects.has(`/openbot/files/${goneFile.id}`))

		// An admin can turn the upload through the server off.
		await patch({ uploads: { server: false, direct: true } })
		const off = await upload(
			{ cookie: cookie(alice.session) },
			form("off.txt", "text/plain", "off"),
		)
		assert.strictEqual(off.status, 409)
	} finally {
		await host.close()
	}
})

it("each member keeps files only up to the quota, and no file is larger than the limit", async () => {
	const storage = fakeStorage()
	const { model } = recordingModel()
	const host = await BrowserHost.start({
		publicOrigin,
		platformAdmins: ["root@example.com"],
		platformFetch: (input, init) => storage.fetch(input, init),
		model,
	})
	try {
		const call = withCookie({ address: host.address, publicOrigin })
		const root = await host.login("root")
		const alice = await host.login("alice")
		const bob = await host.login("bob")
		const upload = (session: Redacted.Redacted<string>, text: string) =>
			fetch(host.address + "/v1/files", {
				method: "POST",
				headers: {
					origin: publicOrigin,
					cookie:
						"__Host-openbot-session=" +
						encodeURIComponent(Redacted.value(session)),
				},
				body: form("a.txt", "text/plain", text),
			})
		const direct = (session: Redacted.Redacted<string>, bytes: number) =>
			call(session, "/v1/files/uploads", "POST", {
				filename: "b.txt",
				mediaType: "text/plain",
				bytes,
			})
		const patch = async (files: unknown) => {
			const current = (await (
				await call(root.session, "/v1/platform/settings")
			).json()) as { readonly version: number }
			const response = await call(
				root.session,
				"/v1/platform/settings",
				"PATCH",
				{ expectedVersion: current.version, files },
			)
			assert.strictEqual(response.status, 200, await response.clone().text())
			return (await response.json()) as {
				readonly files: { readonly quotaBytes: number | null }
			}
		}

		// Before an admin sets a quota, there is none.
		const first = await patch({
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
		const set = await patch({ maxBytes: 8, quotaBytes: 10 })
		assert.strictEqual(set.files.quotaBytes, 10)

		// A file larger than the limit does not go in, by either way.
		assert.strictEqual((await upload(alice.session, "123456789")).status, 400)
		assert.strictEqual((await direct(alice.session, 9)).status, 400)

		// Ready and pending files both use the quota.
		const kept = await upload(alice.session, "123456")
		assert.strictEqual(kept.status, 201, await kept.clone().text())
		const keptFile = (await kept.json()) as { readonly id: string }
		const pending = await direct(alice.session, 3)
		assert.strictEqual(pending.status, 201, await pending.clone().text())

		const over = await upload(alice.session, "12")
		assert.strictEqual(over.status, 413, await over.clone().text())
		const error = (await over.json()) as {
			readonly _tag: string
			readonly quotaBytes: number
			readonly usedBytes: number
		}
		assert.strictEqual(error._tag, "FileQuotaExceeded")
		assert.strictEqual(error.quotaBytes, 10)
		assert.strictEqual(error.usedBytes, 9)
		assert.strictEqual((await direct(alice.session, 2)).status, 413)
		// The last byte still fits.
		assert.strictEqual((await upload(alice.session, "1")).status, 201)

		// The quota is for each member, so Bob has a separate space.
		assert.strictEqual((await upload(bob.session, "12345678")).status, 201)

		// Deleting a file gives its space back at once.
		assert.strictEqual(
			(await call(alice.session, `/v1/files/${keptFile.id}`, "DELETE")).status,
			204,
		)
		assert.strictEqual((await upload(alice.session, "123456")).status, 201)

		// Uploads at the same time cannot both take the last space.
		const carol = await host.login("carol")
		const statuses = await Promise.all(
			Array.from({ length: 5 }, () =>
				direct(carol.session, 3).then((response) => response.status),
			),
		)
		assert.strictEqual(statuses.filter((status) => status === 201).length, 3)
		assert.strictEqual(statuses.filter((status) => status === 413).length, 2)

		// Null takes the quota away.
		await patch({ quotaBytes: null })
		assert.strictEqual((await upload(alice.session, "12345678")).status, 201)
	} finally {
		await host.close()
	}
})
