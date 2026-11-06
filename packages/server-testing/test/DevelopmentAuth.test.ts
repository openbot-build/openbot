import { ReturnTo } from "@openbot-build/domain/ReturnTo"
import { assert, it } from "@effect/vitest"
import { Effect, Redacted, Schema, String as Str } from "effect"
import * as AuthModel from "@openbot-build/server-kernel/AuthModel"
import * as Development from "@openbot-build/server-development/Development"

const authSecret = "DevelopmentIntegrationSecretMustStayStable123456"

it.effect(
	"the development sign-in secret comes from the first secret key and stays the same",
	() =>
		Effect.sync(() => {
			const keys = Redacted.make(
				"dev:" + Str.repeat(32)("11") + ",old:" + Str.repeat(32)("22"),
			)
			const first = Redacted.value(Development.developmentSecret(keys))
			assert.strictEqual(
				first,
				Redacted.value(Development.developmentSecret(keys)),
			)
			assert.ok(first.length >= 32)
			assert.notStrictEqual(
				first,
				Redacted.value(
					Development.developmentSecret(
						Redacted.make("dev:" + Str.repeat(32)("33")),
					),
				),
			)
		}),
)

it.effect(
	"development authentication accepts only origins on this computer in standard form",
	() =>
		Effect.gen(function* () {
			const decode = (publicOrigin: string) =>
				Schema.decodeEffect(AuthModel.Configuration)({
					mode: "development",
					publicOrigin,
					secret: Redacted.make(authSecret),
				}).pipe(Effect.result)
			assert.strictEqual(
				(yield* decode("https://localhost:8443"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("https://127.0.0.1:8443"))._tag,
				"Success",
			)
			assert.strictEqual((yield* decode("https://[::1]:8443"))._tag, "Success")
			assert.strictEqual(
				(yield* decode("https://openbot.localhost"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("https://openbot.localhost.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("https://e.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("http://openbot.localhost"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("http://e.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("https://localhost:8443/path"))._tag,
				"Failure",
			)
			assert.strictEqual((yield* decode("invalid"))._tag, "Failure")
		}),
)

it.effect(
	"return destinations accept same-origin client paths and reject open redirects",
	() =>
		Effect.sync(() => {
			const accepts = Schema.is(ReturnTo)
			for (const target of [
				"/",
				"/docs",
				"/developer/tests/test-1",
				"/apps?query=documents",
				"/chats/chat-1",
			])
				assert.strictEqual(accepts(target), true, target)
			for (const target of [
				"https://external.example/developer",
				"//external.example/developer",
				"/\\external.example",
				"/developer/../auth/callback",
				"/auth/login",
				"/v1/chats",
				"/development/sign-in",
			])
				assert.strictEqual(accepts(target), false, target)
		}),
)
