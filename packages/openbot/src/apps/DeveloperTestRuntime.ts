import type {
	Result as TestResult,
	Preparation,
	Exchange,
} from "./TestCommands.ts"
import { Records } from "../errors/Records.ts"
import { Developers, Execution as Executions } from "@openbot-build/domain"

import {
	App,
	Authorization,
	Client,
	AppConnections,
	Network,
	Document,
	OAuthAuthorization,
	Store,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Match,
	Option,
	Ref,
	Schema,
	Redacted,
	Scope,
} from "effect"
import { AppNetwork } from "./AppHost.ts"
import { PgClient } from "@effect/sql-pg"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import { capabilityLists, pages } from "./Capabilities.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

export type Execution = TestResult
export class DeveloperTestRuntime extends Context.Service<
	DeveloperTestRuntime,
	{
		readonly execute: (
			owner: string,
			id: string,
			steps: {
				readonly check: Effect.Effect<void, Developers.Failure>
				readonly progress: (
					stages: ReadonlyArray<Developers.TestStage>,
				) => Effect.Effect<void, Developers.Failure>
			},
		) => Effect.Effect<Execution, Developers.Failure>
		readonly prepare: (
			owner: string,
			id: string,
			input: {
				readonly issuer?: string
				readonly scopes: ReadonlyArray<string>
			},
		) => Effect.Effect<Preparation, Developers.Failure>
		readonly exchange: (
			owner: string,
			id: string,
			input: Exchange,
		) => Effect.Effect<OAuthAuthorization.Grant, Developers.Failure>
	}
>()("@openbot-build/openbot/apps/DeveloperTestRuntime") {}
const policy = Client.InvocationPolicy.of({
	check: (invocation) =>
		invocation.action === "connect" ||
		Schema.is(Client.ListAction)(invocation.action)
			? Effect.void
			: Effect.fail(
					Client.PermissionDenied.make({
						action: invocation.action,
						target: invocation.target,
					}),
				),
})
/** The capability lists, in the order a test reads them. */
const listNames = [
	"tools",
	"resources",
	"resourceTemplates",
	"prompts",
] as const
const uncheckedLists: ReadonlyArray<Developers.TestStage> = Arr.map(
	listNames,
	(name): Developers.TestStage => ({
		name,
		status: "NotChecked",
		items: [],
		reason: null,
	}),
)

export const make: Effect.Effect<
	typeof DeveloperTestRuntime.Service,
	never,
	| DeveloperTestStores
	| PgClient.PgClient
	| AppNetwork
	| Crypto.Crypto
	| App.ConnectionScopes
	| DeveloperAccess
	| Settings
	| Records
> = Effect.gen(function* () {
	const errors = yield* Records
	const settings = yield* Settings
	const stores = yield* DeveloperTestStores
	const db = yield* Db.make
	const namespace = yield* IndexNamespace
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
		check: Effect.Effect<void, Developers.Failure> = Effect.void,
	): Effect.Effect<
		A,
		E | Developers.DeveloperInputInvalid | Store.StoreError,
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
				Effect.catchTag("SchemaError", () =>
					Effect.fail(
						Developers.DeveloperInputInvalid.make({
							message: "Test network targets must be valid HTTPS URLs.",
						}),
					),
				),
			)
			const context = yield* Layer.buildWithScope(
				network.layer(
					owner,
					Arr.map(links, (url) => new URL(url).origin),
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
								check: (invocation) => {
									const denied = () =>
										Client.PermissionDenied.make({
											action: invocation.action,
											target: invocation.target,
										})
									return Effect.gen(function* () {
										yield* check
										const test = yield* Rows.getTest(db, namespace, id)
										if (
											test.owner !== owner ||
											test.value.status !== "Running" ||
											test.value.expiresAt <= (yield* Clock.currentTimeMillis)
										)
											return false
										return yield* access.allows(owner, test.value.cardUrl, true)
									}).pipe(
										Effect.catchTag("DeveloperNotFound", () =>
											Effect.succeed(false),
										),
										// A check that cannot finish denies the call.
										Failures.replace(
											"Could not check a call of a test.",
											denied,
										),
										Effect.flatMap((allowed) =>
											allowed
												? policy.check(invocation)
												: Effect.fail(denied()),
										),
									)
								},
							}),
						),
						Context.add(Crypto.Crypto, crypto),
					),
				),
			)
		})
	const authorizationFailure =
		(id: string, message: string) =>
		(
			error:
				| Authorization.AuthorizationError
				| App.AppError
				| Store.StoreError
				| Network.NetworkError
				| Schema.SchemaError
				| Developers.DeveloperInputInvalid,
		): Effect.Effect<never, Developers.Failure> => {
			if (error._tag === "DeveloperInputInvalid") return Effect.fail(error)
			if (error._tag === "StoreError" && error.reason === "Missing")
				return Effect.fail(Developers.DeveloperNotFound.make({}))
			const failure =
				error._tag === "AuthorizationError"
					? Developers.DeveloperConflict.make({ reason: error.reason })
					: error._tag === "AppError"
						? Developers.DeveloperConflict.make({
								reason: "ConnectionUnavailable",
							})
						: Developers.DeveloperUnavailable.make({})
			return errors
				.record(Cause.fail(error), "external")
				.pipe(
					Effect.annotateLogs({ testId: id, operation: message }),
					Effect.andThen(Effect.fail(failure)),
				)
		}
	return DeveloperTestRuntime.of({
		execute: (owner, id, steps) =>
			Effect.scoped(
				withNetwork(
					owner,
					id,
					[],
					Effect.gen(function* () {
						yield* steps.check
						const client = yield* AppConnections.open({
							key: { owner, connectionId: id },
							clientInfo: {
								name: "OpenBot Developer Center",
								version: "1.0.0",
							},
							capabilities: {},
						})
						let stages: ReadonlyArray<Developers.TestStage> = [
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
						const progress = steps.progress
						yield* progress(stages)
						const capabilities = capabilityLists(client)
						const lists = Arr.map(listNames, (name) => ({
							name,
							advertised: capabilities[name].advertised,
							read: () => collect<unknown>(capabilities[name].page),
						}))
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
							yield* steps.check
							const result = yield* list.read().pipe(
								Effect.flatMap(
									Schema.decodeUnknownEffect(Schema.Array(Schema.JsonObject)),
								),
								Effect.tapCauseIf(Cause.hasFails, (cause) =>
									errors
										.record(cause, "external")
										.pipe(
											Effect.annotateLogs({ testId: id, list: list.name }),
											Effect.asVoid,
										),
								),
								Effect.result,
							)
							if (
								result._tag === "Failure" &&
								Schema.is(Executions.StorageError)(result.failure)
							)
								return yield* result.failure
							const read = yield* Ref.get(partial)
							const stage: Developers.TestStage = Match.value(result).pipe(
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
					steps.check,
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
								yield* steps.check
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
				Effect.tapCause((cause) =>
					errors.record(cause, "external").pipe(Effect.asVoid),
				),
				Effect.catchIf(
					(error) =>
						!Schema.is(Executions.StorageError)(error) &&
						!Schema.is(Executions.Conflict)(error) &&
						!Schema.is(Executions.Forbidden)(error) &&
						!Schema.is(Executions.NotFound)(error) &&
						!Schema.isSchemaError(error),
					(error) =>
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
				Effect.tap(() => steps.check),
			),
		prepare: (owner, id, input) =>
			Effect.gen(function* () {
				const test = yield* Rows.getTest(db, namespace, id)
				if (test.owner !== owner)
					return yield* Developers.DeveloperNotFound.make({})
				const issuer = yield* Option.fromNullishOr(input.issuer).pipe(
					Option.orElse(() =>
						test.value.issuers.length === 1
							? Arr.head(test.value.issuers)
							: Option.none(),
					),
					Option.filter((issuer) => test.value.issuers.includes(issuer)),
					Effect.fromOption(() =>
						Developers.DeveloperConflict.make({
							reason: "SelectDeclaredIssuer",
						}),
					),
				)
				const scopes =
					input.scopes.length === 0 ? test.value.requestedScopes : input.scopes
				const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
					Developers.DeveloperUnavailable.make({}),
				)
				const connection = yield* stores
					.bind(owner, id)
					.apps.get({ owner, connectionId: id })
					.pipe(
						Effect.catch(
							authorizationFailure(
								id,
								"Could not read the connection of a test.",
							),
						),
					)
				const pending = yield* Effect.scoped(
					withNetwork(
						owner,
						id,
						[
							issuer,
							publicOrigin,
							...(test.resourceMetadataUrl === null
								? []
								: [test.resourceMetadataUrl]),
						],
						OAuthAuthorization.prepare({
							connection,
							issuer,
							clientId: publicOrigin + "/v1/apps/client-metadata",
							redirectUri: publicOrigin + "/auth/developer/apps/callback",
							scopes,
							...(test.resourceMetadataUrl === null
								? {}
								: { resourceMetadataUrl: test.resourceMetadataUrl }),
						}),
					),
				).pipe(
					Effect.catch(
						authorizationFailure(
							id,
							"Could not start the authorization of a test.",
						),
					),
				)
				return {
					flow: pending.flow,
					authorizationUrl: pending.pending.authorizationUrl,
				}
			}),
		exchange: (owner, id, input) =>
			Effect.scoped(
				withNetwork(
					owner,
					id,
					[input.flow.metadata.issuer, input.flow.metadata.token_endpoint],
					OAuthAuthorization.redeem({
						connection: input.connection,
						flow: input.flow,
						callbackUrl: Redacted.value(input.callback),
					}),
				),
			).pipe(
				Effect.catch(
					authorizationFailure(
						id,
						"Could not exchange the test authorization code.",
					),
				),
			),
	})
})
export const layer = Layer.effect(DeveloperTestRuntime, make)
