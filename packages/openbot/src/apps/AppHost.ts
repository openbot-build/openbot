import {
	App,
	AppConnections,
	Authorization,
	Client,
	Discovery,
	Document,
	McpClient,
	Network,
	OAuthAuthorization,
	Store,
} from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { OutboundPolicy } from "../network/OutboundPolicy.ts"
import {
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Redacted,
	Schema,
	Scope,
} from "effect"
import { ProtocolStores } from "./ProtocolStores.ts"
import type { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import { appRecords } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { Governance } from "./Governance.ts"
import type { AppAuthorizationApi, ConnectionsApi } from "@openbot-build/api"
import { ConnectionLocks } from "./ConnectionLocks.ts"

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
export type BoundApp = HostApp.Service & {
	readonly inspectAuthorization: (
		key: Store.ConnectionKey,
	) => Effect.Effect<
		Protection,
		AuthorizationError | ConnectionsApi.ConnectionConfigurationInvalid
	>
	readonly refreshAuthorization: (
		key: Store.ConnectionKey,
	) => Effect.Effect<Store.UserConnection, AuthorizationError>
	readonly revokeAuthorization: (
		key: Store.ConnectionKey,
	) => Effect.Effect<
		AppAuthorizationApi.Revocation,
		AuthorizationError | App.CleanupPending
	>
}
import * as HostApp from "./HostApp.ts"
import { Probe } from "./Probe.ts"
import * as Db from "../database/Database.ts"

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
			flowStore?: typeof Authorization.FlowStore.Service,
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
	| ConnectionLocks
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
	const locks = yield* ConnectionLocks
	return AppHost.of({
		bind: (owner, policy, flowStore) => {
			const stores = persistent.bind(owner)
			const flows = flowStore ?? stores.flows
			const services = Context.make(Store.AppStore, stores.apps).pipe(
				Context.add(Store.CredentialStore, stores.credentials),
				Context.add(Authorization.FlowStore, flows),
				Context.add(Discovery.Discovery, discovery),
				Context.add(Discovery.Rules, rules),
				Context.add(App.ConnectionScopes, active),
				Context.add(Client.InvocationPolicy, {
					check: (invocation) =>
						governance.check(invocation.connection.cardUrl).pipe(
							Effect.mapError(
								() =>
									new Client.PermissionDenied({
										action: invocation.action,
										target: invocation.target,
									}),
							),
							Effect.andThen(policy.check(invocation)),
						),
				}),
				Context.add(Crypto.Crypto, crypto),
			)
			const keyChecked = (key: Store.ConnectionKey) =>
				key.owner === owner
					? Effect.void
					: Effect.fail(
							new Store.StoreError({
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
						Effect.mapError(
							() =>
								new Store.StoreError({
									reason: "Invalid",
									operation: "App network targets",
								}),
						),
					)
					const context = yield* Layer.buildWithScope(
						network.layer(
							owner,
							links.map((url) => new URL(url).origin),
						),
						scope,
					)
					return yield* program.pipe(Effect.provideContext(context))
				})
			const appError = () =>
				new HostApp.AppError({
					reason: "storage-failed",
					message: "The account's App connections could not be read.",
				})
			const withAuthorizationNetwork = <A, E, R>(
				key: Store.ConnectionKey,
				program: Effect.Effect<A, E, R | Network.Network>,
			) =>
				Effect.gen(function* () {
					const connection = yield* stores.apps.get(key)
					const extra = yield* Match.value(connection.authorization).pipe(
						Match.tag("Authorized", (auth) =>
							withNetwork(
								key,
								[
									auth.binding.issuer,
									...(auth.resourceMetadataUrl === undefined
										? []
										: [auth.resourceMetadataUrl]),
								],
								OAuthAuthorization.discover({
									resource: connection.endpoint,
									issuer: auth.binding.issuer,
									...(auth.resourceMetadataUrl === undefined
										? {}
										: { resourceMetadataUrl: auth.resourceMetadataUrl }),
								}).pipe(Effect.provideContext(services)),
							).pipe(
								Effect.map(({ metadata }) => [
									metadata.issuer,
									metadata.token_endpoint,
									...(metadata.revocation_endpoint === undefined
										? []
										: [metadata.revocation_endpoint]),
								]),
							),
						),
						Match.orElse(() => Effect.succeed([])),
					)
					return yield* withNetwork(key, extra, program)
				})

			const pending = (
				key: Store.ConnectionKey,
				stage: App.CleanupPending["stage"],
			) =>
				StoredConnections.update(
					db,
					secrets,
					owner,
					key.connectionId,
					(stored) => ({
						...stored,
						connection: { ...stored.connection, state: "CleanupPending" },
						verification: { _tag: "CleanupPending", stage },
					}),
				).pipe(
					Effect.mapError(
						() =>
							new Store.StoreError({
								reason: "Unavailable",
								operation: "Record App cleanup progress",
							}),
					),
					Effect.andThen(Effect.fail(new App.CleanupPending({ key, stage }))),
				)
			const revoke = (key: Store.ConnectionKey) =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* keyChecked(key)
						yield* stores.apps.update({
							key,
							change: (connection) => ({ ...connection, state: "Disabled" }),
						})
						yield* active.close(key)
						const result = yield* withAuthorizationNetwork(
							key,
							OAuthAuthorization.revoke(key).pipe(
								Effect.provideContext(services),
							),
						).pipe(Effect.catch(() => pending(key, "Credentials")))
						yield* stores
							.clearFlows(key.connectionId)
							.pipe(Effect.catch(() => pending(key, "Credentials")))
						return result
					}),
				)
			const host: BoundApp = {
				discover: discovery.resolve,
				list: db
					.select()
					.from(appRecords)
					.where(eq(appRecords.owner, owner))
					.pipe(
						Effect.flatMap((rows) =>
							Effect.forEach(rows, (row) =>
								Schema.decodeEffect(StoredConnections.appCodec)(row.body),
							),
						),
						Effect.mapError(appError),
					),
				get: stores.apps.getApp,
				listConnections: StoredConnections.list(db, secrets, owner).pipe(
					Effect.map((rows) => rows.map((row) => row.connection)),
					Effect.mapError(appError),
				),
				getConnection: stores.apps.get,
				add: Effect.fn("AppHost.add")(function* (input) {
					yield* keyChecked(input.key)
					yield* governance
						.check(input.candidate.cardUrl)
						.pipe(
							Effect.mapError(
								() => new App.AppError({ reason: "Unavailable" }),
							),
						)
					if (!input.confirmed)
						return yield* new App.AppError({ reason: "ConfirmationRequired" })
					const current = yield* discovery.refreshCard(input.candidate.cardUrl)
					yield* Match.value(
						rules.compare({ previous: input.candidate, current }),
					).pipe(
						Match.tag("NeedsRevalidation", () =>
							Effect.fail(new App.AppError({ reason: "CandidateChanged" })),
						),
						Match.orElse(() => Effect.void),
					)
					const configured = yield* rules.configureEndpoint({
						candidate: current,
						index: input.remoteIndex,
						values: input.values,
					})
					const connection: Store.UserConnection = {
						...input.key,
						cardUrl: current.cardUrl,
						endpoint: configured.url,
						remoteIndex: configured.remoteIndex,
						configuration: Redacted.make(input.values),
						headers: Redacted.make(configured.headers),
						state: "Enabled",
						authorization: { _tag: "Unprotected" },
					}
					const protection = yield* probe
						.check({
							app: {
								cardUrl: current.cardUrl,
								card: current.card,
								sources: current.sources,
							},
							connection,
						})
						.pipe(
							Effect.mapError(
								() => new App.AppError({ reason: "Unavailable" }),
							),
						)
					return yield* AppConnections.add({
						...input,
						candidate: current,
						requiresAuthorization: protection.requiresAuthorization,
					}).pipe(Effect.provideContext(services))
				}),
				beginAuthorization: (input) =>
					Effect.scoped(
						withNetwork(
							input.key,
							[
								input.issuer,
								input.clientId,
								...(input.resourceMetadataUrl === undefined
									? []
									: [input.resourceMetadataUrl]),
							],
							OAuthAuthorization.begin(input).pipe(
								Effect.provideContext(services),
							),
						),
					),
				completeAuthorization: (input) =>
					Effect.scoped(
						Effect.gen(function* () {
							const flow = yield* flows.get(input)
							return yield* withNetwork(
								input.key,
								[flow.metadata.issuer, flow.metadata.token_endpoint],
								OAuthAuthorization.complete(input).pipe(
									Effect.provideContext(services),
								),
							)
						}),
					),
				open: (input) =>
					Effect.gen(function* () {
						const connection = yield* stores.apps.get(input.key)
						yield* governance.check(connection.cardUrl).pipe(
							Effect.mapError(
								() =>
									new Client.PermissionDenied({
										action: "connect",
										target: connection.cardUrl,
									}),
							),
						)
						return yield* withNetwork(
							input.key,
							[],
							McpClient.open({ ...input, eagerLists: false }).pipe(
								Effect.provideContext(services),
							),
						)
					}),
				setEnabled: ({ key, enabled }) =>
					keyChecked(key).pipe(
						Effect.andThen(
							StoredConnections.update(
								db,
								secrets,
								owner,
								key.connectionId,
								(stored) => ({
									...stored,
									verification: null,
									connection: {
										...stored.connection,
										state: enabled
											? stored.connection.state === "Disabled"
												? "Enabled"
												: stored.connection.state
											: "Disabled",
									},
								}),
							),
						),
						Effect.tap(() => active.close(key)),
						Effect.map((row) => row.connection),
						Effect.mapError(
							() =>
								new Store.StoreError({
									reason: "Unavailable",
									operation: "Update owned App state",
								}),
						),
					),
				remove: (key) =>
					Effect.gen(function* () {
						yield* revoke(key)
						yield* stores.apps
							.delete(key)
							.pipe(Effect.catch(() => pending(key, "Connection")))
						return { _tag: "Removed", key } as const
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
							const app = yield* stores.apps.getApp(connection.cardUrl)
							const protection = yield* probe.check({
								app,
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
				refreshAuthorization: (key) =>
					Effect.scoped(
						withAuthorizationNetwork(
							key,
							OAuthAuthorization.refresh(key).pipe(
								Effect.provideContext(services),
							),
						),
					),
				revokeAuthorization: revoke,
			}
			return {
				...host,
				refreshAuthorization: (key) =>
					locks.withConnection(key, host.refreshAuthorization(key)),
				revokeAuthorization: (key) =>
					locks.withConnection(key, host.revokeAuthorization(key)),
				remove: (key) => locks.withConnection(key, host.remove(key)),
				setEnabled: (input) =>
					locks.withConnection(input.key, host.setEnabled(input)),
			}
		},
	})
})
export const layer = Layer.effect(AppHost, make)
