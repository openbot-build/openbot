import {
	Option,
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
import * as OAuthAuthorization from "./OAuthAuthorization.ts"

import * as Discovery from "../discovery/Discovery.ts"
import * as Store from "./Store.ts"
import * as Document from "../Document.ts"
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
			HashMap.empty<string, HashSet.HashSet<Scope.Closeable>>(),
		)
		return ConnectionScopes.of({
			register: Effect.fn("ConnectionScopes.register")(function* ({
				key,
				scope,
			}) {
				const id = JSON.stringify([key.owner, key.connectionId])
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
			}),
			close: Effect.fn("ConnectionScopes.close")(function* (key) {
				const id = JSON.stringify([key.owner, key.connectionId])
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
	const rules = yield* Discovery.Rules
	const current = yield* discovery.refreshCard(options.candidate.cardUrl)
	if (
		rules.compare({ previous: options.candidate, current })._tag ===
		"NeedsRevalidation"
	)
		return yield* AppError.make({ reason: "CandidateChanged" })
	const configured = yield* rules.configureEndpoint({
		candidate: current,
		index: options.remoteIndex,
		values: options.values,
	})
	const store = yield* Store.AppStore
	const connection = yield* store.save({
		app: {
			cardUrl: current.cardUrl,
			card: current.card,
			sources: current.sources,
		},
		connection: {
			...options.key,
			cardUrl: current.cardUrl,
			endpoint: configured.url,
			remoteIndex: configured.remoteIndex,
			configuration: Redacted.make(options.values),
			headers: Redacted.make(configured.headers),
			state: "Enabled",
			authorization: options.requiresAuthorization
				? {
						_tag: "PendingAuthorization",
						resource: configured.url,
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

/** The parts of a remote that change what a connection talks to. */
const remoteDescription = (card: Document.ServerCard, index: number) =>
	Option.fromNullishOr(card.remotes?.[index]).pipe(
		Option.map((remote) => ({
			type: remote.type,
			url: remote.url,
			versions: remote.supportedProtocolVersions,
			variables: remote.variables,
			headers: remote.headers,
		})),
	)
const sameDescription = Option.makeEquivalence(
	Schema.toEquivalence(
		Schema.Struct({
			type: Schema.String,
			url: Schema.String,
			versions: Schema.optional(Schema.Array(Schema.String)),
			variables: Schema.optional(Schema.Record(Schema.String, Document.Input)),
			headers: Schema.optional(Schema.Array(Document.HeaderInput)),
		}),
	),
)
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
		!sameDescription(
			remoteDescription(service.card, connection.remoteIndex),
			remoteDescription(candidate.card, remoteIndex),
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
		yield* store.updateApp({
			cardUrl: candidate.cardUrl,
			card: candidate.card,
			sources: candidate.sources,
		})
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
	yield* store.updateApp({
		cardUrl: candidate.cardUrl,
		card: candidate.card,
		sources: candidate.sources,
	})
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
