import { assert, it } from "@effect/vitest"
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result } from "effect"
import { NodeServices } from "@effect/platform-node"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"
import * as Policies from "./Policies.ts"
import { Authorization } from "@openbot-build/api"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Setup from "../src/platform/Setup.ts"
import * as PlatformAdminsPostgres from "../src/platform/PlatformAdminsPostgres.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as PostgresTest from "./PostgresTest.ts"
import { OpenBot } from "@openbot-build/openbot"

const publicOrigin = "https://api.example.com"

it(
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
			assert.strictEqual(
				(await account(alice.session, "/v1/platform/settings")).status,
				403,
			)
			const settings = await (
				await account(root.session, "/v1/platform/settings")
			).json()
			assert.strictEqual(settings.publicOrigin, publicOrigin)
			assert.strictEqual(settings.organizationCreation, "anyone")

			// A deny in the ceiling wins over every allow of an organization.
			assert.strictEqual(
				(await account(alice.session, "/v1/chats")).status,
				200,
			)
			const ceiling = await account(
				root.session,
				"/v1/platform/settings",
				"PATCH",
				{
					expectedVersion: settings.version,
					ceiling: Policies.json(function* (_) {
						yield* _.deny("read", Authorization.Chat, Policies.inOrganization)
					}),
				},
			)
			assert.strictEqual(ceiling.status, 200, await ceiling.clone().text())
			const updated = await ceiling.json()
			assert.strictEqual(
				(await account(alice.session, "/v1/chats")).status,
				403,
			)

			// Without self-service, a new account gets no organization.
			assert.strictEqual(
				(
					await account(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: updated.version,
						organizationCreation: "platform_admins",
						ceiling: Policies.json(function* () {}),
					})
				).status,
				200,
			)
			const dan = await host.login("dan").catch(() => undefined)
			assert.strictEqual(dan, undefined)
			const created = await account(
				alice.session,
				"/v1/organizations",
				"POST",
				{
					name: "Second",
				},
			)
			assert.strictEqual(created.status, 403)
			assert.strictEqual(
				(await created.json())._tag,
				"OrganizationCreationDisabled",
			)

			// A platform admin can suspend an organization. Its members lose access.
			const suspended = await account(
				root.session,
				"/v1/platform/organizations/" + alice.identity.organizationId,
				"PATCH",
				{ status: "suspended" },
			)
			assert.strictEqual(suspended.status, 200)
			assert.strictEqual(
				(await account(alice.session, "/v1/organization")).status,
				403,
			)

			// The platform keeps one admin at least.
			const last = await account(
				root.session,
				"/v1/platform/admins/root%40example.com",
				"DELETE",
			)
			assert.strictEqual((await last.json())._tag, "LastPlatformAdmin")
		} finally {
			await host.close()
		}
	},
)

it(
	"Organizations bring their own keys and see only the shared providers and models that they may use",
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

			// A model is its own thing. A provider links it and can change its values.
			const small = await account(
				alice.session,
				"/v1/organization/models",
				"POST",
				{ id: "small", name: "Small", reasoningEfforts: [], serviceTiers: [] },
			)
			assert.strictEqual(small.status, 200, await small.clone().text())
			assert.strictEqual((await small.json()).availability, null)
			const twice = await account(
				alice.session,
				"/v1/organization/models",
				"POST",
				{ id: "small", name: "Again", reasoningEfforts: [], serviceTiers: [] },
			)
			assert.strictEqual((await twice.json())._tag, "ModelConflict")
			const own = await account(
				alice.session,
				"/v1/organization/model_providers",
				"POST",
				{
					kind: "openai-compat",
					name: "Alice keys",
					endpoint: "https://models.example.com/v1",
					apiKey: "sk-alice-0123456789",
					models: [
						{
							model: "small",
							modelOwner: "organization",
							upstream: "small-2026",
							contextWindow: 1000,
						},
					],
				},
			)
			assert.strictEqual(own.status, 200, await own.clone().text())
			const provider = await own.json()
			assert.deepStrictEqual(provider.apiKey, { set: true, hint: "…6789" })
			assert.strictEqual(JSON.stringify(provider).includes("sk-alice"), false)
			assert.deepStrictEqual(provider.models, [
				{
					model: "small",
					modelOwner: "organization",
					upstream: "small-2026",
					contextWindow: 1000,
				},
			])
			const stale = await account(
				alice.session,
				"/v1/organization/model_providers/" + provider.id,
				"PATCH",
				{ expectedVersion: provider.version + 1, name: "Changed" },
			)
			assert.strictEqual((await stale.json())._tag, "ModelProviderConflict")
			const missingEndpoint = await account(
				alice.session,
				"/v1/organization/model_providers",
				"POST",
				{
					kind: "openai-compat",
					name: "No address",
					apiKey: "sk-x",
					models: [],
				},
			)
			assert.strictEqual(
				(await missingEndpoint.json())._tag,
				"ModelProviderInvalid",
			)

			const large = await account(root.session, "/v1/platform/models", "POST", {
				id: "large",
				name: "Large",
				reasoningEfforts: ["low", "high"],
				serviceTiers: [],
				availability: {
					_tag: "Selected",
					organizations: [alice.identity.organizationId],
				},
			})
			assert.strictEqual(large.status, 200, await large.clone().text())
			const shared = await account(
				root.session,
				"/v1/platform/model_providers",
				"POST",
				{
					kind: "anthropic",
					name: "Shared",
					apiKey: "sk-platform-0123456789",
					models: [{ model: "large", modelOwner: "platform" }],
					availability: {
						_tag: "Selected",
						organizations: [alice.identity.organizationId],
					},
				},
			)
			assert.strictEqual(shared.status, 200, await shared.clone().text())
			const sharedProvider = await shared.json()
			// The platform links only its own models.
			const foreign = await account(
				root.session,
				"/v1/platform/model_providers",
				"POST",
				{
					kind: "anthropic",
					name: "Foreign",
					apiKey: "sk-platform-0123456789",
					models: [{ model: "small", modelOwner: "organization" }],
					availability: { _tag: "All" },
				},
			)
			assert.strictEqual((await foreign.json())._tag, "ModelProviderInvalid")
			// Bob may not use the shared model, so his provider cannot link it.
			const bobLink = await account(
				bob.session,
				"/v1/organization/model_providers",
				"POST",
				{
					kind: "anthropic",
					name: "Bob keys",
					apiKey: "sk-bob-0123456789",
					models: [{ model: "large", modelOwner: "platform" }],
				},
			)
			assert.strictEqual((await bobLink.json())._tag, "ModelNotFound")
			// Alice may use it, so her own key can serve it too.
			const linked = await account(
				alice.session,
				"/v1/organization/model_providers/" + provider.id,
				"PATCH",
				{
					expectedVersion: provider.version,
					models: [
						...provider.models,
						{
							model: "large",
							modelOwner: "platform",
							reasoningEfforts: ["low"],
						},
					],
				},
			)
			assert.strictEqual(linked.status, 200, await linked.clone().text())

			const aliceModels = await (
				await account(alice.session, "/v1/organization/model_catalog")
			).json()
			assert.deepStrictEqual(
				aliceModels.providers.map((value: { id: string }) => value.id).sort(),
				[provider.id, sharedProvider.id].sort(),
			)
			assert.deepStrictEqual(
				aliceModels.models.map(
					(value: {
						provider: string
						id: string
						reasoningEfforts: Array<string>
						contextWindow?: number
					}) => [
						value.provider,
						value.id,
						value.reasoningEfforts,
						value.contextWindow,
					],
				),
				[
					[provider.id, "small", [], 1000],
					[provider.id, "large", ["low"], undefined],
					[sharedProvider.id, "large", ["low", "high"], undefined],
				],
			)
			// There is no default model. Each use names its own model.
			assert.strictEqual("defaultModel" in aliceModels, false)
			const bobModels = await (
				await account(bob.session, "/v1/organization/model_catalog")
			).json()
			assert.deepStrictEqual(bobModels.providers, [])

			// A model cannot go while a provider of its owner links it.
			const linkedModel = await account(
				alice.session,
				"/v1/organization/models/small",
				"DELETE",
			)
			assert.strictEqual((await linkedModel.json())._tag, "ModelInUse")
			const sharedInUse = await account(
				root.session,
				"/v1/platform/models/large",
				"DELETE",
			)
			assert.strictEqual((await sharedInUse.json())._tag, "ModelInUse")
			// When the platform removes a shared model, the links of organizations go with it.
			await account(
				root.session,
				"/v1/platform/model_providers/" + sharedProvider.id,
				"PATCH",
				{ expectedVersion: sharedProvider.version, models: [] },
			)
			const removed = await account(
				root.session,
				"/v1/platform/models/large",
				"DELETE",
			)
			assert.strictEqual(removed.status, 204, await removed.clone().text())
			const after = await (
				await account(
					alice.session,
					"/v1/organization/model_providers/" + provider.id,
				)
			).json()
			assert.deepStrictEqual(
				after.models.map((value: { model: string }) => value.model),
				["small"],
			)
			assert.strictEqual(after.version, provider.version + 2)

			// A provider cannot go while the Rules model names it.
			const settings = await (
				await account(alice.session, "/v1/organization/settings")
			).json()
			await account(alice.session, "/v1/organization/settings", "PATCH", {
				expectedVersion: settings.version,
				rulesModel: {
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
			assert.strictEqual((await inUse.json())._tag, "ModelProviderInUse")

			// A token works on the platform only when its own policy says so.
			const plain = await (
				await account(root.session, "/v1/user/tokens", "POST", {
					name: "plain",
				})
			).json()
			const keyed = withToken(host.address)
			assert.strictEqual(
				(await keyed(plain.secret, "/v1/platform/settings")).status,
				403,
			)
			const platformToken = await (
				await account(root.session, "/v1/user/tokens", "POST", {
					name: "platform",
					policy: Policies.json(function* (_) {
						yield* _.allow("read", Authorization.Platform)
					}),
				})
			).json()
			assert.strictEqual(
				(await keyed(platformToken.secret, "/v1/platform/settings")).status,
				200,
			)
			assert.strictEqual(
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

it(
	"An organization links decision models to a decision provider",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin,
			sharedDomain: false,
			platformAdmins: ["root@example.com"],
		})
		try {
			const account = withCookie({ address: host.address, publicOrigin })
			const alice = await host.login("alice")
			const create = (body: object) =>
				account(alice.session, "/v1/organization/models", "POST", body)
			const provider = (body: object) =>
				account(alice.session, "/v1/organization/model_providers", "POST", {
					apiKey: "sk-test-0123456789",
					...body,
				})

			// A model is a language model unless it says otherwise.
			const chat = await create({
				id: "chat",
				name: "Chat",
				reasoningEfforts: [],
				serviceTiers: [],
			})
			assert.strictEqual((await chat.json()).type, "language")
			const jev = await create({
				id: "jev-latest",
				type: "decision",
				name: "Jev",
				reasoningEfforts: [],
				serviceTiers: [],
			})
			assert.strictEqual(jev.status, 200, await jev.clone().text())
			assert.strictEqual((await jev.json()).type, "decision")

			// A typesafe provider needs an address, and it links only decision models.
			const noAddress = await provider({
				kind: "typesafe",
				name: "TypeSafe",
				models: [],
			})
			assert.strictEqual((await noAddress.json())._tag, "ModelProviderInvalid")
			const wrongModel = await provider({
				kind: "typesafe",
				name: "TypeSafe",
				endpoint: "https://decisions.example.com/v1",
				models: [{ model: "chat", modelOwner: "organization" }],
			})
			assert.strictEqual((await wrongModel.json())._tag, "ModelProviderInvalid")
			const openai = await provider({
				kind: "openai",
				name: "OpenAI",
				models: [{ model: "jev-latest", modelOwner: "organization" }],
			})
			assert.strictEqual((await openai.json())._tag, "ModelProviderInvalid")
			const typesafe = await provider({
				kind: "typesafe",
				name: "TypeSafe",
				endpoint: "https://decisions.example.com/v1",
				models: [{ model: "jev-latest", modelOwner: "organization" }],
			})
			assert.strictEqual(typesafe.status, 200, await typesafe.clone().text())
			const decisions = await typesafe.json()
			// A gateway can link both types.
			const gateway = await provider({
				kind: "openai-compat",
				name: "Gateway",
				endpoint: "https://gateway.example.com/v1",
				models: [
					{ model: "chat", modelOwner: "organization" },
					{ model: "jev-latest", modelOwner: "organization" },
				],
			})
			assert.strictEqual(gateway.status, 200, await gateway.clone().text())
			const both = await gateway.json()

			// The catalog shows the type of each model.
			const catalog = await (
				await account(alice.session, "/v1/organization/model_catalog")
			).json()
			assert.deepStrictEqual(
				catalog.models.map(
					(model: { provider: string; id: string; type: string }) => [
						model.provider,
						model.id,
						model.type,
					],
				),
				[
					[decisions.id, "jev-latest", "decision"],
					[both.id, "chat", "language"],
					[both.id, "jev-latest", "decision"],
				],
			)

			// The Bot memory setting takes only language models. The Rules setting takes both types.
			const selection = (providerId: string, model: string) => ({
				_tag: "Config.Selection",
				provider: providerId,
				model,
			})
			const update = async (changes: object) => {
				const current = await (
					await account(alice.session, "/v1/organization/settings")
				).json()
				return account(alice.session, "/v1/organization/settings", "PATCH", {
					expectedVersion: current.version,
					...changes,
				})
			}
			const refused = await update({
				botMemoryModel: selection(decisions.id, "jev-latest"),
			})
			assert.strictEqual(refused.status, 400)
			assert.strictEqual((await refused.json())._tag, "SettingsInvalid")
			for (const rulesModel of [
				selection(decisions.id, "jev-latest"),
				selection(both.id, "chat"),
			]) {
				const saved = await update({ rulesModel })
				assert.strictEqual(saved.status, 200, await saved.clone().text())
				assert.deepStrictEqual((await saved.json()).rulesModel, rulesModel)
			}
		} finally {
			await host.close()
		}
	},
)

it("every instance sees a settings change at once, and setup runs only once", async () => {
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
			assert.strictEqual((await setup(publicOrigin))._tag, "Success")
			const again = await setup(publicOrigin)
			assert.ok(Result.isSuccess(again))
			assert.strictEqual(again.success, "unchanged")
			assert.strictEqual(
				(await setup("https://other.example.com"))._tag,
				"Failure",
			)

			// The second instance reads the defaults and keeps them in its cache.
			const read = () =>
				second.runPromise(
					Effect.flatMap(Settings, (settings) =>
						settings.organization("org_shared"),
					),
				)
			assert.strictEqual((await read()).document.botMemory, true)
			await first.runPromise(
				Effect.flatMap(Settings, (settings) =>
					settings.updateOrganization("org_shared", 0, (document) =>
						Effect.succeed({ ...document, botMemory: false }),
					),
				),
			)
			// The notice reaches the second instance long before its cache expires.
			let seen = await read()
			for (let attempt = 0; seen.version === 0 && attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20))
				seen = await read()
			}
			assert.strictEqual(seen.version, 1)
			assert.strictEqual(seen.document.botMemory, false)
			const conflict = await second.runPromise(
				Effect.flatMap(Settings, (settings) =>
					settings.updateOrganization("org_shared", 0, (document) =>
						Effect.succeed(document),
					),
				).pipe(Effect.flip),
			)
			assert.strictEqual(conflict._tag, "SettingsConflict")
		} finally {
			await first.dispose()
			await second.dispose()
		}
	} finally {
		await migration.dispose()
		await database.close()
	}
})
