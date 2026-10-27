import { assert, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { Effect, Option, Redacted, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import * as S3 from "../src/files/S3.ts"

// The example from the AWS guide "Authenticating Requests: Using Query
// Parameters (AWS Signature Version 4)".
it.effect("presign makes the signature of the AWS example", () =>
	Effect.gen(function* () {
		const url = yield* S3.presign({
			target: {
				endpoint: "https://s3.amazonaws.com",
				region: "us-east-1",
				bucket: "examplebucket",
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: Redacted.make(
					"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				),
				forcePathStyle: false,
			},
			method: "GET",
			key: "test.txt",
			expiresSeconds: 86400,
			now: Date.UTC(2013, 4, 24),
		})
		assert.strictEqual(
			new URL(url).searchParams.get("X-Amz-Signature"),
			"aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
		)
	}).pipe(Effect.provide(NodeCrypto.layer)),
)

const target: S3.Target = {
	endpoint: "https://storage.example.com",
	region: "us-east-1",
	bucket: "files",
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: Redacted.make("example-secret"),
	forcePathStyle: true,
}

/** A client that gives the same answer to each request. */
const answering = (body: string, status: number) =>
	HttpClient.make((request) =>
		Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new globalThis.Response(body, { status }),
			),
		),
	)

const s3Error = (code: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>The storage says no.</Message></Error>`

it.effect(
	"a refused request names the S3 error code, but not the rest of the body",
	() =>
		Effect.gen(function* () {
			const denied = yield* S3.put(
				answering(s3Error("AccessDenied"), 403),
				target,
				"files/a",
				{ bytes: new TextEncoder().encode("a"), contentType: "text/plain" },
				0,
			).pipe(Effect.flip)
			assert.strictEqual(
				denied.message,
				"The object storage could not store the file: status 403 (AccessDenied)",
			)
			// An answer without an S3 error body gives only the status.
			const failed = yield* S3.remove(
				answering("", 500),
				target,
				"files/a",
				0,
			).pipe(Effect.flip)
			assert.strictEqual(
				failed.message,
				"The object storage could not delete the file: status 500",
			)
		}).pipe(Effect.provide(NodeCrypto.layer)),
)

it.effect(
	"a failed connection keeps the error of the HTTP client as the cause",
	() =>
		Effect.gen(function* () {
			const refused = new Error("connect ECONNREFUSED 127.0.0.1:9000")
			const client = HttpClient.make((request) =>
				Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({
							request,
							cause: refused,
						}),
					}),
				),
			)
			const error = yield* S3.get(client, target, "files/a", 0).pipe(
				Effect.flip,
			)
			assert.match(
				error.message,
				/^The object storage could not read the file: /,
			)
			assert.ok(HttpClientError.isHttpClientError(error.cause))
			assert.strictEqual(error.cause.cause, refused)
		}).pipe(Effect.provide(NodeCrypto.layer)),
)

it.effect(
	"getStream gives the bytes of an object as a stream, and none when it is not there",
	() =>
		Effect.gen(function* () {
			const found = yield* S3.getStream(
				answering("hello", 200),
				target,
				"files/a",
				0,
			)
			assert.ok(Option.isSome(found))
			assert.strictEqual(
				yield* found.value.pipe(Stream.decodeText, Stream.mkString),
				"hello",
			)
			const missing = yield* S3.getStream(
				answering(s3Error("NoSuchKey"), 404),
				target,
				"files/b",
				0,
			)
			assert.ok(Option.isNone(missing))
			const denied = yield* S3.getStream(
				answering(s3Error("AccessDenied"), 403),
				target,
				"files/c",
				0,
			).pipe(Effect.flip)
			assert.strictEqual(
				denied.message,
				"The object storage could not read the file: status 403 (AccessDenied)",
			)
		}).pipe(Effect.provide(NodeCrypto.layer)),
)
