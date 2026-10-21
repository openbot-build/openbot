import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Setup from "../src/platform/Setup.ts"
import * as PlatformAdminsPostgres from "../src/platform/PlatformAdminsPostgres.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { OpenBot } from "@openbot-build/openbot"

const publicOrigin = "https://api.example.com"
const models = [
	{ id: "small", name: "Small", reasoningEfforts: [], serviceTiers: [] },
]

test(
	"Only platform admins change the platform, and the ceiling denies in every organization",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			sharedDomain: false,
			platformAdmins: ["root@example.com"],
		})
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const root = await host.login("root")
			const alice = await host.login("alice")

			// Alice is the Super Administrator of her own organization, but not a platform admin.
			assert.equal(
				(await account(alice.session, "/v1/platform/settings")).status,
				403,
			)
			const settings = await (
				await account(root.session, "/v1/platform/settings")
			).json()
			assert.equal(settings.publicOrigin, publicOrigin)
			assert.equal(settings.organizationCreation, "anyone")

			// A deny in the ceiling wins over every allow of an organization.
			assert.equal((await account(alice.session, "/v1/sessions")).status, 200)
			const ceiling = await account(
				root.session,
				"/v1/platform/settings",
				"PATCH",
				{
					expectedVersion: settings.version,
					policyCeiling: [
						{
							effect: "deny",
							permissionGroups: ["sessions.read"],
							resources: ["openbot.org.{org}"],
						},
					],
				},
			)
			assert.equal(ceiling.status, 200, await ceiling.clone().text())
			const updated = await ceiling.json()
			assert.equal((await account(alice.session, "/v1/sessions")).status, 403)

			// Without self-service, a new account gets no organization.
			assert.equal(
				(
					await account(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: updated.version,
						organizationCreation: "platform_admins",
						policyCeiling: [],
					})
				).status,
				200,
			)
			const dan = await host.login("dan").catch(() => undefined)
			assert.equal(dan, undefined)
			const created = await account(
				alice.session,
				"/v1/organizations",
				"POST",
				{
					name: "Second",
				},
			)
			assert.equal(created.status, 403)
			assert.equal((await created.json())._tag, "OrganizationCreationDisabled")

			// A platform admin can suspend an organization. Its members lose access.
			const suspended = await account(
				root.session,
				"/v1/platform/organizations/" + alice.identity.organizationId,
				"PATCH",
				{ status: "suspended" },
			)
			assert.equal(suspended.status, 200)
			assert.equal(
				(await account(alice.session, "/v1/organization")).status,
				403,
			)

			// The platform keeps one admin at least.
			const last = await account(
				root.session,
				"/v1/platform/admins/root%40example.com",
				"DELETE",
			)
			assert.equal((await last.json())._tag, "LastPlatformAdmin")
		} finally {
			await host.close()
		}
	},
)

test(
	"Organizations bring their own keys and see only the shared providers that they may use",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			sharedDomain: false,
			platformAdmins: ["root@example.com"],
		})
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const root = await host.login("root")
			const alice = await host.login("alice")
			const bob = await host.login("bob")

			const own = await account(
				alice.session,
				"/v1/organization/model_providers",
				"POST",
				{
					kind: "openai-compat",
					name: "Alice keys",
					endpoint: "https://models.example.com/v1",
					apiKey: "sk-alice-0123456789",
					models,
				},
			)
			assert.equal(own.status, 200, await own.clone().text())
			const provider = await own.json()
			assert.deepEqual(provider.apiKey, { set: true, hint: "…6789" })
			assert.equal(JSON.stringify(provider).includes("sk-alice"), false)
			const stale = await account(
				alice.session,
				"/v1/organization/model_providers/" + provider.id,
				"PATCH",
				{ expectedVersion: provider.version + 1, name: "Changed" },
			)
			assert.equal((await stale.json())._tag, "ModelProviderConflict")
			const missingEndpoint = await account(
				alice.session,
				"/v1/organization/model_providers",
				"POST",
				{ kind: "openai-compat", name: "No address", apiKey: "sk-x", models },
			)
			assert.equal((await missingEndpoint.json())._tag, "ModelProviderInvalid")

			const shared = await account(
				root.session,
				"/v1/platform/model_providers",
				"POST",
				{
					kind: "anthropic",
					name: "Shared",
					apiKey: "sk-platform-0123456789",
					models,
					availability: {
						_tag: "Selected",
						organizations: [alice.identity.organizationId],
					},
				},
			)
			assert.equal(shared.status, 200, await shared.clone().text())
			const sharedProvider = await shared.json()

			const aliceModels = await (
				await account(alice.session, "/v1/organization/models")
			).json()
			assert.deepEqual(
				aliceModels.providers.map((value: { id: string }) => value.id).sort(),
				[provider.id, sharedProvider.id].sort(),
			)
			assert.deepEqual(aliceModels.defaultModel, {
				_tag: "Config.Selection",
				provider: aliceModels.models[0].provider,
				model: "small",
			})
			const bobModels = await (
				await account(bob.session, "/v1/organization/models")
			).json()
			assert.deepEqual(bobModels.providers, [])
			assert.equal(bobModels.defaultModel, null)

			// A provider cannot go while the default model names it.
			const settings = await (
				await account(alice.session, "/v1/organization/settings")
			).json()
			await account(alice.session, "/v1/organization/settings", "PATCH", {
				expectedVersion: settings.version,
				defaultModel: {
					_tag: "Config.Selection",
					provider: provider.id,
					model: "small",
				},
			})
			const inUse = await account(
				alice.session,
				"/v1/organization/model_providers/" + provider.id,
				"DELETE",
			)
			assert.equal((await inUse.json())._tag, "ModelProviderInUse")

			// A token works on the platform only when its own policies say so.
			const plain = await (
				await account(root.session, "/v1/user/tokens", "POST", {
					name: "plain",
				})
			).json()
			const keyed = withToken(host.address)
			assert.equal(
				(await keyed(plain.secret, "/v1/platform/settings")).status,
				403,
			)
			const platformToken = await (
				await account(root.session, "/v1/user/tokens", "POST", {
					name: "platform",
					policies: [
						{
							effect: "allow",
							permissionGroups: ["platform.read"],
							resources: ["openbot.platform"],
						},
					],
				})
			).json()
			assert.equal(
				(await keyed(platformToken.secret, "/v1/platform/settings")).status,
				200,
			)
			assert.equal(
				(
					await keyed(platformToken.secret, "/v1/platform/settings", "PATCH", {
						expectedVersion: 0,
					})
				).status,
				403,
			)
		} finally {
			await host.close()
		}
	},
)

test("every instance sees a settings change at once, and setup runs only once", async () => {
	const database = await PostgresTest.start()
	const options = {
		databaseUrl: Redacted.make(database.url),
		secretKeys: Redacted.make("test:" + "11".repeat(32)),
	}
	const migration = ManagedRuntime.make(
		DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
	)
	const instance = () =>
		ManagedRuntime.make(
			PlatformAdminsPostgres.layer.pipe(
				Layer.provideMerge(OpenBot.layerShared(options)),
				Layer.provide(NodeServices.layer),
			),
		)
	try {
		await migration.runPromise(DatabasePostgres.migrate)
		const first = instance()
		const second = instance()
		try {
			const setup = (publicOrigin: string, force = false) =>
				first.runPromise(
					Setup.run({
						publicOrigin,
						identityProvider: Option.none(),
						adminEmails: ["root@example.com"],
						force,
					}).pipe(Effect.result),
				)
			assert.equal((await setup(publicOrigin))._tag, "Success")
			const again = await setup(publicOrigin)
			assert.ok(Result.isSuccess(again))
			assert.equal(again.success, "unchanged")
			assert.equal((await setup("https://other.example.com"))._tag, "Failure")

			// The second instance reads the defaults and keeps them in its cache.
			const read = () =>
				second.runPromise(
					Effect.flatMap(Settings, (settings) =>
						settings.organization("org_shared"),
					),
				)
			assert.equal((await read()).document.agentMemory, true)
			await first.runPromise(
				Effect.flatMap(Settings, (settings) =>
					settings.updateOrganization("org_shared", 0, (document) =>
						Effect.succeed({ ...document, agentMemory: false }),
					),
				),
			)
			// The notice reaches the second instance long before its cache expires.
			let seen = await read()
			for (let attempt = 0; seen.version === 0 && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20))
				seen = await read()
			}
			assert.equal(seen.version, 1)
			assert.equal(seen.document.agentMemory, false)
			const conflict = await second.runPromise(
				Effect.flatMap(Settings, (settings) =>
					settings.updateOrganization("org_shared", 0, (document) =>
						Effect.succeed(document),
					),
				).pipe(Effect.flip),
			)
			assert.equal(conflict._tag, "SettingsConflict")
		} finally {
			await first.dispose()
			await second.dispose()
		}
	} finally {
		await migration.dispose()
		await database.close()
	}
})
