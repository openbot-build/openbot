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
			assert.equal(small.status, 200, await small.clone().text())
			assert.equal((await small.json()).availability, null)
			const twice = await account(
				alice.session,
				"/v1/organization/models",
				"POST",
				{ id: "small", name: "Again", reasoningEfforts: [], serviceTiers: [] },
			)
			assert.equal((await twice.json())._tag, "ModelConflict")
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
			assert.equal(own.status, 200, await own.clone().text())
			const provider = await own.json()
			assert.deepEqual(provider.apiKey, { set: true, hint: "…6789" })
			assert.equal(JSON.stringify(provider).includes("sk-alice"), false)
			assert.deepEqual(provider.models, [
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
			assert.equal((await stale.json())._tag, "ModelProviderConflict")
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
			assert.equal((await missingEndpoint.json())._tag, "ModelProviderInvalid")

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
			assert.equal(large.status, 200, await large.clone().text())
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
			assert.equal(shared.status, 200, await shared.clone().text())
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
			assert.equal((await foreign.json())._tag, "ModelProviderInvalid")
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
			assert.equal((await bobLink.json())._tag, "ModelNotFound")
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
			assert.equal(linked.status, 200, await linked.clone().text())

			const aliceModels = await (
				await account(alice.session, "/v1/organization/model_catalog")
			).json()
			assert.deepEqual(
				aliceModels.providers.map((value: { id: string }) => value.id).sort(),
				[provider.id, sharedProvider.id].sort(),
			)
			assert.deepEqual(
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
			assert.equal("defaultModel" in aliceModels, false)
			const bobModels = await (
				await account(bob.session, "/v1/organization/model_catalog")
			).json()
			assert.deepEqual(bobModels.providers, [])

			// A model cannot go while a provider of its owner links it.
			const linkedModel = await account(
				alice.session,
				"/v1/organization/models/small",
				"DELETE",
			)
			assert.equal((await linkedModel.json())._tag, "ModelInUse")
			const sharedInUse = await account(
				root.session,
				"/v1/platform/models/large",
				"DELETE",
			)
			assert.equal((await sharedInUse.json())._tag, "ModelInUse")
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
			assert.equal(removed.status, 204, await removed.clone().text())
			const after = await (
				await account(
					alice.session,
					"/v1/organization/model_providers/" + provider.id,
				)
			).json()
			assert.deepEqual(
				after.models.map((value: { model: string }) => value.model),
				["small"],
			)
			assert.equal(after.version, provider.version + 2)

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

test(
	"An organization sets a decision model with a decision provider and a decision model",
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
			assert.equal((await chat.json()).type, "language")
			const jev = await create({
				id: "jev-latest",
				type: "decision",
				name: "Jev",
				reasoningEfforts: [],
				serviceTiers: [],
			})
			assert.equal(jev.status, 200, await jev.clone().text())
			assert.equal((await jev.json()).type, "decision")

			// A typesafe provider needs an address, and it links only decision models.
			const noAddress = await provider({
				kind: "typesafe",
				name: "TypeSafe",
				models: [],
			})
			assert.equal((await noAddress.json())._tag, "ModelProviderInvalid")
			const wrongModel = await provider({
				kind: "typesafe",
				name: "TypeSafe",
				endpoint: "https://decisions.example.com/v1",
				models: [{ model: "chat", modelOwner: "organization" }],
			})
			assert.equal((await wrongModel.json())._tag, "ModelProviderInvalid")
			const openai = await provider({
				kind: "openai",
				name: "OpenAI",
				models: [{ model: "jev-latest", modelOwner: "organization" }],
			})
			assert.equal((await openai.json())._tag, "ModelProviderInvalid")
			const typesafe = await provider({
				kind: "typesafe",
				name: "TypeSafe",
				endpoint: "https://decisions.example.com/v1",
				models: [{ model: "jev-latest", modelOwner: "organization" }],
			})
			assert.equal(typesafe.status, 200, await typesafe.clone().text())
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
			assert.equal(gateway.status, 200, await gateway.clone().text())
			const both = await gateway.json()

			// The catalog shows the type of each model.
			const catalog = await (
				await account(alice.session, "/v1/organization/model_catalog")
			).json()
			assert.deepEqual(
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
			assert.equal(catalog.decisionModel, null)

			// Each setting takes only the right type of model.
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
			for (const changes of [
				{ decisionModel: selection(both.id, "chat") },
				{ decisionModel: selection(decisions.id, "missing") },
				{ rulesModel: selection(both.id, "jev-latest") },
				{ botMemoryModel: selection(decisions.id, "jev-latest") },
			]) {
				const refused = await update(changes)
				assert.equal(refused.status, 400, JSON.stringify(changes))
				assert.equal((await refused.json())._tag, "SettingsInvalid")
			}
			const saved = await update({
				decisionModel: selection(decisions.id, "jev-latest"),
			})
			assert.equal(saved.status, 200, await saved.clone().text())
			assert.deepEqual(
				(await saved.json()).decisionModel,
				selection(decisions.id, "jev-latest"),
			)
			assert.deepEqual(
				(
					await (
						await account(alice.session, "/v1/organization/model_catalog")
					).json()
				).decisionModel,
				selection(decisions.id, "jev-latest"),
			)

			// The provider cannot go while the decision model names it.
			const inUse = await account(
				alice.session,
				"/v1/organization/model_providers/" + decisions.id,
				"DELETE",
			)
			assert.equal((await inUse.json())._tag, "ModelProviderInUse")
			const cleared = await update({ decisionModel: null })
			assert.equal((await cleared.json()).decisionModel, null)
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
			assert.equal((await read()).document.botMemory, true)
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
			assert.equal(seen.version, 1)
			assert.equal(seen.document.botMemory, false)
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
