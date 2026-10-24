// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { Effect } from "effect"
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
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
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
