import {
	AppAuthorizationApi,
	DeveloperApi as Api,
} from "@openbot-build/platform-api"
import {
	App,
	Authorization,
	Client,
	McpClient,
	Network,
	Document,
	OAuthAuthorization,
	Store,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Option,
	Ref,
	Schema,
	Scope,
} from "effect"
import { AppNetwork } from "./AppHost.ts"
import { DeveloperRepository } from "./DeveloperRepository.ts"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import { pages } from "./Capabilities.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"

export type Execution =
	| {
			readonly _tag: "Completed"
			readonly stages: ReadonlyArray<Api.TestStage>
	  }
	| {
			readonly _tag: "Failed"
			readonly stages: ReadonlyArray<Api.TestStage>
			readonly reason: string
	  }
	| {
			readonly _tag: "AwaitingAuthorization"
			readonly stages: ReadonlyArray<Api.TestStage>
			readonly issuers: ReadonlyArray<string>
			readonly scopes: ReadonlyArray<string>
			readonly resourceMetadataUrl?: string
	  }
export class DeveloperTestRuntime extends Context.Service<
	DeveloperTestRuntime,
	{
		readonly execute: (
			owner: string,
			id: string,
		) => Effect.Effect<Execution, Api.Failure>
		readonly begin: (
			owner: string,
			id: string,
			input: {
				readonly issuer?: string
				readonly scopes: ReadonlyArray<string>
			},
		) => Effect.Effect<Api.TestAuthorization, Api.Failure>
		readonly complete: (
			owner: string,
			id: string,
			flowId: string,
			callback: string,
		) => Effect.Effect<void, Api.Failure>
		readonly revoke: (
			owner: string,
			id: string,
		) => Effect.Effect<AppAuthorizationApi.Revocation["_tag"], Api.Failure>
		readonly clear: (
			owner: string,
			id: string,
		) => Effect.Effect<void, Api.Failure>
	}
>()("@openbot-build/platform/apps/DeveloperTestRuntime") {}
const policy = Client.InvocationPolicy.of({
	check: (invocation) =>
		Schema.is(Client.ListAction)(invocation.action)
			? Effect.void
			: Effect.fail(
					new Client.PermissionDenied({
						action: invocation.action,
						target: invocation.target,
					}),
				),
})
const uncheckedLists: ReadonlyArray<Api.TestStage> = (
	["tools", "resources", "resourceTemplates", "prompts"] as const
).map((name) => ({ name, status: "NotChecked", items: [], reason: null }))
const failure = (reason: string) => Api.DeveloperConflict.make({ reason })

export const make = (
	publicOrigin: string,
): Effect.Effect<
	typeof DeveloperTestRuntime.Service,
	never,
	| DeveloperTestStores
	| DeveloperRepository
	| AppNetwork
	| Crypto.Crypto
	| App.ConnectionScopes
	| DeveloperAccess
> =>
	Effect.gen(function* () {
		const stores = yield* DeveloperTestStores
		const records = yield* DeveloperRepository
		const network = yield* AppNetwork
		const crypto = yield* Crypto.Crypto
		const active = yield* App.ConnectionScopes
		const access = yield* DeveloperAccess
		const withNetwork = <A, E, R>(
			owner: string,
			id: string,
			extra: ReadonlyArray<string>,
			program: Effect.Effect<
				A,
				E,
				| R
				| Network.Network
				| Store.AppStore
				| Store.CredentialStore
				| Authorization.FlowStore
				| App.ConnectionScopes
				| Client.InvocationPolicy
				| Crypto.Crypto
			>,
		): Effect.Effect<
			A,
			E | Api.Failure | Store.StoreError,
			| Exclude<
					R,
					| Network.Network
					| Store.AppStore
					| Store.CredentialStore
					| Authorization.FlowStore
					| App.ConnectionScopes
					| Client.InvocationPolicy
					| Crypto.Crypto
			  >
			| Scope.Scope
		> =>
			Effect.gen(function* () {
				const bound = stores.bind(owner, id)
				const connection = yield* bound.apps.get({ owner, connectionId: id })
				const links = yield* Schema.decodeEffect(Schema.Array(Document.Link))([
					connection.endpoint,
					...extra,
				]).pipe(
					Effect.mapError(() =>
						Api.DeveloperInputInvalid.make({
							message: "Test network targets must be valid HTTPS URLs.",
						}),
					),
				)
				const context = yield* Layer.buildWithScope(
					network.layer(
						owner,
						links.map((url) => new URL(url).origin),
					),
					yield* Effect.scope,
				)
				return yield* program.pipe(
					Effect.provideContext(
						context.pipe(
							Context.add(Store.AppStore, bound.apps),
							Context.add(Store.CredentialStore, bound.credentials),
							Context.add(Authorization.FlowStore, bound.flows),
							Context.add(App.ConnectionScopes, active),
							Context.add(
								Client.InvocationPolicy,
								Client.InvocationPolicy.of({
									check: (invocation) =>
										Effect.gen(function* () {
											const test = yield* records.tests.get(id)
											if (
												test.owner !== owner ||
												test.value.status !== "Running" ||
												test.value.expiresAt <= (yield* Clock.currentTimeMillis)
											)
												return yield* Api.DeveloperForbidden.make({})
											yield* access.authorize(owner, test.value.cardUrl, true)
											yield* policy.check(invocation)
										}).pipe(
											Effect.mapError(
												() =>
													new Client.PermissionDenied({
														action: invocation.action,
														target: invocation.target,
													}),
											),
										),
								}),
							),
							Context.add(Crypto.Crypto, crypto),
						),
					),
				)
			})
		return DeveloperTestRuntime.of({
			execute: (owner, id) =>
				Effect.scoped(
					withNetwork(
						owner,
						id,
						[],
						Effect.gen(function* () {
							const client = yield* McpClient.open({
								key: { owner, connectionId: id },
								clientInfo: {
									name: "OpenBot Developer Center",
									version: "1.0.0",
								},
								capabilities: {},
								eagerLists: false,
							})
							let stages: ReadonlyArray<Api.TestStage> = [
								{
									name: "negotiation",
									status: "Passed",
									items: [],
									reason: null,
								},
							]
							const partial = yield* Ref.make<ReadonlyArray<unknown>>([])
							/** Read every page, and keep the items read so far for a partial result. */
							const collect = <A>(
								page: (cursor?: string) => Effect.Effect<
									{
										readonly values: ReadonlyArray<A>
										readonly nextCursor?: string | undefined
									},
									Client.Error
								>,
							) =>
								pages<A>((cursor) =>
									page(cursor).pipe(
										Effect.tap((page) =>
											Ref.update(partial, (values) => [
												...values,
												...page.values,
											]),
										),
									),
								)
							const progress = (stages: ReadonlyArray<Api.TestStage>) =>
								records.transaction(
									"test:" + id,
									Effect.gen(function* () {
										const record = yield* records.tests.get(id)
										if (
											record.owner !== owner ||
											record.value.status !== "Running"
										)
											return
										yield* records.tests.put(id, owner, record.value.cardUrl, {
											...record,
											value: {
												...record.value,
												stages: [
													...record.value.stages.filter(
														(stage) => stage.name === "configuration",
													),
													...stages,
												],
											},
										})
									}),
								)
							yield* progress(stages)
							const lists = [
								{
									name: "tools" as const,
									advertised: client.discovery.capabilities.tools !== undefined,
									read: () =>
										collect((cursor) =>
											client
												.listTools({
													...(cursor === undefined ? {} : { cursor }),
													source: "host",
													singlePage: true,
												})
												.pipe(
													Effect.map((page) => ({
														values: page.tools,
														nextCursor: page.nextCursor,
													})),
												),
										),
								},
								{
									name: "resources" as const,
									advertised:
										client.discovery.capabilities.resources !== undefined,
									read: () =>
										collect((cursor) =>
											client
												.listResources(cursor, "host", { singlePage: true })
												.pipe(
													Effect.map((page) => ({
														values: page.resources,
														nextCursor: page.nextCursor,
													})),
												),
										),
								},
								{
									name: "resourceTemplates" as const,
									advertised:
										client.discovery.capabilities.resources !== undefined,
									read: () =>
										collect((cursor) =>
											client
												.listResourceTemplates(cursor, "host", {
													singlePage: true,
												})
												.pipe(
													Effect.map((page) => ({
														values: page.resourceTemplates,
														nextCursor: page.nextCursor,
													})),
												),
										),
								},
								{
									name: "prompts" as const,
									advertised:
										client.discovery.capabilities.prompts !== undefined,
									read: () =>
										collect((cursor) =>
											client
												.listPrompts(cursor, "host", { singlePage: true })
												.pipe(
													Effect.map((page) => ({
														values: page.prompts,
														nextCursor: page.nextCursor,
													})),
												),
										),
								},
							]
							let failed = false
							for (const list of lists) {
								if (failed) {
									stages = [
										...stages,
										{
											name: list.name,
											status: "NotChecked",
											items: [],
											reason: null,
										},
									]
									yield* progress(stages)
									continue
								}
								if (!list.advertised) {
									stages = [
										...stages,
										{
											name: list.name,
											status: "NotAdvertised",
											items: [],
											reason: null,
										},
									]
									yield* progress(stages)
									continue
								}
								yield* Ref.set(partial, [])
								const result = yield* list
									.read()
									.pipe(
										Effect.flatMap(
											Schema.decodeUnknownEffect(
												Schema.Array(Schema.JsonObject),
											),
										),
										Effect.result,
									)
								const read = yield* Ref.get(partial)
								const stage: Api.TestStage = Match.value(result).pipe(
									Match.tagsExhaustive({
										Success: ({ success }) => ({
											name: list.name,
											status: "Passed" as const,
											items: success,
											reason: null,
										}),
										Failure: () => ({
											name: list.name,
											status: "Failed" as const,
											items: Schema.decodeUnknownOption(
												Schema.Array(Schema.JsonObject),
											)(read).pipe(Option.getOrElse(() => [])),
											reason: "CapabilityListIncomplete",
										}),
									}),
								)
								failed = stage.status === "Failed"
								stages = [...stages, stage]
								yield* progress(stages)
							}
							return failed
								? {
										_tag: "Failed" as const,
										stages,
										reason: "CapabilityListIncomplete",
									}
								: { _tag: "Completed" as const, stages }
						}),
					),
				).pipe(
					Effect.catchTag("AuthorizationRequired", (error) =>
						Effect.scoped(
							withNetwork(
								owner,
								id,
								error.resourceMetadataUrl === undefined
									? []
									: [error.resourceMetadataUrl],
								Effect.gen(function* () {
									const connection = yield* stores
										.bind(owner, id)
										.apps.get({ owner, connectionId: id })
									const resource = yield* OAuthAuthorization.discoverResource({
										resource: connection.endpoint,
										...(error.resourceMetadataUrl === undefined
											? {}
											: { resourceMetadataUrl: error.resourceMetadataUrl }),
									})
									return {
										_tag: "AwaitingAuthorization" as const,
										stages: [
											{
												name: "negotiation" as const,
												status: "NotChecked" as const,
												items: [],
												reason: "AuthorizationRequired",
											},
											...uncheckedLists,
										],
										issuers: resource.authorization_servers,
										scopes:
											error.scopes.length > 0
												? error.scopes
												: (resource.scopes_supported ?? []),
										...(error.resourceMetadataUrl === undefined
											? {}
											: { resourceMetadataUrl: error.resourceMetadataUrl }),
									}
								}),
							),
						),
					),
					Effect.catch((error) =>
						Effect.succeed<Execution>({
							_tag: "Failed",
							stages: [
								{
									name: "negotiation",
									status: "Failed",
									items: [],
									reason: "ConnectionFailed",
								},
								...uncheckedLists,
							],
							reason: error._tag,
						}),
					),
				),
			begin: (owner, id, input) =>
				Effect.gen(function* () {
					const test = yield* records.tests.get(id)
					if (test.owner !== owner) return yield* Api.DeveloperNotFound.make({})
					const issuer = yield* Option.fromNullishOr(input.issuer).pipe(
						Option.orElse(() =>
							test.value.issuers.length === 1
								? Arr.head(test.value.issuers)
								: Option.none(),
						),
						Option.filter((issuer) => test.value.issuers.includes(issuer)),
						Effect.fromOption,
						Effect.mapError(() => failure("SelectDeclaredIssuer")),
					)
					const scopes =
						input.scopes.length === 0
							? test.value.requestedScopes
							: input.scopes
					const pending = yield* Effect.scoped(
						withNetwork(
							owner,
							id,
							[
								issuer,
								publicOrigin,
								...(test.resourceMetadataUrl === undefined
									? []
									: [test.resourceMetadataUrl]),
							],
							OAuthAuthorization.begin({
								key: { owner, connectionId: id },
								issuer,
								clientId: publicOrigin + "/v1/apps/client-metadata",
								redirectUri: publicOrigin + "/auth/developer/apps/callback",
								scopes,
								...(test.resourceMetadataUrl === undefined
									? {}
									: { resourceMetadataUrl: test.resourceMetadataUrl }),
							}),
						),
					).pipe(Effect.mapError(() => failure("AuthorizationCouldNotStart")))
					const flow = yield* records.flows.get(pending.flowId)
					const value: Api.TestAuthorization = {
						...flow.value,
						authorizationUrl: pending.authorizationUrl,
					}
					yield* records.flows.put(value.flowId, owner, id, { ...flow, value })
					return value
				}),
			complete: (owner, id, flowId, callback) =>
				Effect.gen(function* () {
					const bound = stores.bind(owner, id)
					const flow = yield* bound.flows
						.get({ key: { owner, connectionId: id }, flowId })
						.pipe(
							Effect.mapError(() => failure("AuthorizationFlowUnavailable")),
						)
					yield* Effect.scoped(
						withNetwork(
							owner,
							id,
							[flow.metadata.issuer, flow.metadata.token_endpoint],
							OAuthAuthorization.complete({
								key: { owner, connectionId: id },
								flowId,
								callbackUrl: callback,
							}),
						),
					).pipe(
						Effect.mapError(() => failure("AuthorizationCouldNotComplete")),
					)
				}),
			revoke: (owner, id) =>
				Effect.gen(function* () {
					const bound = stores.bind(owner, id)
					const found = yield* bound.apps.get({ owner, connectionId: id }).pipe(
						Effect.asSome,
						Effect.catchTag("StoreError", (error) =>
							error.reason === "Missing"
								? Effect.succeedNone
								: Effect.fail(error),
						),
						Effect.mapError(() => failure("TestCleanupPending")),
					)
					if (Option.isNone(found)) return "LocalOnly" as const
					const connection = found.value
					yield* bound.apps
						.update({
							key: connection,
							change: (current) => ({ ...current, state: "Disabled" }),
						})
						.pipe(Effect.mapError(() => failure("TestCleanupPending")))
					yield* active.close(connection)
					return yield* Match.value(connection.authorization).pipe(
						Match.tag("Authorized", (auth) =>
							Effect.scoped(
								withNetwork(
									owner,
									id,
									[
										auth.binding.issuer,
										...(auth.resourceMetadataUrl === undefined
											? []
											: [auth.resourceMetadataUrl]),
									],
									Effect.gen(function* () {
										const discovered = yield* OAuthAuthorization.discover({
											resource: connection.endpoint,
											issuer: auth.binding.issuer,
											...(auth.resourceMetadataUrl === undefined
												? {}
												: { resourceMetadataUrl: auth.resourceMetadataUrl }),
										})
										return yield* withNetwork(
											owner,
											id,
											[
												auth.binding.issuer,
												discovered.metadata.token_endpoint,
												...(discovered.metadata.revocation_endpoint ===
												undefined
													? []
													: [discovered.metadata.revocation_endpoint]),
												...(auth.resourceMetadataUrl === undefined
													? []
													: [auth.resourceMetadataUrl]),
											],
											OAuthAuthorization.revokeRemote(connection).pipe(
												Effect.map((result) => result._tag),
											),
										)
									}),
								),
							),
						),
						Match.orElse(() => Effect.succeed("LocalOnly" as const)),
						Effect.mapError(() => failure("RemoteRevocationPending")),
					)
				}),
			clear: (owner, id) =>
				stores
					.bind(owner, id)
					.clear.pipe(Effect.mapError(() => failure("LocalCleanupPending"))),
		})
	})
export const layer = (publicOrigin: string) =>
	Layer.effect(DeveloperTestRuntime, make(publicOrigin))
