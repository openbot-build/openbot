import {
	Access,
	BrowserHost,
	Caller,
	Messages,
	Policies,
} from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	Order,
	Predicate,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import {
	AuthApi,
	Authorization,
	ModelProvidersApi,
	Settings as SettingsApi,
	UserTokensApi,
} from "@openbot-build/api"

const { bot, message } = Messages
type Send = Messages.Send

const publicOrigin = "https://api.example.com"

const Failure = Schema.Struct({ _tag: Schema.String })

/**
 * Reads the JSON body of an answer in the wire shape of a schema. It checks
 * the status, or that the status is 2xx when none is given.
 */
const decode = <S extends Schema.Constraint>(schema: S, status?: number) =>
	Caller.json(Schema.toEncoded(schema), status)

/** Calls the API and reads the answer with `decode`. */
const json = <S extends Schema.Constraint, E, R>(
	schema: S,
	call: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
	status?: number,
) => Effect.flatMap(call, decode(schema, status))

/** Reads the tag of an error answer. */
const tagOf = (response: HttpClientResponse.HttpClientResponse) =>
	Effect.map(
		HttpClientResponse.schemaBodyJson(Failure)(response),
		(failure) => failure._tag,
	)

// The host and the database are real, so the tests use real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Only platform admins change the platform, and the ceiling denies in every organization",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					platformAdmins: ["root@example.com"],
				})
				const account = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const root = yield* host.login("root")
				const alice = yield* host.login("alice")

				// Alice is the Super Administrator of her own organization, but not a platform admin.
				assert.strictEqual(
					(yield* account(alice.session, "/v1/platform/settings")).status,
					403,
				)
				const settings = yield* json(
					SettingsApi.PlatformSettings,
					account(root.session, "/v1/platform/settings"),
				)
				assert.strictEqual(settings.publicOrigin, publicOrigin)
				assert.strictEqual(settings.organizationCreation, "anyone")

				// A deny in the ceiling wins over every allow of an organization.
				assert.strictEqual(
					(yield* account(alice.session, "/v1/chats")).status,
					200,
				)
				const updated = yield* json(
					SettingsApi.PlatformSettings,
					account(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: settings.version,
						ceiling: yield* Policies.json(function* (_) {
							yield* _.deny("read", Authorization.Chat, Policies.inOrganization)
						}),
					}),
					200,
				)
				assert.deepStrictEqual(
					yield* json(
						Schema.Array(Schema.Unknown),
						account(alice.session, "/v1/chats"),
						200,
					),
					[],
				)

				// Without self-service, a new account keeps only its personal space.
				assert.strictEqual(
					(yield* account(root.session, "/v1/platform/settings", "PATCH", {
						expectedVersion: updated.version,
						organizationCreation: "platform_admins",
						ceiling: yield* Policies.json(function* () {}),
					})).status,
					200,
				)
				const dan = yield* host.login("dan", undefined, {
					organization: false,
				})
				assert.strictEqual(dan.memberships.length, 1)
				assert.strictEqual(dan.memberships[0]?.kind, "personal")
				assert.strictEqual(dan.memberships[0]?.ownerUserId, dan.identity.userId)
				const refused = yield* account(
					dan.session,
					"/v1/organizations",
					"POST",
					{
						name: "Dan",
					},
				)
				assert.strictEqual(refused.status, 403)
				assert.strictEqual(
					yield* tagOf(refused),
					"OrganizationCreationDisabled",
				)
				const created = yield* account(
					alice.session,
					"/v1/organizations",
					"POST",
					{
						name: "Second",
					},
				)
				assert.strictEqual(created.status, 403)
				assert.strictEqual(
					yield* tagOf(created),
					"OrganizationCreationDisabled",
				)

				// A platform admin can suspend an organization. Its members lose access.
				const suspended = yield* account(
					root.session,
					"/v1/platform/organizations/" + alice.identity.organizationId,
					"PATCH",
					{ status: "suspended" },
				)
				assert.strictEqual(suspended.status, 200)
				assert.strictEqual(
					(yield* HttpClient.get((yield* host.address) + "/v1/organization", {
						headers: {
							cookie: Caller.sessionCookie(alice.session),
							[AuthApi.OrganizationHeader]: alice.identity.organizationId,
						},
					})).status,
					403,
				)

				// The platform keeps one admin at least.
				const last = yield* account(
					root.session,
					"/v1/platform/admins/root%40example.com",
					"DELETE",
				)
				assert.strictEqual(yield* tagOf(last), "LastPlatformAdmin")
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"Organizations bring their own keys and see only the shared providers and models that they may use",
		() =>
			Effect.gen(function* () {
				// The catalogs hold only the stored models, so the platform has no fixture model.
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					platformAdmins: ["root@example.com"],
					registryModels: true,
				})
				const address = yield* host.address
				const account = Caller.withCookie({ address, publicOrigin })
				const root = yield* host.login("root")
				const alice = yield* host.login("alice")
				const bob = yield* host.login("bob")

				// A model is its own thing. A provider links it and can change its values.
				const small = yield* json(
					ModelProvidersApi.Model,
					account(alice.session, "/v1/organization/models", "POST", {
						id: "small",
						name: "Small",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
					200,
				)
				assert.strictEqual(small.availability, null)
				const twice = yield* account(
					alice.session,
					"/v1/organization/models",
					"POST",
					{
						id: "small",
						name: "Again",
						reasoningEfforts: [],
						serviceTiers: [],
					},
				)
				assert.strictEqual(yield* tagOf(twice), "ModelConflict")
				const own = yield* account(
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
				const provider = yield* decode(
					ModelProvidersApi.ModelProvider,
					200,
				)(own)
				assert.deepStrictEqual(provider.apiKey, { set: true, hint: "…6789" })
				assert.strictEqual(Str.includes("sk-alice")(yield* own.text), false)
				assert.deepStrictEqual(provider.models, [
					{
						model: "small",
						modelOwner: "organization",
						upstream: "small-2026",
						contextWindow: 1000,
					},
				])
				const stale = yield* account(
					alice.session,
					"/v1/organization/model_providers/" + provider.id,
					"PATCH",
					{ expectedVersion: provider.version + 1, name: "Changed" },
				)
				assert.strictEqual(yield* tagOf(stale), "ModelProviderConflict")
				const missingEndpoint = yield* account(
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
					yield* tagOf(missingEndpoint),
					"ModelProviderInvalid",
				)

				const large = yield* account(
					root.session,
					"/v1/platform/models",
					"POST",
					{
						id: "large",
						name: "Large",
						reasoningEfforts: ["low", "high"],
						serviceTiers: [],
						availability: {
							_tag: "Selected",
							organizations: [alice.identity.organizationId],
						},
					},
				)
				assert.strictEqual(large.status, 200, yield* large.text)
				const sharedProvider = yield* json(
					ModelProvidersApi.ModelProvider,
					account(root.session, "/v1/platform/model_providers", "POST", {
						kind: "anthropic",
						name: "Shared",
						apiKey: "sk-platform-0123456789",
						models: [{ model: "large", modelOwner: "platform" }],
						availability: {
							_tag: "Selected",
							organizations: [alice.identity.organizationId],
						},
					}),
					200,
				)
				// The platform links only its own models.
				const foreign = yield* account(
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
				assert.strictEqual(yield* tagOf(foreign), "ModelProviderInvalid")
				// Bob may not use the shared model, so his provider cannot link it.
				const bobLink = yield* account(
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
				assert.strictEqual(yield* tagOf(bobLink), "ModelNotFound")
				// Alice may use it, so her own key can serve it too.
				const linked = yield* account(
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
				assert.strictEqual(linked.status, 200, yield* linked.text)

				const aliceCatalog = yield* account(
					alice.session,
					"/v1/organization/model_catalog",
				)
				const aliceModels = yield* decode(ModelProvidersApi.ModelCatalog)(
					aliceCatalog,
				)
				assert.deepStrictEqual(
					Arr.sort(
						Arr.map(aliceModels.providers, (value) => value.id),
						Order.String,
					),
					Arr.sort([provider.id, sharedProvider.id], Order.String),
				)
				assert.deepStrictEqual(
					Arr.map(aliceModels.models, (value) => [
						value.provider,
						value.id,
						value.reasoningEfforts,
						value.contextWindow,
					]),
					[
						[provider.id, "small", [], 1000],
						[provider.id, "large", ["low"], undefined],
						[sharedProvider.id, "large", ["low", "high"], undefined],
					],
				)
				// There is no default model. Each use names its own model.
				assert.strictEqual(
					Predicate.hasProperty(yield* aliceCatalog.json, "defaultModel"),
					false,
				)
				const bobModels = yield* json(
					ModelProvidersApi.ModelCatalog,
					account(bob.session, "/v1/organization/model_catalog"),
				)
				assert.deepStrictEqual(bobModels.providers, [])

				// A model cannot go while a provider of its owner links it.
				const linkedModel = yield* account(
					alice.session,
					"/v1/organization/models/small",
					"DELETE",
				)
				assert.strictEqual(yield* tagOf(linkedModel), "ModelInUse")
				const sharedInUse = yield* account(
					root.session,
					"/v1/platform/models/large",
					"DELETE",
				)
				assert.strictEqual(yield* tagOf(sharedInUse), "ModelInUse")
				// When the platform removes a shared model, the links of organizations go with it.
				yield* account(
					root.session,
					"/v1/platform/model_providers/" + sharedProvider.id,
					"PATCH",
					{ expectedVersion: sharedProvider.version, models: [] },
				)
				const removed = yield* account(
					root.session,
					"/v1/platform/models/large",
					"DELETE",
				)
				assert.strictEqual(removed.status, 204, yield* removed.text)
				const after = yield* json(
					ModelProvidersApi.ModelProvider,
					account(
						alice.session,
						"/v1/organization/model_providers/" + provider.id,
					),
				)
				assert.deepStrictEqual(
					Arr.map(after.models, (value) => value.model),
					["small"],
				)
				assert.strictEqual(after.version, provider.version + 2)

				// A provider cannot go while the Rules model names it.
				const settings = yield* json(
					SettingsApi.OrganizationSettings,
					account(alice.session, "/v1/organization/settings"),
				)
				yield* account(alice.session, "/v1/organization/settings", "PATCH", {
					expectedVersion: settings.version,
					rulesModel: {
						_tag: "Config.Selection",
						provider: provider.id,
						model: "small",
					},
				})
				const inUse = yield* account(
					alice.session,
					"/v1/organization/model_providers/" + provider.id,
					"DELETE",
				)
				assert.strictEqual(yield* tagOf(inUse), "ModelProviderInUse")

				// A token works on the platform only when its own policy says so.
				const plain = yield* json(
					UserTokensApi.CreatedToken,
					account(root.session, "/v1/user/tokens", "POST", {
						name: "plain",
					}),
				)
				const keyed = Caller.withToken(address)
				assert.strictEqual(
					(yield* keyed(plain.secret, "/v1/platform/settings")).status,
					403,
				)
				const platformToken = yield* json(
					UserTokensApi.CreatedToken,
					account(root.session, "/v1/user/tokens", "POST", {
						name: "platform",
						policy: yield* Policies.json(function* (_) {
							yield* _.allow("read", Authorization.Platform)
						}),
					}),
				)
				assert.strictEqual(
					(yield* keyed(platformToken.secret, "/v1/platform/settings")).status,
					200,
				)
				assert.strictEqual(
					(yield* keyed(
						platformToken.secret,
						"/v1/platform/settings",
						"PATCH",
						{
							expectedVersion: 0,
						},
					)).status,
					403,
				)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"An organization links decision models to a decision provider",
		() =>
			Effect.gen(function* () {
				// The catalogs hold only the stored models, so the platform has no fixture model.
				const host = yield* BrowserHost.start({
					publicOrigin,
					sharedDomain: false,
					platformAdmins: ["root@example.com"],
					registryModels: true,
				})
				const account = Caller.withCookie({
					address: yield* host.address,
					publicOrigin,
				})
				const alice = yield* host.login("alice")
				const create = (body: object) =>
					account(alice.session, "/v1/organization/models", "POST", body)
				const provider = (body: object) =>
					account(alice.session, "/v1/organization/model_providers", "POST", {
						apiKey: "sk-test-0123456789",
						...body,
					})

				// A model is a language model unless it says otherwise.
				const chat = yield* json(
					ModelProvidersApi.Model,
					create({
						id: "chat",
						name: "Chat",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
				)
				assert.strictEqual(chat.type, "language")
				const jev = yield* json(
					ModelProvidersApi.Model,
					create({
						id: "jev-latest",
						type: "decision",
						name: "Jev",
						reasoningEfforts: [],
						serviceTiers: [],
					}),
					200,
				)
				assert.strictEqual(jev.type, "decision")

				// A typesafe provider needs an address, and it links only decision models.
				const noAddress = yield* provider({
					kind: "typesafe",
					name: "TypeSafe",
					models: [],
				})
				assert.strictEqual(yield* tagOf(noAddress), "ModelProviderInvalid")
				const wrongModel = yield* provider({
					kind: "typesafe",
					name: "TypeSafe",
					endpoint: "https://decisions.example.com/v1",
					models: [{ model: "chat", modelOwner: "organization" }],
				})
				assert.strictEqual(yield* tagOf(wrongModel), "ModelProviderInvalid")
				const openai = yield* provider({
					kind: "openai",
					name: "OpenAI",
					models: [{ model: "jev-latest", modelOwner: "organization" }],
				})
				assert.strictEqual(yield* tagOf(openai), "ModelProviderInvalid")
				const decisions = yield* json(
					ModelProvidersApi.ModelProvider,
					provider({
						kind: "typesafe",
						name: "TypeSafe",
						endpoint: "https://decisions.example.com/v1",
						models: [{ model: "jev-latest", modelOwner: "organization" }],
					}),
					200,
				)
				// A gateway can link both types.
				const both = yield* json(
					ModelProvidersApi.ModelProvider,
					provider({
						kind: "openai-compat",
						name: "Gateway",
						endpoint: "https://gateway.example.com/v1",
						models: [
							{ model: "chat", modelOwner: "organization" },
							{ model: "jev-latest", modelOwner: "organization" },
						],
					}),
					200,
				)

				// The catalog shows the type of each model.
				const catalog = yield* json(
					ModelProvidersApi.ModelCatalog,
					account(alice.session, "/v1/organization/model_catalog"),
				)
				assert.deepStrictEqual(
					Arr.map(catalog.models, (model) => [
						model.provider,
						model.id,
						model.type,
					]),
					[
						[decisions.id, "jev-latest", "decision"],
						[both.id, "chat", "language"],
						[both.id, "jev-latest", "decision"],
					],
				)

				// The Bot memory setting takes only language models. The Rules setting takes both types.
				const selection = (providerId: string, model: string) => ({
					_tag: "Config.Selection" as const,
					provider: providerId,
					model,
				})
				const update = (changes: object) =>
					Effect.gen(function* () {
						const current = yield* json(
							SettingsApi.OrganizationSettings,
							account(alice.session, "/v1/organization/settings"),
						)
						return yield* account(
							alice.session,
							"/v1/organization/settings",
							"PATCH",
							{ expectedVersion: current.version, ...changes },
						)
					})
				const refused = yield* update({
					botMemoryModel: selection(decisions.id, "jev-latest"),
				})
				assert.strictEqual(refused.status, 400)
				assert.strictEqual(yield* tagOf(refused), "SettingsInvalid")
				for (const rulesModel of [
					selection(decisions.id, "jev-latest"),
					selection(both.id, "chat"),
				]) {
					const saved = yield* json(
						SettingsApi.OrganizationSettings,
						update({ rulesModel }),
						200,
					)
					assert.deepStrictEqual(saved.rulesModel, rulesModel)
				}
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"before setup every route except /health answers SetupRequired, and setup works at once on the same server",
		() =>
			Effect.gen(function* () {
				const { address, setup } = yield* Access.startUnconfiguredPlatform({
					publicOrigin,
				})
				assert.strictEqual(
					(yield* HttpClient.get(address + "/health")).status,
					200,
				)
				for (const path of [
					"/v1/apps/client-metadata",
					"/auth/session",
					"/not-a-route",
					// This request target is not a valid URL path, so it is not /health.
					"//",
				]) {
					const waiting = yield* HttpClient.get(address + path)
					assert.strictEqual(waiting.status, 503)
					assert.strictEqual(yield* tagOf(waiting), "SetupRequired")
				}

				// Setup writes the settings. The same server uses them at once.
				yield* setup
				const metadata = yield* Effect.flatMap(
					HttpClient.get(address + "/v1/apps/client-metadata"),
					Caller.json(Schema.Struct({ client_id: Schema.String })),
				)
				assert.strictEqual(
					metadata.client_id,
					publicOrigin + "/v1/apps/client-metadata",
				)
				assert.strictEqual(
					(yield* HttpClient.get(address + "/auth/session")).status,
					401,
				)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"a change of the public origin works at once, and stops no running request or Turn",
		() =>
			Effect.gen(function* () {
				const nextOrigin = "https://next.example.com"
				// The model waits in the middle of a Turn until the test lets it go on.
				const started = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: '{"changes":[]}' }),
						]),
					streamText: () =>
						Stream.unwrap(
							Effect.gen(function* () {
								yield* Deferred.succeed(started, undefined)
								yield* Deferred.await(release)
								return Stream.make(
									Response.makePart("text-start", { id: "text" }),
									Response.makePart("text-delta", {
										id: "text",
										delta: "Done after the change",
									}),
									Response.makePart("text-end", { id: "text" }),
									Response.makePart("finish", { reason: "stop", usage }),
								)
							}),
						),
				})
				const host = yield* BrowserHost.start({
					publicOrigin,
					platformAdmins: ["root@example.com"],
					model,
				})
				const address = yield* host.address
				const root = yield* host.login("root")
				const asRootBefore: Send = (path, method, payload) =>
					Caller.withCookie({ address, publicOrigin })(
						root.session,
						path,
						method,
						payload,
					)
				const asRootAfter: Send = (path, method, payload) =>
					Caller.withCookie({ address, publicOrigin: nextOrigin })(
						root.session,
						path,
						method,
						payload,
					)
				/** Starts a sign-in from a page on this origin, and gives the answer. */
				const signIn = (origin: string) =>
					HttpClientRequest.post(address + "/auth/sign-in", {
						headers: { origin },
					}).pipe(
						HttpClientRequest.bodyJson({}),
						Effect.flatMap(HttpClient.execute),
					)
				/** The address that the sign-in provider sends the browser back to. */
				const redirectOf = (origin: string) =>
					Effect.map(
						Effect.flatMap(signIn(origin), Caller.json(AuthApi.SignInStart)),
						(started) => new URL(started.url).searchParams.get("redirect_uri"),
					)
				assert.strictEqual(
					yield* redirectOf(publicOrigin),
					publicOrigin + "/auth/callback/oidc",
				)

				// A streamed message runs a Turn. It waits in the model during the change.
				const slow = yield* bot(asRootBefore, { name: "Slow" })
				const receipt = yield* message(
					asRootBefore,
					slow,
					"Wait for the change",
				)
				const streamed = yield* asRootBefore(
					`/v1/executions/${receipt.executionId}/observe`,
					"GET",
				).pipe(
					Effect.flatMap((response) =>
						Effect.map(response.text, (text) => ({
							status: response.status,
							text,
						})),
					),
					Effect.forkChild,
				)
				yield* Deferred.await(started)

				const current = yield* json(
					SettingsApi.PlatformSettings,
					asRootBefore("/v1/platform/settings", "GET"),
				)
				const changed = yield* json(
					SettingsApi.PlatformSettings,
					asRootBefore("/v1/platform/settings", "PATCH", {
						expectedVersion: current.version,
						publicOrigin: nextOrigin,
					}),
					200,
				)
				assert.strictEqual(changed.publicOrigin, nextOrigin)

				// Sign-in uses the new origin at once, with no restart.
				assert.strictEqual(
					yield* redirectOf(nextOrigin),
					nextOrigin + "/auth/callback/oidc",
				)
				const refused = yield* signIn(publicOrigin)
				assert.strictEqual(refused.status, 403)
				assert.strictEqual(yield* tagOf(refused), "ForbiddenOrigin")
				// Writes from the browser must come from the new origin now.
				const settings = yield* json(
					SettingsApi.OrganizationSettings,
					asRootAfter("/v1/organization/settings", "GET"),
				)
				const write = (send: Send) =>
					send("/v1/organization/settings", "PATCH", {
						expectedVersion: settings.version,
						botMemory: settings.botMemory,
					})
				const oldWrite = yield* write(asRootBefore)
				assert.strictEqual(oldWrite.status, 403)
				assert.strictEqual(yield* tagOf(oldWrite), "ForbiddenOrigin")
				assert.strictEqual((yield* write(asRootAfter)).status, 200)
				// The addresses that OpenBot gives out use the new origin too.
				const metadata = yield* Effect.flatMap(
					HttpClient.get(address + "/v1/apps/client-metadata"),
					Caller.json(Schema.Struct({ client_id: Schema.String })),
				)
				assert.strictEqual(
					metadata.client_id,
					nextOrigin + "/v1/apps/client-metadata",
				)
				// The session from before the change still works.
				assert.strictEqual(
					(yield* asRootAfter("/auth/session", "GET")).status,
					200,
				)

				// The Turn and its stream go on, and end as normal.
				yield* Deferred.succeed(release, undefined)
				const result = yield* Fiber.join(streamed)
				assert.strictEqual(result.status, 200)
				assert.ok(Str.includes('"status":"completed"')(result.text))
				assert.ok(Str.includes("Done after the change")(result.text))
			}),
		{ timeout: 60000 },
	)
})
