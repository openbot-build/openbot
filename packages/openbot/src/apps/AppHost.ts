import {
	App,
	AppConnections,
	Authorization,
	Client,
	Discovery,
	Document,
	Network,
	OAuthAuthorization,
	Store,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { OutboundPolicy } from "../network/OutboundPolicy.ts"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Schema,
	Scope,
} from "effect"
import { ProtocolStores, toStoreError } from "./ProtocolStores.ts"
import type { PgClient } from "@effect/sql-pg"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { Governance } from "./Governance.ts"
import type {
	AppConnections as ConnectionDomain,
	AppIndex,
} from "@openbot-build/domain"
import * as Failures from "../errors/Failures.ts"
import * as HostApp from "./HostApp.ts"
import { Probe } from "./Probe.ts"
import * as Db from "../database/Database.ts"

type AuthorizationError =
	| Authorization.AuthorizationError
	| Network.NetworkError
	| Schema.SchemaError
	| Store.StoreError
	| App.AppError
export type Protection =
	| { readonly requiresAuthorization: false }
	| {
			readonly requiresAuthorization: true
			readonly resource: Authorization.ResourceMetadata
			readonly scopes: ReadonlyArray<string>
			readonly resourceMetadataUrl?: string
	  }
export type BoundApp = Omit<HostApp.Service, "add"> & {
	/** A restricted App and a configuration that the App does not accept keep their own errors. */
	readonly add: (
		input: HostApp.AddRequest,
	) => Effect.Effect<
		HostApp.Added,
		| App.AppError
		| Store.StoreError
		| Discovery.Error
		| AppIndex.AppRestricted
		| ConnectionDomain.ConnectionConfigurationInvalid
	>
	readonly inspectAuthorization: (
		key: Store.ConnectionKey,
	) => Effect.Effect<
		Protection,
		AuthorizationError | ConnectionDomain.ConnectionConfigurationInvalid
	>
}
export class AppNetwork extends Context.Service<
	AppNetwork,
	{
		readonly layer: (
			owner: string,
			origins: ReadonlyArray<string>,
		) => Layer.Layer<Network.Network>
	}
>()("@openbot-build/openbot/apps/AppHost/AppNetwork") {}
export const layerNetwork = Layer.effect(
	AppNetwork,
	Effect.gen(function* () {
		const policy = yield* OutboundPolicy
		return {
			layer: (owner: string, origins: ReadonlyArray<string>) =>
				NodeHttpServer.layerUserNetwork({
					owner,
					allowedOrigins: origins,
					allowAddress: policy.allowAddress,
				}),
		}
	}),
)

/** Build a closed App service for the current owner and invocation policy. */
export class AppHost extends Context.Service<
	AppHost,
	{
		readonly bind: (
			owner: string,
			policy: typeof Client.InvocationPolicy.Service,
		) => BoundApp
	}
>()("@openbot-build/openbot/apps/AppHost") {}

export const make: Effect.Effect<
	typeof AppHost.Service,
	never,
	| ProtocolStores
	| PgClient.PgClient
	| Secrets
	| Discovery.Discovery
	| Discovery.Rules
	| App.ConnectionScopes
	| AppNetwork
	| Crypto.Crypto
	| Probe
	| Governance
> = Effect.gen(function* () {
	const governance = yield* Governance
	const persistent = yield* ProtocolStores
	const db = yield* Db.make
	const secrets = yield* Secrets
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const active = yield* App.ConnectionScopes
	const network = yield* AppNetwork
	const crypto = yield* Crypto.Crypto
	const probe = yield* Probe
	return AppHost.of({
		bind: (owner, policy) => {
			const stores = persistent.bind(owner)
			const flows = stores.flows
			const services = Context.make(Store.AppStore, stores.apps).pipe(
				Context.add(Store.CredentialStore, stores.credentials),
				Context.add(Authorization.FlowStore, flows),
				Context.add(Discovery.Discovery, discovery),
				Context.add(Discovery.Rules, rules),
				Context.add(App.ConnectionScopes, active),
				Context.add(Client.InvocationPolicy, {
					check: (invocation) =>
						governance.check(invocation.connection.cardUrl).pipe(
							Effect.catchTags({
								ExperienceStorageUnavailable: () =>
									Effect.fail(
										Client.ClientError.make({
											reason: "PolicyUnavailable",
											issue: "App restrictions could not be read.",
										}),
									),
								AppRestricted: () =>
									Effect.fail(
										Client.PermissionDenied.make({
											action: invocation.action,
											target: invocation.target,
										}),
									),
							}),
							Effect.andThen(policy.check(invocation)),
						),
				}),
				Context.add(Crypto.Crypto, crypto),
			)
			const keyChecked = (key: Store.ConnectionKey) =>
				key.owner === owner
					? Effect.void
					: Effect.fail(
							Store.StoreError.make({
								reason: "Missing",
								operation: "Owned App connection",
							}),
						)
			const withNetwork = <A, E, R>(
				key: Store.ConnectionKey,
				additional: ReadonlyArray<string>,
				program: Effect.Effect<A, E, R | Network.Network>,
			): Effect.Effect<
				A,
				E | Store.StoreError,
				Exclude<R, Network.Network> | Scope.Scope
			> =>
				Effect.gen(function* () {
					yield* keyChecked(key)
					const connection = yield* stores.apps.get(key)
					const scope = yield* Effect.scope
					const links = yield* Schema.decodeEffect(Schema.Array(Document.Link))(
						[connection.endpoint, ...additional],
					).pipe(
						Failures.replace(
							"OpenBot could not read the network targets of an App connection.",
							() =>
								Store.StoreError.make({
									reason: "Invalid",
									operation: "App network targets",
								}),
						),
					)
					const context = yield* Layer.buildWithScope(
						network.layer(
							owner,
							Arr.map(links, (url) => new URL(url).origin),
						),
						scope,
					)
					return yield* program.pipe(Effect.provideContext(context))
				})
			const appError = (cause: unknown) =>
				HostApp.AppError.make({
					reason: "storage-failed",
					message: "The account's App connections could not be read.",
					cause,
				})
			const host: BoundApp = {
				discover: discovery.resolve,
				listConnections: StoredConnections.list(db, secrets, owner).pipe(
					Effect.map(Arr.map((row) => row.connection)),
					Effect.mapError(appError),
				),
				getConnection: stores.apps.get,
				add: Effect.fn("AppHost.add")(function* (input) {
					yield* keyChecked(input.key)
					yield* governance
						.check(input.candidate.cardUrl)
						.pipe(
							Effect.catchTag("ExperienceStorageUnavailable", (error) =>
								Effect.fail(toStoreError("App restrictions")(error)),
							),
						)
					if (!input.confirmed)
						return yield* App.AppError.make({ reason: "ConfirmationRequired" })
					const current = yield* discovery.refreshCard(input.candidate.cardUrl)
					const prepared = yield* AppConnections.prepare({
						key: input.key,
						previous: input.candidate,
						current,
						remoteIndex: input.remoteIndex,
						values: input.values,
					}).pipe(Effect.provideService(Discovery.Rules, rules))
					const protection = yield* probe.check(prepared)
					const connection = yield* stores.apps.save({
						...prepared,
						connection: {
							...prepared.connection,
							authorization: protection.requiresAuthorization
								? {
										_tag: "PendingAuthorization",
										resource: prepared.connection.endpoint,
										scopes: [],
									}
								: { _tag: "Unprotected" },
						},
					})
					return {
						connection,
						publicHints: {
							cardUrl: current.cardUrl,
							sources: current.sources,
						},
					}
				}),
				open: (input) =>
					Effect.gen(function* () {
						const connection = yield* stores.apps.get(input.key)
						yield* governance.check(connection.cardUrl).pipe(
							Effect.catchTags({
								ExperienceStorageUnavailable: () =>
									Effect.fail(
										Client.ClientError.make({
											reason: "PolicyUnavailable",
											issue: "App restrictions could not be read.",
										}),
									),
								AppRestricted: () =>
									Effect.fail(
										Client.PermissionDenied.make({
											action: "connect",
											target: connection.cardUrl,
										}),
									),
							}),
						)
						return yield* withNetwork(
							input.key,
							[],
							AppConnections.open(input).pipe(Effect.provideContext(services)),
						)
					}),
				revalidate: (input) =>
					keyChecked(input.key).pipe(
						Effect.andThen(
							AppConnections.revalidate(input).pipe(
								Effect.provideContext(services),
							),
						),
					),
				inspectAuthorization: (key) =>
					Effect.scoped(
						Effect.gen(function* () {
							const connection = yield* stores.apps.get(key)
							const protection = yield* probe.check({
								connection: {
									...connection,
									authorization: { _tag: "Unprotected" },
								},
							})
							return yield* Match.value(protection).pipe(
								Match.when({ requiresAuthorization: false }, () =>
									Effect.succeed({ requiresAuthorization: false } as const),
								),
								Match.when({ requiresAuthorization: true }, (protection) =>
									withNetwork(
										key,
										protection.resourceMetadataUrl === undefined
											? []
											: [protection.resourceMetadataUrl],
										OAuthAuthorization.discoverResource({
											resource: connection.endpoint,
											...(protection.resourceMetadataUrl === undefined
												? {}
												: {
														resourceMetadataUrl: protection.resourceMetadataUrl,
													}),
										}).pipe(Effect.provideContext(services)),
									).pipe(
										Effect.map(
											(resource) =>
												({
													requiresAuthorization: true,
													resource,
													scopes: protection.scopes,
													...(protection.resourceMetadataUrl === undefined
														? {}
														: {
																resourceMetadataUrl:
																	protection.resourceMetadataUrl,
															}),
												}) as const,
										),
									),
								),
								Match.exhaustive,
							)
						}),
					),
			}
			return host
		},
	})
})
export const layer = Layer.effect(AppHost, make)
