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

const keyOf = (key: Store.ConnectionKey) =>
	JSON.stringify([key.owner, key.connectionId])

export const layerConnectionScopes = Layer.effect(
	ConnectionScopes,
	Effect.gen(function* () {
		const state = yield* Ref.make(
			HashMap.empty<string, HashSet.HashSet<Scope.Closeable>>(),
		)
		return ConnectionScopes.of({
			register: ({ key, scope }) =>
				Effect.gen(function* () {
					yield* Ref.update(state, (old) =>
						HashMap.set(
							old,
							keyOf(key),
							HashSet.fromIterable([
								...(Option.getOrUndefined(HashMap.get(old, keyOf(key))) ?? []),
								scope,
							]),
						),
					)
					yield* Scope.addFinalizer(
						scope,
						Ref.update(state, (old) => {
							let scopes = HashSet.fromIterable(
								Option.getOrUndefined(HashMap.get(old, keyOf(key))) ?? [],
							)
							scopes = HashSet.remove(scopes, scope)
							let updated = old
							if (HashSet.size(scopes) === 0)
								updated = HashMap.remove(updated, keyOf(key))
							else updated = HashMap.set(updated, keyOf(key), scopes)
							return updated
						}),
					)
				}),
			close: (key) =>
				Ref.modify(state, (old) => {
					const scopes =
						Option.getOrUndefined(HashMap.get(old, keyOf(key))) ??
						HashSet.empty<Scope.Closeable>()
					let updated = old
					updated = HashMap.remove(updated, keyOf(key))
					return [scopes, updated] as const
				}).pipe(
					Effect.flatMap((scopes) =>
						Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), {
							discard: true,
							concurrency: "unbounded",
						}),
					),
				),
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
		return yield* new AppError({
			reason: "ConfirmationRequired",
		})
	const discovery = yield* Discovery.Discovery
	const current = yield* discovery.refreshCard(options.candidate.cardUrl)
	yield* Match.value(
		yield* Discovery.Rules.use((rules) =>
			Effect.succeed(rules.compare({ previous: options.candidate, current })),
		),
	).pipe(
		Match.tag("NeedsRevalidation", () =>
			Effect.fail(new AppError({ reason: "CandidateChanged" })),
		),
		Match.orElse(() => Effect.void),
	)
	const configured = yield* Discovery.Rules.use((rules) =>
		rules.configureEndpoint({
			candidate: current,
			index: options.remoteIndex,
			values: options.values,
		}),
	)
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
		return yield* new AppError({ reason: "Unavailable" })
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
						new CleanupPending({
							key,
							stage,
						}),
					),
				),
			)
	yield* active.close(key)
	yield* OAuthAuthorization.revoke(key).pipe(
		Effect.catch(() => pending("Credentials")),
	)
	yield* store.delete(key).pipe(Effect.catch(() => pending("Connection")))
	return { _tag: "Removed", key } as const
})

const connectionDescription = (
	remote: import("../Document.ts").Remote | undefined,
) =>
	remote === undefined
		? undefined
		: {
				type: remote.type,
				url: remote.url,
				versions: remote.supportedProtocolVersions,
				variables: remote.variables,
				headers: remote.headers,
			}
const sameDescription = Schema.toEquivalence(
	Schema.UndefinedOr(
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
		return yield* new AppError({ reason: "Unavailable" })
	if (connection.cardUrl !== options.candidate.cardUrl)
		return yield* new AppError({ reason: "CandidateChanged" })
	const discovery = yield* Discovery.Discovery
	const candidate = yield* discovery.refreshCard(connection.cardUrl)
	const service = yield* store.getApp(connection.cardUrl)
	const remoteIndex = options.remoteIndex ?? connection.remoteIndex
	const values = options.values ?? Redacted.value(connection.configuration)
	const endpoint = yield* Effect.result(
		Discovery.Rules.use((rules) =>
			rules.configureEndpoint({
				candidate,
				index: remoteIndex,
				values,
			}),
		),
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
			connectionDescription(service.card.remotes?.[connection.remoteIndex]),
			connectionDescription(candidate.card.remotes?.[remoteIndex]),
		) ||
		!sameConfiguration(values, Redacted.value(connection.configuration)) ||
		Match.value(auth).pipe(
			Match.tag("Unprotected", () => options.authorization !== null),
			Match.tag(
				"Authorized",
				(auth) =>
					options.authorization === null ||
					auth.binding.issuer !== options.authorization.issuer ||
					!Equal.equals(
						HashSet.fromIterable(auth.scopes),
						HashSet.fromIterable(options.authorization.scopes),
					),
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
	yield* Match.value(
		yield* Discovery.Rules.use((rules) =>
			Effect.succeed(
				rules.compare({
					previous: options.candidate,
					current: candidate,
				}),
			),
		),
	).pipe(
		Match.tag("NeedsRevalidation", () =>
			Effect.fail(new AppError({ reason: "CandidateChanged" })),
		),
		Match.orElse(() => Effect.void),
	)
	const configured = yield* Match.value(endpoint).pipe(
		Match.tagsExhaustive({
			Failure: ({ failure }) => Effect.fail(failure),
			Success: ({ success }) => Effect.succeed(success),
		}),
	)
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
						authorization:
							options.authorization === null
								? {
										_tag: "Unprotected",
									}
								: {
										_tag: "PendingAuthorization",
										resource: configured.url,
										scopes: options.authorization.scopes,
									},
					}
				: old,
	})
	if (updated.state !== "Enabled" || updated.endpoint !== configured.url)
		return yield* new AppError({ reason: "Unavailable" })
	return { _tag: "Revalidated", connection: updated, candidate } as const
})
