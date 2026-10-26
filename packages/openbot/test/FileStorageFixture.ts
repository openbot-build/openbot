import { Effect, HashMap, Option, Ref } from "effect"

export const origin = "http://s3.test"

/** In-memory object storage for host tests. Requests still need an S3 signature. */
export const make = Effect.gen(function* () {
	const objects = yield* Ref.make(
		HashMap.empty<
			string,
			{ readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }
		>(),
	)
	const handle = Effect.fn("Files.storage")(function* (request: Request) {
		const url = new URL(request.url)
		if (
			!request.headers.has("authorization") &&
			!url.searchParams.has("X-Amz-Signature")
		)
			return new Response("unsigned", { status: 403 })
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
		has: (key: string) => Effect.map(Ref.get(objects), HashMap.has(key)),
		fetch: handle,
	}
})
