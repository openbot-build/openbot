import {
	ConnectionsApi as Api,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/platform-api"
import {
	App,
	Client,
	Discovery,
	Document,
	Store,
} from "@openbot-build/protocol"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Redacted,
	Record,
	Schema,
} from "effect"
import * as ManualConnection from "./ManualConnection.ts"
import { AppHost } from "./AppHost.ts"
import { Connections, type Error as ConnectionError } from "./Connections.ts"
import { ConnectionLocks } from "./ConnectionLocks.ts"
import { Capabilities } from "./Capabilities.ts"
import { Governance } from "./Governance.ts"
import { Probe } from "./Probe.ts"
import { Repository, ownerKey } from "./Repository.ts"

export type Error = ConnectionError | Api.ConnectionCleanupPending
/** Private lifecycle operations need the identity of the current request. @effect-expect-leaking Identity */
export class Lifecycle extends Context.Service<
	Lifecycle,
	{
		readonly verify: (
			id: string,
		) => Effect.Effect<Api.Verification, Error, Identity>
		readonly refresh: (
			id: string,
		) => Effect.Effect<Api.Connection, Error, Identity>
		readonly revalidate: (
			id: string,
			request: Api.RevalidationRequest,
		) => Effect.Effect<Api.Connection, Error, Identity>
		readonly update: (
			id: string,
			request: Api.ConnectionUpdate,
		) => Effect.Effect<Api.Connection, Error, Identity>
		readonly updateManual: (
			id: string,
			request: Api.ManualConnectionUpdate,
		) => Effect.Effect<Api.Connection, Error, Identity>
		readonly remove: (id: string) => Effect.Effect<void, Error, Identity>
	}
>()("@openbot-build/platform/apps/Lifecycle") {}

const metadataPolicy = Client.InvocationPolicy.of({
	check: (invocation) =>
		[
			"tools/list",
			"resources/list",
			"resources/templates/list",
			"prompts/list",
		].includes(invocation.action)
			? Effect.void
			: Effect.fail(
					new Client.PermissionDenied({
						action: invocation.action,
						target: invocation.target,
					}),
				),
})
const conflict = () =>
	Api.ConnectionConflict.make({
		reason: "RevisionChanged",
		message: "This connection changed. Refresh it before continuing.",
	})
const configuration = () =>
	Api.ConnectionConfigurationInvalid.make({
		keys: [],
		message:
			"Review the current App declaration and configuration before continuing.",
	})
const hostFailure = (error: { readonly _tag: string }): Error =>
	Match.value(error).pipe(
		Match.when({ _tag: "CleanupPending" }, () => {
			const pending = Schema.decodeUnknownSync(
				Schema.Struct({
					key: Store.ConnectionKey,
					stage: Schema.Literals(["Credentials", "Connection"]),
				}),
			)(error)
			return Api.ConnectionCleanupPending.make({
				connectionId: pending.key.connectionId,
				stage: pending.stage,
				message:
					"This connection is stopped. Retry cleanup to finish removing it.",
			})
		}),
		Match.when({ _tag: "AppError" }, configuration),
		Match.when({ _tag: "DiscoveryError" }, configuration),
		Match.orElse(() => ExperienceStorageUnavailable.make({})),
	)
const json = (value: unknown) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
		JSON.stringify(value),
	)

export const make: Effect.Effect<
	typeof Lifecycle.Service,
	never,
	| Connections
	| Repository
	| AppHost
	| ConnectionLocks
	| App.ConnectionScopes
	| Governance
	| Discovery.Discovery
	| Discovery.Rules
	| Probe
	| Capabilities
> = Effect.gen(function* () {
	const capabilities = yield* Capabilities
	const connections = yield* Connections
	const repository = yield* Repository
	const factory = yield* AppHost
	const locks = yield* ConnectionLocks
	const scopes = yield* App.ConnectionScopes
	const governance = yield* Governance
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const probe = yield* Probe
	const key = (id: string) =>
		Effect.map(Identity, (identity) => ({
			owner: ownerKey(identity),
			connectionId: id,
		}))
	return Lifecycle.of({
		verify: Effect.fn("Apps.verifyConnection")(function* (id) {
			const owned = yield* key(id)
			const stored = yield* repository.get(owned.owner, id)
			yield* governance.check(stored.connection.cardUrl)
			if (stored.connection.state !== "Enabled")
				return {
					_tag: "Unavailable",
					connection: yield* connections.getConnection(id),
				}
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					const opened = yield* capabilities.open({
						...owned,
						policy: metadataPolicy,
					})
					return {
						tools: yield* Effect.forEach(opened.tools, json),
						resources: yield* Effect.forEach(opened.resources, json),
						resourceTemplates: yield* Effect.forEach(
							opened.resourceTemplates,
							json,
						),
						prompts: yield* Effect.forEach(opened.prompts, json),
					}
				}),
			).pipe(Effect.result)

			return yield* Match.value(result).pipe(
				Match.when(
					{ _tag: "Failure", failure: { _tag: "AppCapabilitiesUnavailable" } },
					() =>
						Effect.gen(function* () {
							return {
								_tag: "Unavailable",
								connection: yield* connections.getConnection(id),
							} as const
						}),
				),
				Match.when(
					{
						_tag: "Failure",
						failure: { _tag: "ExperienceStorageUnavailable" },
					},
					({ failure }) => Effect.fail(failure),
				),
				Match.when(
					{ _tag: "Failure", failure: { _tag: "ExperienceNotFound" } },
					({ failure }) => Effect.fail(failure),
				),
				Match.when(
					{ _tag: "Failure", failure: { _tag: "ConnectionConflict" } },
					({ failure }) => Effect.fail(failure),
				),
				Match.when(
					{ _tag: "Failure", failure: { _tag: "AppRestricted" } },
					({ failure }) => Effect.fail(failure),
				),

				Match.tag("Success", ({ success }) =>
					Effect.gen(function* () {
						const checkedAt = yield* Clock.currentTimeMillis
						yield* repository.update(
							owned.owner,
							id,
							(row) => ({
								...row,
								verification: {
									_tag: "Available",
									checkedAt,
									revision: row.revision + 1,
								},
							}),
							stored.revision,
						)
						return {
							_tag: "Verified",
							capabilities: {
								connection: yield* connections.getConnection(id),
								protocolVersion: Document.protocolVersion,
								...success,
							},
						} as const
					}),
				),
				Match.tag("Failure", ({ failure }) =>
					Effect.gen(function* () {
						const verification = Match.value(failure).pipe(
							Match.tag("AuthorizationRequired", (error) =>
								Match.value(error.reason).pipe(
									Match.when(
										"Expired",
										() => ({ _tag: "AuthorizationExpired" }) as const,
									),
									Match.orElse(
										() =>
											({
												_tag: "PendingAuthorization",
												scopes: error.scopes,
											}) as const,
									),
								),
							),
							Match.orElse(
								() =>
									({
										_tag: "ConnectionFailed",
										message:
											"The App could not provide compatible live capabilities. Check the connection and try again.",
									}) as const,
							),
						)
						yield* repository.update(
							owned.owner,
							id,
							(row) => ({ ...row, verification }),
							stored.revision,
						)
						return {
							_tag: "Unavailable",
							connection: yield* connections.getConnection(id),
						} as const
					}),
				),
				Match.exhaustive,
			)
		}),
		refresh: Effect.fn("Apps.refreshConnectionAuthorization")(function* (id) {
			const owned = yield* key(id)
			const stored = yield* repository.get(owned.owner, id)
			yield* governance.check(stored.connection.cardUrl)
			const result = yield* factory
				.bind(owned.owner, metadataPolicy)
				.refreshAuthorization(owned)
				.pipe(Effect.result)
			yield* Match.value(result).pipe(
				Match.tag("Success", () => Effect.void),
				Match.tag("Failure", () =>
					repository
						.update(
							owned.owner,
							id,
							(row) => ({
								...row,
								verification: { _tag: "AuthorizationExpired" },
							}),
							stored.revision,
						)
						.pipe(Effect.asVoid),
				),
				Match.exhaustive,
			)
			return yield* connections.getConnection(id)
		}),
		updateManual: Effect.fn("Apps.updateManualConnection")(
			function* (id, request) {
				const valid = yield* Schema.decodeEffect(Api.ManualConnectionUpdate)(
					request,
				).pipe(Effect.mapError(configuration))
				const owned = yield* key(id)
				return yield* locks.withConnection(
					owned,
					Effect.gen(function* () {
						const stored = yield* repository.get(owned.owner, id)
						const app = yield* repository.getApp(
							owned.owner,
							stored.connection.cardUrl,
						)
						if (
							!app.sources.some((source) => source.role === "manual") ||
							stored.revision !== valid.revision
						)
							return yield* conflict()
						if (stored.connection.state === "CleanupPending")
							return yield* configuration()
						yield* governance.check(valid.url)
						const oldHeaders = Redacted.value(stored.connection.headers)
						const headers = yield* Effect.forEach(
							Record.toEntries(valid.headers),
							([name, value]) => {
								const next = value ?? oldHeaders[name]
								return next === undefined
									? Effect.fail(configuration())
									: Effect.succeed([name, next] as const)
							},
						).pipe(Effect.map(Record.fromEntries))
						const configured = yield* ManualConnection.configure(owned.owner)({
							...valid,
							headers,
							id,
						})
						const protection = yield* probe.check(configured)
						yield* scopes.close(owned)
						yield* repository.update(
							owned.owner,
							id,
							(row) => ({
								...row,
								name: valid.name.trim(),
								verification: null,
								connection: {
									...configured.connection,
									state: row.connection.state,
									authorization: protection.requiresAuthorization
										? {
												_tag: "PendingAuthorization",
												resource: valid.url,
												scopes: protection.scopes,
											}
										: { _tag: "Unprotected" },
								},
							}),
							valid.revision,
						)
						yield* repository.updateApp(owned.owner, configured.app)
						return yield* connections.getConnection(id)
					}),
				)
			},
		),
		update: Effect.fn("Apps.manageConnection")(function* (id, request) {
			const valid = yield* Schema.decodeEffect(Api.ConnectionUpdate)(
				request,
			).pipe(Effect.mapError(configuration))
			const owned = yield* key(id)
			return yield* locks.withConnection(
				owned,
				Effect.gen(function* () {
					const stored = yield* repository.get(owned.owner, id)
					if (stored.connection.state === "CleanupPending")
						return yield* Api.ConnectionCleanupPending.make({
							connectionId: id,
							stage: "Connection",
							message: "Finish cleanup before changing this connection.",
						})
					const needsReview =
						stored.connection.state === "NeedsRevalidation" ||
						stored.verification?._tag === "NeedsRevalidation"
					yield* repository.update(
						owned.owner,
						id,
						(row) => ({
							...row,
							name: valid.name.trim(),
							verification: needsReview ? { _tag: "NeedsRevalidation" } : null,
							connection: {
								...row.connection,
								state: valid.enabled
									? needsReview
										? "NeedsRevalidation"
										: "Enabled"
									: "Disabled",
							},
						}),
						valid.revision,
					)
					yield* scopes.close(owned)
					return yield* connections.getConnection(id)
				}),
			)
		}),
		remove: (id) =>
			Effect.gen(function* () {
				const owned = yield* key(id)
				yield* repository.get(owned.owner, id)
				yield* factory
					.bind(owned.owner, metadataPolicy)
					.remove(owned)
					.pipe(Effect.mapError(hostFailure))
			}),
		revalidate: Effect.fn("Apps.revalidateConnection")(function* (id, raw) {
			const input = yield* Schema.decodeEffect(Api.RevalidationRequest)(
				raw,
			).pipe(Effect.mapError(configuration))
			const owned = yield* key(id)
			return yield* locks.withConnection(
				owned,
				Effect.gen(function* () {
					const stored = yield* repository.get(owned.owner, id)
					if (stored.revision !== input.revision) return yield* conflict()
					yield* governance.check(stored.connection.cardUrl)
					const draft = yield* connections.getConnectionDraft(input.draftId)
					const candidate = Match.value(draft.discovery).pipe(
						Match.tag("Single", ({ candidate }) => candidate),
						Match.tag("Multiple", ({ candidates }) =>
							candidates.find(
								(value) => value.cardUrl === stored.connection.cardUrl,
							),
						),
						Match.exhaustive,
					)
					if (
						candidate === undefined ||
						candidate.cardUrl !== stored.connection.cardUrl
					)
						return yield* configuration()
					const current = yield* discovery
						.refreshCard(candidate.cardUrl)
						.pipe(Effect.mapError(configuration))
					if (
						rules.compare({ previous: candidate, current })._tag ===
						"NeedsRevalidation"
					)
						return yield* Api.ConnectionConflict.make({
							reason: "CandidateChanged",
							message:
								"The App requirements changed again. Discover it again before confirming.",
						})
					const endpoint = yield* rules
						.configureEndpoint({
							candidate: current,
							index: input.remoteIndex,
							values: input.values,
						})
						.pipe(Effect.mapError(configuration))
					const protection = yield* probe.check({
						app: {
							cardUrl: current.cardUrl,
							card: current.card,
							sources: current.sources,
						},
						connection: {
							...stored.connection,
							state: "Enabled",
							endpoint: endpoint.url,
							remoteIndex: endpoint.remoteIndex,
							headers: Redacted.make(endpoint.headers),
							configuration: Redacted.make(input.values),
							authorization: { _tag: "Unprotected" },
						},
					})
					const app = factory.bind(owned.owner, metadataPolicy)
					const oldIssuer = Match.value(stored.connection.authorization).pipe(
						Match.tag("Authorized", (auth) => auth.binding.issuer),
						Match.orElse(() => ""),
					)
					const attested =
						protection.requiresAuthorization &&
						endpoint.url === stored.connection.endpoint
							? yield* app
									.inspectAuthorization(owned)
									.pipe(Effect.mapError(hostFailure))
							: undefined
					const trustedIssuer =
						attested?.requiresAuthorization === true
							? attested.resource.authorization_servers.includes(oldIssuer)
								? oldIssuer
								: attested.resource.authorization_servers[0]
							: ""
					const authorization = protection.requiresAuthorization
						? Option.some({ issuer: trustedIssuer, scopes: protection.scopes })
						: Option.none()
					yield* app
						.revalidate({
							key: owned,
							candidate: current,
							remoteIndex: input.remoteIndex,
							values: input.values,
							authorization,
							confirmed: true,
						})
						.pipe(Effect.mapError(hostFailure))
					return yield* connections.getConnection(id)
				}),
			)
		}),
	})
})
export const layer = Layer.effect(Lifecycle, make)
