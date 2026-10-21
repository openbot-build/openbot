import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout } from "node:timers/promises"
import { Pool } from "pg"
import { Effect, Option, Redacted } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as Setup from "../src/platform/Setup.ts"
import { Settings } from "../src/settings/Settings.ts"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import { InstanceWork } from "../src/execution/InstanceWork.ts"
import { Tokens } from "../src/auth/Tokens.ts"
import {
	ModelProviders,
	organizationOwner,
	platformOwner,
} from "../src/models/ModelProviders.ts"

test(
	"verified-email claims wait for exact-ID administrator binding",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin: "https://binding.example.com",
			sharedDomain: false,
		})
		const pool = new Pool({ connectionString: host.databaseUrl })
		const locked = await pool.connect()
		let claim: Promise<boolean> | undefined
		try {
			for (const id of ["stable-id", "unrelated-id"])
				await pool.query(
					"INSERT INTO openbot_auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$1,$2,true,now(),now())",
					[id, id + "@identity.example"],
				)
			await host.runtime.runPromise(
				Effect.flatMap(PlatformAdmins, (admins) =>
					admins.add("claim@example.com"),
				),
			)
			await locked.query("BEGIN")
			await locked.query(
				"SELECT pg_advisory_xact_lock(hashtextextended('openbot-platform-admins', 0))",
			)
			claim = host.runtime.runPromise(
				Effect.flatMap(PlatformAdmins, (admins) =>
					admins.check({
						id: "unrelated-id",
						email: "claim@example.com",
						emailVerified: true,
					}),
				),
			)
			let waiting = false
			for (let attempt = 0; attempt < 100; attempt++) {
				const blocked = await pool.query(
					"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'",
				)
				if (blocked.rows.length > 0) {
					waiting = true
					break
				}
				await setTimeout(10)
			}
			assert.equal(
				waiting,
				true,
				"First-login claims must use the same administrator lock as ID binding",
			)
			await locked.query(
				"UPDATE openbot_platform_admins SET user_id='stable-id' WHERE email='claim@example.com'",
			)
			await locked.query("COMMIT")
			assert.equal(await claim, false)
			const rows = await pool.query(
				"SELECT user_id FROM openbot_platform_admins WHERE email='claim@example.com'",
			)
			assert.deepEqual(rows.rows, [{ user_id: "stable-id" }])
		} finally {
			await locked.query("ROLLBACK")
			if (claim !== undefined) await claim
			locked.release()
			await pool.end()
			await host.close()
		}
	},
)

test(
	"native setup preserves signing keys, binds IDs and protects shared writes during pause",
	{ timeout: 60000 },
	async () => {
		const publicOrigin = "https://setup.example.com"
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		try {
			const account = await host.login("existing-admin")
			const initialAdmins = await host.runtime.runPromise(
				Effect.flatMap(PlatformAdmins, (service) => service.list),
			)
			const providerInput = {
				kind: "openai" as const,
				name: "Before pause",
				apiKey: "fixture-provider-secret",
				models: [],
				availability: { _tag: "None" as const },
			}
			const providers = await host.runtime.runPromise(
				Effect.flatMap(ModelProviders, (service) =>
					Effect.forEach(
						[platformOwner, organizationOwner(account.identity.organizationId)],
						(owner) => service.create(owner, providerInput),
					),
				),
			)
			const token = await host.runtime.runPromise(
				Effect.flatMap(Tokens, (tokens) =>
					tokens.create(account.identity, { name: "Before pause" }),
				),
			)
			const input: Setup.Input = {
				publicOrigin,
				identityProvider: Option.some({
					issuer: "https://id.example.com",
					clientId: "browser-fixture",
					clientSecret: Option.some("fixture-secret"),
					providerId: "existing",
					callbackPath: "/auth/callback",
				}),
				adminEmails: [],
				adminAccounts: [
					{ userId: account.identity.userId, email: "stable@example.com" },
				],
				authSecret: "IntegrationSecretForBetterAuthMustStayStable123456",
				browserAuth: {
					sessionCookie: "__Host-existing-session",
					loginCookie: "__Host-existing-login",
					sessionTtlMs: 86400000,
				},
				memberSignupOrganizationId: account.identity.organizationId,
				force: true,
			}
			assert.equal(await host.runtime.runPromise(Setup.run(input)), "replaced")
			const current = await host.runtime.runPromise(
				Effect.flatMap(Settings, (settings) => settings.platform),
			)
			assert.ok(Option.isSome(current))
			assert.deepEqual(current.value.document.browserAuth, input.browserAuth)
			assert.equal(
				current.value.document.identityProvider?.providerId,
				"existing",
			)
			assert.equal(
				current.value.document.memberSignupOrganizationId,
				account.identity.organizationId,
			)
			const admins = await host.runtime.runPromise(
				Effect.flatMap(PlatformAdmins, (service) => service.list),
			)
			assert.deepEqual(
				admins.map(({ email, userId }) => ({ email, userId })),
				[
					...initialAdmins.map(({ email, userId }) => ({ email, userId })),
					{ email: "stable@example.com", userId: account.identity.userId },
				].toSorted((left, right) => left.email.localeCompare(right.email)),
			)
			assert.equal(
				await host.runtime.runPromise(Setup.run({ ...input, force: false })),
				"unchanged",
			)
			const changedSecret = await host.runtime.runPromise(
				Setup.run({
					...input,
					authSecret: "DifferentSigningSecretMustNotReplaceCookies123",
				}).pipe(Effect.flip),
			)
			assert.equal(changedSecret._tag, "SetupInvalid")
			const unchanged = await host.runtime.runPromise(
				Effect.flatMap(Settings, (settings) => settings.platform),
			)
			assert.ok(Option.isSome(unchanged))
			assert.equal(
				unchanged.value.document.authSecret,
				current.value.document.authSecret,
			)
			await host.runtime.runPromise(
				Effect.flatMap(InstanceWork, (gate) => gate.quiesce),
			)
			const paused = await host.runtime.runPromise(
				Effect.flatMap(Settings, (settings) =>
					settings.updatePlatform(unchanged.value.version, (document) =>
						Effect.succeed({
							...document,
							organizationCreation: "platform_admins",
						}),
					),
				).pipe(Effect.flip),
			)
			assert.equal(paused._tag, "SettingsUnavailable")
			const bind = await host.runtime.runPromise(
				Effect.flatMap(PlatformAdmins, (service) =>
					service.bind({ userId: "another-id", email: "another@example.com" }),
				).pipe(Effect.flip),
			)
			assert.equal(bind._tag, "PlatformAdminsUnavailable")
			const tokenWrite = await host.runtime.runPromise(
				Effect.flatMap(Tokens, (tokens) =>
					tokens.authenticate(Redacted.make(token.secret)),
				).pipe(Effect.flip),
			)
			assert.equal(
				tokenWrite._tag,
				"AuthUnavailable",
				"Token last-used refresh participates in the shared write gate",
			)
			const tokenCreate = await host.runtime.runPromise(
				Effect.flatMap(Tokens, (tokens) =>
					tokens.create(account.identity, { name: "During pause" }),
				).pipe(Effect.flip),
			)
			assert.equal(tokenCreate._tag, "TokenStorageUnavailable")
			const tokenRevoke = await host.runtime.runPromise(
				Effect.flatMap(Tokens, (tokens) =>
					tokens.revoke(account.identity, token.token.id),
				).pipe(Effect.flip),
			)
			assert.equal(tokenRevoke._tag, "TokenStorageUnavailable")
			for (const provider of providers) {
				const writes = await host.runtime.runPromise(
					Effect.flatMap(ModelProviders, (service) =>
						Effect.all([
							service.create(provider.owner, providerInput).pipe(Effect.flip),
							service
								.update(provider.owner, provider.id, {
									expectedVersion: provider.version,
									name: "During pause",
								})
								.pipe(Effect.flip),
							service.delete(provider.owner, provider.id).pipe(Effect.flip),
						]),
					),
				)
				assert.deepEqual(
					writes.map((error) => error._tag),
					Array(3).fill("ModelProvidersUnavailable"),
				)
				const currentProvider = await host.runtime.runPromise(
					Effect.flatMap(ModelProviders, (service) =>
						service.get(provider.owner, provider.id),
					),
				)
				assert.ok(Option.isSome(currentProvider))
				assert.equal(currentProvider.value.version, provider.version)
				assert.equal(currentProvider.value.name, "Before pause")
			}
		} finally {
			await host.runtime.runPromise(
				Effect.flatMap(InstanceWork, (gate) => gate.resume),
			)
			await host.close()
		}
	},
)
