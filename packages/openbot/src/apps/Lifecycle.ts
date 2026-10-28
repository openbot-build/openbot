import { AppConnections, ConnectionId, Execution } from "@openbot-build/domain"
import {
	AppConnections as ProtocolConnections,
	CatalogDiscovery,
	Client,
	Discovery,
	Document,
	McpClient,
	Network,
	OAuthAuthorization,
	Store as Protocol,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Option,
	Effect,
	Equal,
	HashSet,
	Layer,
	Redacted,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { AppNetwork } from "./AppHost.ts"
import { capabilityLists, pages } from "./Capabilities.ts"
import * as ManualConnection from "./ManualConnection.ts"
import { Probe } from "./Probe.ts"
import { Records } from "../errors/Records.ts"
import { type Input, type Prepared } from "./ConnectionCommands.ts"
import { jsonObject } from "./AppResults.ts"

/** Reads return a proposed change. Only ConnectionCommands may save that change. */
export const make = Effect.gen(function* () {
	const discovery = yield* Discovery.Discovery
	const rules = yield* Discovery.Rules
	const network = yield* AppNetwork
	const probe = yield* Probe
	const errors = yield* Records
	const withNetwork = <A, E, R>(
		owner: string,
		links: ReadonlyArray<string>,
		work: Effect.Effect<A, E, R | Network.Network>,
	) =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					network.layer(
						owner,
						Arr.map(links, (url) => new URL(url).origin),
					),
				)
				return yield* work.pipe(Effect.provideContext(context))
			}),
		)
	const prepare = (
		input: Input,
		executionId: Execution.Id,
		check: Effect.Effect<
			void,
			| Execution.Forbidden
			| Execution.StorageError
			| Execution.Conflict
			| Execution.NotFound
		>,
	) =>
		Effect.gen(function* () {
			const { action, connection: stored } = input
			const connection = stored.connection
			const base: Prepared = {
				connection: stored,
				app: input.app,
				capabilities: null,
				discardCredential: false,
			}
			yield* check
			if (action._tag === "Update") {
				const review =
					connection.state === "NeedsRevalidation" ||
					stored.verification?._tag === "NeedsRevalidation"
				return {
					...base,
					connection: {
						...stored,
						name: Str.trim(action.request.name),
						verification: review
							? { _tag: "NeedsRevalidation" as const }
							: null,
						connection: {
							...connection,
							state: action.request.enabled
								? review
									? ("NeedsRevalidation" as const)
									: ("Enabled" as const)
								: ("Disabled" as const),
						},
					},
				}
			}
			if (action._tag === "Manual") {
				const oldHeaders = Redacted.value(connection.headers)
				const headers = yield* Effect.forEach(
					Rec.toEntries(action.request.headers),
					([name, value]) => {
						const next = value ?? oldHeaders[name]
						return next === undefined
							? Effect.fail(
									AppConnections.ConnectionConfigurationInvalid.make({
										keys: ["header:" + name],
										message:
											"Give a value for this header. It has no saved value.",
									}),
								)
							: Effect.succeed([name, next] as const)
					},
				).pipe(Effect.map(Rec.fromEntries))
				const configured = yield* ManualConnection.configure(connection.owner)({
					...action.request,
					headers,
					id: ConnectionId.make(connection.connectionId),
				})
				yield* check
				const protection = yield* probe.check(configured)
				yield* check
				return {
					...base,
					app: configured.app,
					discardCredential: true,
					connection: {
						...stored,
						name: Str.trim(action.request.name),
						verification: null,
						connection: {
							...configured.connection,
							state: connection.state,
							authorization: protection.requiresAuthorization
								? {
										_tag: "PendingAuthorization" as const,
										resource: action.request.url,
										scopes: protection.scopes,
									}
								: { _tag: "Unprotected" as const },
						},
					},
				}
			}
			if (action._tag === "Verify" && connection.state !== "Enabled")
				return base
			const manual = Arr.some(
				input.app.sources,
				(source) => source.role === "manual",
			)
			const current = manual
				? null
				: yield* discovery.refreshCard(connection.cardUrl)
			yield* check
			const app =
				current === null
					? input.app
					: Protocol.AppRecord.make({
							cardUrl: current.cardUrl,
							card: current.card,
							sources: current.sources,
						})
			if (action._tag === "Revalidate") {
				if (
					current === null ||
					input.candidate === null ||
					rules.compare({ previous: input.candidate, current })._tag ===
						"NeedsRevalidation"
				)
					return yield* AppConnections.ConnectionConflict.make({
						reason: "CandidateChanged",
						message:
							"The App requirements changed again. Discover it again before confirming.",
					})
				if (connection.state === "Disabled")
					return yield* Execution.Conflict.make({ id: executionId })
				const endpoint = yield* rules.configureEndpoint({
					candidate: current,
					index: action.request.remoteIndex,
					values: action.request.values,
				})
				const configured = {
					...connection,
					state: "Enabled" as const,
					endpoint: endpoint.url,
					remoteIndex: endpoint.remoteIndex,
					headers: Redacted.make(endpoint.headers),
					configuration: Redacted.make(action.request.values),
					authorization: { _tag: "Unprotected" as const },
				}
				yield* check
				const protection = yield* probe.check({ connection: configured })
				yield* check
				let trustedIssuer = ""
				if (
					protection.requiresAuthorization &&
					endpoint.url === connection.endpoint &&
					connection.authorization._tag === "Authorized"
				) {
					const resource = yield* withNetwork(
						connection.owner,
						[
							endpoint.url,
							...(protection.resourceMetadataUrl === undefined
								? []
								: [protection.resourceMetadataUrl]),
						],
						OAuthAuthorization.discoverResource({
							resource: endpoint.url,
							...(protection.resourceMetadataUrl === undefined
								? {}
								: { resourceMetadataUrl: protection.resourceMetadataUrl }),
						}),
					)
					trustedIssuer = resource.authorization_servers.includes(
						connection.authorization.binding.issuer,
					)
						? connection.authorization.binding.issuer
						: ""
				}
				const equalValues = Schema.toEquivalence(
					Schema.Record(Schema.String, Schema.String),
				)
				const auth = connection.authorization
				const sameAuth =
					auth._tag === "Authorized"
						? protection.requiresAuthorization &&
							auth.binding.issuer === trustedIssuer &&
							Equal.equals(
								HashSet.fromIterable(auth.scopes),
								HashSet.fromIterable(protection.scopes),
							)
						: auth._tag === "Unprotected" && !protection.requiresAuthorization
				const unchanged =
					connection.state !== "NeedsRevalidation" &&
					endpoint.url === connection.endpoint &&
					endpoint.remoteIndex === connection.remoteIndex &&
					equalValues(endpoint.headers, Redacted.value(connection.headers)) &&
					equalValues(
						action.request.values,
						Redacted.value(connection.configuration),
					) &&
					CatalogDiscovery.sameConnection(
						input.app.card.remotes?.[connection.remoteIndex],
						current.card.remotes?.[endpoint.remoteIndex],
					) &&
					sameAuth
				yield* check
				return unchanged
					? { ...base, app }
					: {
							...base,
							app,
							discardCredential: true,
							connection: {
								...stored,
								verification: null,
								connection: {
									...configured,
									authorization: protection.requiresAuthorization
										? {
												_tag: "PendingAuthorization" as const,
												resource: endpoint.url,
												scopes: protection.scopes,
											}
										: { _tag: "Unprotected" as const },
								},
							},
						}
			}
			if (connection.state !== "Enabled") return base
			if (
				!CatalogDiscovery.sameConnection(
					input.app.card.remotes?.[connection.remoteIndex],
					app.card.remotes?.[connection.remoteIndex],
				)
			)
				return {
					...base,
					app,
					connection: {
						...stored,
						verification: { _tag: "NeedsRevalidation" as const },
						connection: { ...connection, state: "NeedsRevalidation" as const },
					},
				}
			const policy = Client.InvocationPolicy.of({
				check: (invocation) => {
					const denied = Client.PermissionDenied.make({
						action: invocation.action,
						target: invocation.target,
					})
					if (!Schema.is(Client.ListAction)(invocation.action))
						return Effect.fail(denied)
					return check.pipe(
						Effect.catchCause((cause) =>
							errors
								.record(cause, "forbidden", executionId)
								.pipe(Effect.orDie, Effect.andThen(Effect.fail(denied))),
						),
					)
				},
			})
			const observed = yield* Effect.scoped(
				Effect.gen(function* () {
					yield* check
					return yield* withNetwork(
						connection.owner,
						[connection.endpoint],
						Effect.gen(function* () {
							const client = yield* McpClient.open({
								key: connection,
								endpoint: connection.endpoint,
								headers: connection.headers,
								readToken: ProtocolConnections.authorizationToken(
									connection,
									Option.fromNullishOr(input.credential),
								),
								check: (request) =>
									request.action === "connect"
										? check.pipe(
												Effect.catchCause((cause) =>
													errors.record(cause, "forbidden", executionId).pipe(
														Effect.orDie,
														Effect.andThen(
															Effect.fail(
																Client.PermissionDenied.make({
																	action: request.action,
																	target: request.target,
																}),
															),
														),
													),
												),
											)
										: policy.check({ ...request, connection }),
								clientInfo: { name: "OpenBot", version: "1.0.0" },
								capabilities: {},
							})
							const lists = capabilityLists(client)
							const collect = <A>(list: {
								readonly advertised: boolean
								readonly page: (cursor?: string) => Effect.Effect<
									{
										readonly values: ReadonlyArray<A>
										readonly nextCursor?: string | undefined
									},
									Client.Error
								>
							}) =>
								list.advertised
									? pages(list.page).pipe(
											Effect.flatMap((values) =>
												Effect.forEach(values, jsonObject),
											),
										)
									: Effect.succeed([])
							return {
								protocolVersion: Document.protocolVersion,
								tools: yield* collect(lists.tools),
								resources: yield* collect(lists.resources),
								resourceTemplates: yield* collect(lists.resourceTemplates),
								prompts: yield* collect(lists.prompts),
							}
						}),
					)
				}),
			).pipe(Effect.result)
			yield* check
			if (observed._tag === "Success")
				return {
					...base,
					app,
					capabilities: observed.success,
					connection: {
						...stored,
						verification: {
							_tag: "Available" as const,
							checkedAt: yield* Clock.currentTimeMillis,
							revision: stored.revision + 1,
						},
					},
				}
			const error = observed.failure
			if (
				error._tag === "ExecutionForbidden" ||
				error._tag === "ExecutionStorageError" ||
				error._tag === "ExecutionConflict" ||
				error._tag === "ExecutionNotFound"
			)
				return yield* error
			const verification: typeof AppConnections.Availability.Type =
				error._tag === "AuthorizationRequired"
					? error.reason === "Expired"
						? { _tag: "AuthorizationExpired" }
						: { _tag: "PendingAuthorization", scopes: error.scopes }
					: {
							_tag: "ConnectionFailed",
							message:
								"The App could not provide compatible live capabilities. Check the connection and try again.",
						}
			if (verification._tag === "ConnectionFailed")
				yield* errors.record(Cause.fail(error), "external", executionId)
			return { ...base, app, connection: { ...stored, verification } }
		})
	return { prepare }
})
export class Lifecycle extends Context.Service<
	Lifecycle,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/Lifecycle") {}
export const layer = Layer.effect(Lifecycle, make)
