import { sameConnection } from "../discovery/CatalogDiscovery.ts"
import {
	Option,
	Clock,
	HashMap,
	HashSet,
	Effect,
	Equal,
	Exit,
	Layer,
	Redacted,
	Ref,
	Scope,
	Match,
	Schema,
} from "effect"
import * as McpClient from "./McpClient.ts"
import * as Client from "./Client.ts"
import * as OAuthAuthorization from "./OAuthAuthorization.ts"

import * as Discovery from "../discovery/Discovery.ts"
import * as Store from "./Store.ts"
import {
	AppError,
	CleanupPending,
	ConnectionScopes,
	type RevalidationOptions,
} from "./App.ts"

export const layerConnectionScopes = Layer.effect(
	ConnectionScopes,
	Effect.gen(function* () {
		const state = yield* Ref.make(
			HashMap.empty<
				readonly [string, string],
				HashSet.HashSet<Scope.Closeable>
			>(),
		)
		return ConnectionScopes.of({
			// The scope and its clean-up go in together, so an interruption cannot leave a scope in the map.
			register: Effect.fn("ConnectionScopes.register")(function* ({
				key,
				scope,
			}) {
				const id = [key.owner, key.connectionId] as const
				yield* Ref.update(
					state,
					HashMap.modifyAt(id, (scopes) =>
						Option.some(
							HashSet.add(
								Option.getOrElse(scopes, () =>
									HashSet.empty<Scope.Closeable>(),
								),
								scope,
							),
						),
					),
				)
				yield* Scope.addFinalizer(
					scope,
					Ref.update(
						state,
						HashMap.modifyAt(id, (scopes) =>
							scopes.pipe(
								Option.map(HashSet.remove(scope)),
								Option.filter((rest) => HashSet.size(rest) > 0),
							),
						),
					),
				)
				return { close: Scope.close(scope, Exit.void) }
			}, Effect.uninterruptible),
			close: Effect.fn("ConnectionScopes.close")(function* (key) {
				const id = [key.owner, key.connectionId] as const
				const scopes = yield* Ref.modify(
					state,
					(old) => [HashMap.get(old, id), HashMap.remove(old, id)] as const,
				)
				yield* Effect.forEach(
					Option.getOrElse(scopes, () => HashSet.empty<Scope.Closeable>()),
					(scope) => Scope.close(scope, Exit.void),
					{ discard: true, concurrency: "unbounded" },
				)
			}),
		})
	}),
)

/** Build one connection from the card that was checked for this request. */
export const prepare = Effect.fn("App.prepare")(function* (options: {
	readonly key: Store.ConnectionKey
	readonly previous: Discovery.Candidate
	readonly current: Discovery.Candidate
	readonly remoteIndex: number
	readonly values: Readonly<Record<string, string>>
}) {
	const rules = yield* Discovery.Rules
	const { previous, current } = options
	if (rules.compare({ previous, current })._tag === "NeedsRevalidation")
		return yield* AppError.make({ reason: "CandidateChanged" })
	const configured = yield* rules.configureEndpoint({
		candidate: current,
		index: options.remoteIndex,
		values: options.values,
	})
	return {
		app: Store.AppRecord.make({
			cardUrl: current.cardUrl,
			card: current.card,
			sources: current.sources,
		}),
		connection: Store.UserConnection.make({
			...options.key,
			cardUrl: current.cardUrl,
			endpoint: configured.url,
			remoteIndex: configured.remoteIndex,
			configuration: Redacted.make(options.values),
			headers: Redacted.make(configured.headers),
			state: "Enabled",
			authorization: { _tag: "Unprotected" },
		}),
	}
})

export const add = Effect.fn("App.add")(function* (options: {
	readonly key: Store.ConnectionKey
	readonly candidate: Discovery.Candidate
	readonly remoteIndex: number
	readonly values: Readonly<Record<string, string>>
	readonly confirmed: boolean
	readonly requiresAuthorization: boolean
}) {
	if (!options.confirmed)
		return yield* AppError.make({
			reason: "ConfirmationRequired",
		})
	const discovery = yield* Discovery.Discovery
	const current = yield* discovery.refreshCard(options.candidate.cardUrl)
	const prepared = yield* prepare({
		...options,
		previous: options.candidate,
		current,
	})
	const store = yield* Store.AppStore
	const connection = yield* store.save({
		...prepared,
		connection: {
			...prepared.connection,
			authorization: options.requiresAuthorization
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
})

export const current = (key: Store.ConnectionKey) =>
	Store.AppStore.use((store) => store.get(key))

/** The Enabled state is checked right before every request, also on an existing client. */
export const usable = Effect.fn("App.usable")(function* (
	key: Store.ConnectionKey,
) {
	const connection = yield* current(key)
	if (connection.state !== "Enabled")
		return yield* AppError.make({ reason: "Unavailable" })
	return connection
})

/** Check authorization values without making a storage adapter. */
export const authorizationToken = Effect.fn("App.authorizationToken")(
	function* (
		connection: Store.UserConnection,
		credential: Option.Option<Store.Credential>,
	) {
		if (connection.state !== "Enabled")
			return yield* AppError.make({ reason: "Unavailable" })
		return yield* Match.value(connection.authorization).pipe(
			Match.tag("Unprotected", () =>
				Effect.succeed(Option.none<Redacted.Redacted<string>>()),
			),
			Match.tag("Authorized", (auth) =>
				Effect.gen(function* () {
					if (
						auth.binding.owner !== connection.owner ||
						auth.binding.connectionId !== connection.connectionId ||
						auth.binding.resource !== connection.endpoint
					)
						return yield* Client.ClientError.make({
							reason: "ConnectionChanged",
							issue: "Credential binding no longer matches this connection",
						})
					if (Option.isNone(credential))
						return yield* Store.StoreError.make({
							reason: "Missing",
							operation: "Connection credential",
						})
					const value = credential.value
					if (
						!Schema.toEquivalence(Store.CredentialBinding)(
							auth.binding,
							value.binding,
						)
					)
						return yield* Client.ClientError.make({
							reason: "ConnectionChanged",
							issue: "Credential binding no longer matches this connection",
						})
					if (
						value.expiresAt !== undefined &&
						value.expiresAt <= (yield* Clock.currentTimeMillis)
					)
						return yield* Client.AuthorizationRequired.make({
							reason: "Expired",
							scopes: value.scopes,
						})
					return Option.some(value.accessToken)
				}),
			),
			Match.tag("ScopeRequired", (auth) =>
				Effect.fail(
					Client.AuthorizationRequired.make({
						reason: "InsufficientScope",
						scopes: auth.scopes,
					}),
				),
			),
			Match.tag("PendingAuthorization", (auth) =>
				Effect.fail(
					Client.AuthorizationRequired.make({
						reason: "Pending",
						scopes: auth.scopes,
					}),
				),
			),
			Match.tag("AuthorizationFailed", () =>
				Effect.fail(
					Client.AuthorizationRequired.make({ reason: "Pending", scopes: [] }),
				),
			),
			Match.exhaustive,
		)
	},
)

export const layerPolicy = (
	check: (
		invocation: Client.Invocation,
	) => Effect.Effect<void, Client.PermissionDenied | Client.ClientError>,
) => Layer.succeed(Client.InvocationPolicy, { check })

/** Open a saved connection with current state and credentials on every request. */
export const open = Effect.fn("App.open")(function* (
	options: Pick<
		McpClient.OpenOptions,
		"key" | "clientInfo" | "capabilities" | "inputs"
	>,
) {
	const apps = yield* Store.AppStore
	const credentials = yield* Store.CredentialStore
	const policy = yield* Client.InvocationPolicy
	const active = yield* ConnectionScopes
	const initial = yield* usable(options.key)
	const sameHeaders = Schema.toEquivalence(
		Schema.Record(Schema.String, Schema.String),
	)
	const current = Effect.gen(function* () {
		const connection = yield* apps.get(options.key)
		if (connection.state !== "Enabled")
			return yield* AppError.make({ reason: "Unavailable" })
		if (
			connection.owner !== initial.owner ||
			connection.connectionId !== initial.connectionId ||
			connection.endpoint !== initial.endpoint ||
			connection.cardUrl !== initial.cardUrl ||
			!sameHeaders(
				Redacted.value(connection.headers),
				Redacted.value(initial.headers),
			)
		)
			return yield* Client.ClientError.make({
				reason: "ConnectionChanged",
				issue: "Open a client after explicit revalidation",
			})
		const auth = connection.authorization
		const credential =
			auth._tag === "Authorized"
				? Option.some(
						yield* credentials.get({
							binding: auth.binding,
							reference: auth.credentialRef,
						}),
					)
				: Option.none<Store.Credential>()
		return {
			connection,
			token: yield* authorizationToken(connection, credential),
		}
	})
	return yield* McpClient.open({
		...options,
		endpoint: initial.endpoint,
		headers: initial.headers,
		readToken: current.pipe(Effect.map((value) => value.token)),
		check: (request) =>
			current.pipe(
				Effect.flatMap(({ connection }) =>
					policy.check({ ...request, connection }),
				),
			),
		registerScope: (scope) => active.register({ key: options.key, scope }),
	})
})

/** Save the stop before releasing anything, so a failure cannot make the connection callable again. */
export const remove = Effect.fn("App.remove")(function* (
	key: Store.ConnectionKey,
) {
	const store = yield* Store.AppStore
	yield* store.update({
		key,
		change: (connection) => ({ ...connection, state: "Disabled" }),
	})
	const active = yield* ConnectionScopes
	const pending = (stage: CleanupPending["stage"]) =>
		store
			.update({
				key,
				change: (connection) => ({
					...connection,
					state: "CleanupPending",
				}),
			})
			.pipe(
				Effect.andThen(
					Effect.fail(
						CleanupPending.make({
							key,
							stage,
						}),
					),
				),
			)
	yield* active.close(key)
	yield* OAuthAuthorization.revoke(key).pipe(
		Effect.tapError((error) =>
			Effect.logWarning("Could not revoke the connection credentials", error),
		),
		Effect.catch(() => pending("Credentials")),
	)
	yield* store.delete(key).pipe(
		Effect.tapError((error) =>
			Effect.logWarning("Could not delete the connection", error),
		),
		Effect.catch(() => pending("Connection")),
	)
	return { _tag: "Removed", key } as const
})

const sameConfiguration = Schema.toEquivalence(
	Schema.Record(Schema.String, Schema.String),
)

export const revalidate = Effect.fn("App.revalidate")(function* (
	options: RevalidationOptions,
) {
	const store = yield* Store.AppStore
	const connection = yield* store.get(options.key)
	if (connection.state === "Disabled" || connection.state === "CleanupPending")
		return yield* AppError.make({ reason: "Unavailable" })
	if (connection.cardUrl !== options.candidate.cardUrl)
		return yield* AppError.make({ reason: "CandidateChanged" })
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const candidate = yield* discovery.refreshCard(connection.cardUrl)
	const service = yield* store.getApp(connection.cardUrl)
	const remoteIndex = options.remoteIndex ?? connection.remoteIndex
	const values = options.values ?? Redacted.value(connection.configuration)
	const endpoint = yield* Effect.result(
		rules.configureEndpoint({
			candidate,
			index: remoteIndex,
			values,
		}),
	)
	const auth = connection.authorization
	const sensitive =
		connection.state === "NeedsRevalidation" ||
		Match.value(endpoint).pipe(
			Match.tagsExhaustive({
				Failure: () => true,
				Success: ({ success }) =>
					success.url !== connection.endpoint ||
					!sameConfiguration(
						success.headers,
						Redacted.value(connection.headers),
					),
			}),
		) ||
		remoteIndex !== connection.remoteIndex ||
		!sameConnection(
			service.card.remotes?.[connection.remoteIndex],
			candidate.card.remotes?.[remoteIndex],
		) ||
		!sameConfiguration(values, Redacted.value(connection.configuration)) ||
		Match.value(auth).pipe(
			Match.tag("Unprotected", () => Option.isSome(options.authorization)),
			Match.tag("Authorized", (auth) =>
				Option.match(options.authorization, {
					onNone: () => true,
					onSome: (required) =>
						auth.binding.issuer !== required.issuer ||
						!Equal.equals(
							HashSet.fromIterable(auth.scopes),
							HashSet.fromIterable(required.scopes),
						),
				}),
			),
			Match.orElse(() => true),
		)
	if (!sensitive) {
		yield* store.updateApp(
			Store.AppRecord.make({
				cardUrl: candidate.cardUrl,
				card: candidate.card,
				sources: candidate.sources,
			}),
		)
		return {
			_tag: "DescriptionUpdated",
			connection,
			candidate,
		} as const
	}
	yield* store.update({
		key: options.key,
		change: (old) =>
			old.state === "Enabled" || old.state === "NeedsRevalidation"
				? { ...old, state: "NeedsRevalidation" }
				: old,
	})
	const active = yield* ConnectionScopes
	yield* active.close(options.key)
	yield* store.updateApp(
		Store.AppRecord.make({
			cardUrl: candidate.cardUrl,
			card: candidate.card,
			sources: candidate.sources,
		}),
	)
	if (!options.confirmed)
		return {
			_tag: "NeedsRevalidation",
			key: options.key,
			candidate,
		} as const
	if (
		rules.compare({ previous: options.candidate, current: candidate })._tag ===
		"NeedsRevalidation"
	)
		return yield* AppError.make({ reason: "CandidateChanged" })
	const configured = yield* Effect.fromResult(endpoint)
	const credentials = yield* Store.CredentialStore
	yield* credentials.deleteConnection(options.key)
	const updated = yield* store.update({
		key: options.key,
		change: (old) =>
			old.state === "NeedsRevalidation"
				? {
						...old,
						state: "Enabled",
						endpoint: configured.url,
						remoteIndex: configured.remoteIndex,
						configuration: Redacted.make(values),
						headers: Redacted.make(configured.headers),
						authorization: Option.match(options.authorization, {
							onNone: () => ({ _tag: "Unprotected" }) as const,
							onSome: ({ scopes }) =>
								({
									_tag: "PendingAuthorization",
									resource: configured.url,
									scopes,
								}) as const,
						}),
					}
				: old,
	})
	if (updated.state !== "Enabled" || updated.endpoint !== configured.url)
		return yield* AppError.make({ reason: "Unavailable" })
	return { _tag: "Revalidated", connection: updated, candidate } as const
})
