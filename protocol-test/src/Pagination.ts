import { Effect, Match, Option, Predicate, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import {
	Headers,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"

const Request = Schema.Struct({
	id: Schema.Union([Schema.String, Schema.Finite]),
	method: Schema.String,
	params: Schema.optional(Schema.JsonObject),
})
const Json = Schema.fromJsonString(Schema.JsonObject)
const fields: Readonly<Record<string, string>> = {
	"resources/list": "resources",
	"tools/list": "tools",
	"prompts/list": "prompts",
	"resources/templates/list": "resourceTemplates",
}

/** Native registration returns full lists. This service splits them into small wire pages. */
export const middleware = HttpRouter.middleware(
	Effect.succeed((http) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			if (request.method !== "POST") return yield* http
			const parsed = yield* request.text.pipe(
				Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Request))),
				Effect.option,
			)
			const operation = Option.getOrUndefined(parsed)
			if (operation === undefined) return yield* http
			const field = fields[operation.method]
			if (field === undefined) return yield* http
			const cursor = operation.params?.["cursor"]
			const prefix = "protocol-test:" + operation.method + ":"
			const offset =
				typeof cursor === "string" &&
				cursor.startsWith(prefix) &&
				/^\d+$/.test(cursor.slice(prefix.length))
					? Number(cursor.slice(prefix.length))
					: cursor === undefined
						? 0
						: -1
			if (!Number.isSafeInteger(offset) || offset < 0)
				return HttpServerResponse.jsonUnsafe({
					jsonrpc: "2.0",
					id: operation.id,
					error: { code: -32602, message: "Invalid pagination cursor." },
				})
			const response = yield* http
			if (response.status !== 200) return response
			const transform = (data: string) =>
				Effect.gen(function* () {
					const value = yield* Schema.decodeEffect(Json)(data)
					const rawResult = value["result"]
					if (!Schema.is(Schema.JsonObject)(rawResult)) return data
					const result = yield* Schema.decodeEffect(Schema.JsonObject)(
						rawResult,
					)
					const entries = result[field]
					if (!Array.isArray(entries)) return data
					const page = entries.slice(offset, offset + 20)
					return JSON.stringify({
						...value,
						result: {
							...result,
							[field]: page,
							...(offset + 20 < entries.length
								? { nextCursor: prefix + (offset + 20) }
								: {}),
						},
					})
				})
			const bytes = Match.value(response.body).pipe(
				Match.tag("Uint8Array", (body) => Stream.succeed(body.body)),
				Match.tag("Stream", (body) => body.stream),
				Match.orElse(() => Stream.empty),
			)
			const text = bytes.pipe(Stream.decodeText())
			const body = (response.headers["content-type"] ?? "").startsWith(
				"text/event-stream",
			)
				? text.pipe(
						Stream.pipeThroughChannel(Sse.decode()),
						Stream.mapEffect((event) =>
							transform(event.data).pipe(
								Effect.map((data) => ({ ...event, data })),
							),
						),
						Stream.pipeThroughChannel(Sse.encode()),
					)
				: text.pipe(
						Stream.splitLines,
						Stream.filter(Predicate.isTruthy),
						Stream.mapEffect(transform),
						Stream.map((line) => line + "\n"),
					)
			return HttpServerResponse.stream(Stream.encodeText(body), {
				status: response.status,
				headers: Headers.remove(response.headers, "content-length"),
				cookies: response.cookies,
			})
		}),
	),
)
