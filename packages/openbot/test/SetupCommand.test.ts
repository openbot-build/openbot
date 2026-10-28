import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import {
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Redacted,
	Ref,
	Record,
} from "effect"
import { Command } from "effect/cli"
import * as SetupCommand from "../src/app/SetupCommand.ts"
import * as SecretFiles from "../src/configuration/SecretFiles.ts"
import type { Input } from "../src/platform/Setup.ts"

layer(NodeServices.layer)((it) => {
	it.effect(
		"setup resolves compatibility and signing settings before its handler, including secret files",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const directory = yield* fs.makeTempDirectoryScoped({
					prefix: "openbot-setup-",
				})
				const browserAuth = {
					sessionCookie: "__Host-existing-session",
					loginCookie: "__Host-existing-login",
					sessionTtlMs: 86400000,
				}
				const values = {
					OPENBOT_SETUP_PUBLIC_ORIGIN: "https://app.example.com",
					OPENBOT_SETUP_OIDC_ISSUER: "https://id.example.com",
					OPENBOT_SETUP_OIDC_CLIENT_ID: "existing-client",
					OPENBOT_SETUP_OIDC_PROVIDER_ID: "primary",
					OPENBOT_SETUP_OIDC_CALLBACK_PATH: "/auth/callback",
					OPENBOT_SETUP_OIDC_SCOPES:
						'["openid","profile","email","offline_access"]',
					OPENBOT_SETUP_BROWSER_AUTH:
						'{"sessionCookie":"__Host-existing-session","loginCookie":"__Host-existing-login","sessionTtlMs":86400000}',
					OPENBOT_SETUP_AUTH_SECRET: "existing-session-signing-secret-32-bytes",
					OPENBOT_SETUP_OIDC_CLIENT_SECRET: "file-client-secret",
					OPENBOT_SETUP_MEMBER_SIGNUP_ORGANIZATION_ID: "org_public",
				}
				for (const [key, value] of Record.toEntries(values))
					yield* fs.writeFileString(path.join(directory, key), value + "\n")
				const received = yield* Ref.make(Option.none<Input>())
				const command = SetupCommand.make((input) =>
					Ref.set(received, Option.some(input)).pipe(
						Effect.as("created" as const),
					),
				)
				yield* Command.runWith(command, {
					version: "test",
					renderErrors: false,
				})(["--admin-email=admin@example.com"]).pipe(
					Effect.provide(
						SecretFiles.layer(directory).pipe(
							Layer.provide(
								ConfigProvider.layer(
									ConfigProvider.fromUnknown({
										OPENBOT_SETUP_OIDC_CLIENT_SECRET: "env-client-secret",
									}),
								),
							),
						),
					),
				)
				const input = Option.getOrThrow(yield* Ref.get(received))
				assert.strictEqual(
					input.publicOrigin,
					values.OPENBOT_SETUP_PUBLIC_ORIGIN,
				)
				assert.deepStrictEqual(input.browserAuth, browserAuth)
				assert.strictEqual(input.memberSignupOrganizationId, "org_public")
				assert.strictEqual(
					Redacted.value(Option.getOrThrow(input.authSecret)),
					values.OPENBOT_SETUP_AUTH_SECRET,
				)
				const provider = Option.getOrThrow(input.identityProvider)
				assert.strictEqual(provider.providerId, "primary")
				assert.strictEqual(provider.callbackPath, "/auth/callback")
				assert.deepStrictEqual(provider.scopes, [
					"openid",
					"profile",
					"email",
					"offline_access",
				])
				assert.strictEqual(
					Redacted.value(Option.getOrThrow(provider.clientSecret)),
					"env-client-secret",
				)
			}),
	)
	it.effect("invalid scope and cookie settings never reach setup", () =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0)
			const command = SetupCommand.make(() =>
				Ref.update(calls, (n) => n + 1).pipe(Effect.as("created" as const)),
			)
			for (const flag of [
				'--oidc-scopes=["email"]',
				'--browser-auth={"sessionCookie":"plain","loginCookie":"plain","sessionTtlMs":1}',
				"--member-signup-organization-id=../../another",
			]) {
				const result = yield* Command.runWith(command, {
					version: "test",
					renderErrors: false,
				})([
					"--public-origin=https://app.example.com",
					"--admin-email=admin@example.com",
					flag,
				]).pipe(
					Effect.result,
					Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
				)
				assert.strictEqual(result._tag, "Failure")
			}
			assert.strictEqual(yield* Ref.get(calls), 0)
		}),
	)
})
