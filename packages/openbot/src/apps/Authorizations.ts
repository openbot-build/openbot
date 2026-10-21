import {
	AppAuthorizationApi as Api,
	ConnectionsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/api"
import {
	App,
	Authorization,
	Client,
	Network,
	Store,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Schema,
} from "effect"
import { AppHost } from "./AppHost.ts"
import { AuthorizationRepository } from "./AuthorizationRepository.ts"
import { ProtocolStores } from "./ProtocolStores.ts"
import { Repository, ownerKey } from "./Repository.ts"
import { Governance } from "./Governance.ts"
import * as ClientMetadata from "./ClientMetadata.ts"
import { ConnectionLocks } from "./ConnectionLocks.ts"

export type Error =
	| ExperienceNotFound
	| ExperienceStorageUnavailable
	| ConnectionsApi.ConnectionConflict
	| ConnectionsApi.AppRestricted
	| Api.AppAuthorizationFailed
	| Api.AppAuthorizationUnavailable
	| ConnectionsApi.ConnectionCleanupPending
export interface Receipt {
	readonly flowId: string
	readonly returnTo: string
	readonly requiresLogin: boolean
}
/** Private operations read the current request identity. @effect-expect-leaking Identity */
/** A flow in these states can still go on. */
const openStatus: ReadonlyArray<Api.State["status"]> = ["Waiting", "Received"]

export class Authorizations extends Context.Service<
	Authorizations,
	{
		readonly metadata: Authorization.ClientMetadata
		readonly begin: (
			id: string,
			input: Api.Request,
		) => Effect.Effect<Api.Started, Error, Identity>
		readonly get: (id: string) => Effect.Effect<Api.State, Error, Identity>
		readonly complete: (id: string) => Effect.Effect<Api.State, Error, Identity>
		readonly revoke: (
			id: string,
		) => Effect.Effect<Api.Revocation, Error, Identity>
		readonly receive: (
			url: string,
			owner: Option.Option<string>,
		) => Effect.Effect<Receipt, Error>
	}
>()("@openbot-build/openbot/apps/Authorizations") {}

export const authorizationFailure = (reason: string) =>
	Api.AppAuthorizationFailed.make({
		reason,
		message:
			(
				{
					AlreadyConsumed:
						"This authorization has already been handled. Open My Apps to view the current connection.",
					FlowExpired:
						"This authorization expired. Start a new authorization from My Apps.",
					CimdUnsupported:
						"This authorization provider does not support the required public client metadata.",
					CallbackMismatch:
						"The callback does not match this account's authorization flow.",
					Metadata:
						"The authorization metadata does not match the App resource or issuer.",
					ScopeRequired:
						"Review the requested access and authorize the required scopes.",
					GrantRejected:
						"The authorization provider did not accept this grant. Start a new authorization if you want to try again.",
				} as Readonly<Record<string, string>>
			)[reason] ??
			"App authorization could not complete. Review the current connection before trying again.",
	})
const sdkFailure = (
	error:
		| Authorization.AuthorizationError
		| Network.NetworkError
		| Schema.SchemaError
		| Store.StoreError
		| App.AppError
		| App.CleanupPending
		| ConnectionsApi.ConnectionConfigurationInvalid,
): Error =>
	Match.value(error).pipe(
		Match.tag("AuthorizationError", ({ reason }) =>
			authorizationFailure(reason),
		),
		Match.tag("NetworkError", () => Api.AppAuthorizationUnavailable.make({})),
		Match.tag("SchemaError", () => authorizationFailure("Metadata")),
		Match.tag("StoreError", (error) =>
			error.operation === "AuthorizationRevisionChanged"
				? ConnectionsApi.ConnectionConflict.make({
						reason: "RevisionChanged",
						message: "This connection changed. Review it before authorizing.",
					})
				: error.reason === "Missing"
					? ExperienceNotFound.make({ id: "App authorization" })
					: ExperienceStorageUnavailable.make({}),
		),
		Match.tag("AppError", () => authorizationFailure("ConnectionUnavailable")),
		Match.tag("CleanupPending", (error) =>
			ConnectionsApi.ConnectionCleanupPending.make({
				connectionId: error.key.connectionId,
				stage: error.stage,
				message:
					"This connection is stopped. Retry cleanup to finish removing its account access.",
			}),
		),
		Match.tag("ConnectionConfigurationInvalid", () =>
			authorizationFailure("ConnectionUnavailable"),
		),
		Match.exhaustive,
	)
const policy = Client.InvocationPolicy.of({
	check: (invocation) =>
		Effect.fail(
			new Client.PermissionDenied({
				action: invocation.action,
				target: invocation.target,
			}),
		),
})

export const make = (
	publicOrigin: string,
): Effect.Effect<
	typeof Authorizations.Service,
	ExperienceStorageUnavailable | Authorization.AuthorizationError,
	| AppHost
	| AuthorizationRepository
	| ProtocolStores
	| Repository
	| Governance
	| ConnectionLocks
> =>
	Effect.gen(function* () {
		const factory = yield* AppHost
		const intents = yield* AuthorizationRepository
		const protocols = yield* ProtocolStores
		const repository = yield* Repository
		const governance = yield* Governance
		const locks = yield* ConnectionLocks
		const metadata = yield* ClientMetadata.metadata(publicOrigin)
		yield* intents.recover
		const owned = Effect.fn("AppAuthorizations.owned")(function* (
			owner: string,
			id: string,
		) {
			const record = yield* intents.get(id)
			if (record.owner !== owner) return yield* ExperienceNotFound.make({ id })
			return record
		})
		const read = Effect.fn("AppAuthorizations.read")(function* (
			owner: string,
			id: string,
		) {
			const record = yield* owned(owner, id)
			if (
				openStatus.includes(record.state.status) &&
				record.state.expiresAt <= (yield* Clock.currentTimeMillis)
			)
				return yield* authorizationFailure("FlowExpired")
			return record.state
		})
		const completeUnlocked = Effect.fn("AppAuthorizations.complete")(function* (
			owner: string,
			id: string,
		) {
			const pending = yield* owned(owner, id)
			const connection = yield* repository.get(
				owner,
				pending.state.connectionId,
			)
			yield* governance.check(connection.connection.cardUrl)
			const record = yield* intents.claim(owner, id)
			if (record.callback === null)
				return yield* authorizationFailure("CallbackMismatch")
			const result = yield* factory
				.bind(owner, policy)
				.completeAuthorization({
					key: { owner, connectionId: record.state.connectionId },
					flowId: id,
					callbackUrl: record.callback,
				})
				.pipe(Effect.mapError(sdkFailure), Effect.result)
			yield* Match.value(result).pipe(
				Match.tag("Success", () =>
					intents.finish(owner, id, "Succeeded", null),
				),
				Match.tag("Failure", ({ failure }) =>
					intents
						.finish(
							owner,
							id,
							"Failed",
							failure._tag === "AppAuthorizationFailed"
								? failure.reason
								: "Unavailable",
						)
						.pipe(Effect.andThen(Effect.fail(failure))),
				),
				Match.exhaustive,
			)
			return yield* read(owner, id)
		})
		const complete = Effect.fn("AppAuthorizations.completeLocked")(function* (
			owner: string,
			id: string,
		) {
			const pending = yield* owned(owner, id)
			return yield* locks.withConnection(
				{ owner, connectionId: pending.state.connectionId },
				completeUnlocked(owner, id),
			)
		})
		return Authorizations.of({
			metadata,
			begin: Effect.fn("AppAuthorizations.begin")(function* (id, input) {
				const owner = ownerKey(yield* Identity)
				const stored = yield* repository.get(owner, id)
				if (stored.revision !== input.revision)
					return yield* ConnectionsApi.ConnectionConflict.make({
						reason: "RevisionChanged",
						message: "This connection changed. Refresh it before authorizing.",
					})
				yield* governance.check(stored.connection.cardUrl)
				const app = factory.bind(owner, policy)
				const protection = yield* app
					.inspectAuthorization({ owner, connectionId: id })
					.pipe(Effect.mapError(sdkFailure))
				return yield* Match.value(protection).pipe(
					Match.when({ requiresAuthorization: false }, () =>
						Effect.succeed({ _tag: "AuthorizationNotRequired" } as const),
					),
					Match.when({ requiresAuthorization: true }, (protection) =>
						Effect.gen(function* () {
							const issuers = protection.resource.authorization_servers
							const scopes = Arr.dedupe(
								input.scopes.length === 0
									? protection.scopes.length === 0
										? (protection.resource.scopes_supported ?? [])
										: protection.scopes
									: input.scopes,
							)
							if (issuers.length > 1 && input.issuer === undefined)
								return {
									_tag: "IssuerSelectionRequired",
									issuers,
									scopes,
								} as const
							const issuer = input.issuer ?? issuers[0]
							if (!issuers.includes(issuer))
								return yield* authorizationFailure("Metadata")
							const record = yield* repository.getApp(
								owner,
								stored.connection.cardUrl,
							)
							const resource =
								record.card.remotes?.[stored.connection.remoteIndex]?.url ?? ""
							const defaults = protocols.bind(owner).flows
							const flowStore: typeof Authorization.FlowStore.Service = {
								...defaults,
								save: (flow) =>
									intents
										.begin(flow, {
											revision: stored.revision,
											returnTo: input.returnTo ?? "/",
											resource,
										})
										.pipe(
											Effect.mapError(
												(error) =>
													new Store.StoreError({
														reason:
															error._tag === "ConnectionConflict"
																? "Invalid"
																: "Unavailable",
														operation:
															error._tag === "ConnectionConflict"
																? "AuthorizationRevisionChanged"
																: "Save App authorization",
													}),
											),
										),
							}
							const pending = yield* factory
								.bind(owner, policy, flowStore)
								.beginAuthorization({
									key: { owner, connectionId: id },
									issuer,
									clientId: metadata.client_id,
									redirectUri: metadata.redirect_uris[0],
									scopes,
									...(protection.resourceMetadataUrl === undefined
										? {}
										: { resourceMetadataUrl: protection.resourceMetadataUrl }),
								})
								.pipe(Effect.mapError(sdkFailure))
							return {
								_tag: "AuthorizationStarted",
								flowId: pending.flowId,
								authorizationUrl: pending.authorizationUrl,
								issuer: pending.issuer,
								scopes: pending.scopes,
							} as const
						}),
					),
					Match.exhaustive,
				)
			}),
			get: (id) =>
				Effect.flatMap(Identity, (identity) => read(ownerKey(identity), id)),
			complete: (id) =>
				Effect.flatMap(Identity, (identity) =>
					complete(ownerKey(identity), id),
				),
			revoke: Effect.fn("AppAuthorizations.revoke")(function* (id) {
				const owner = ownerKey(yield* Identity)
				return yield* factory
					.bind(owner, policy)
					.revokeAuthorization({ owner, connectionId: id })
					.pipe(Effect.mapError(sdkFailure))
			}),
			receive: Effect.fn("AppAuthorizations.receive")(function* (input, owner) {
				const url = yield* Effect.try({
					try: () => new URL(input, publicOrigin),
					catch: () => authorizationFailure("CallbackMismatch"),
				})
				if (
					url.origin !== publicOrigin ||
					url.pathname !== "/auth/apps/callback" ||
					[...url.searchParams.keys()].some(
						(key) => url.searchParams.getAll(key).length !== 1,
					)
				)
					return yield* authorizationFailure("CallbackMismatch")
				const id = url.searchParams.get("state")
				if (id === null) return yield* authorizationFailure("CallbackMismatch")
				const record = yield* intents.get(id)
				if (Option.exists(owner, (owner) => owner !== record.owner))
					return yield* ExperienceNotFound.make({ id })
				if (record.state.status !== "Waiting")
					return yield* authorizationFailure("AlreadyConsumed")
				if (record.state.expiresAt <= (yield* Clock.currentTimeMillis))
					return yield* authorizationFailure("FlowExpired")
				const flow = yield* protocols
					.bind(record.owner)
					.flows.get({
						key: {
							owner: record.owner,
							connectionId: record.state.connectionId,
						},
						flowId: id,
					})
					.pipe(Effect.mapError(sdkFailure))
				const issuer = url.searchParams.get("iss")
				if (
					(issuer !== null && issuer !== flow.binding.issuer) ||
					(flow.metadata.authorization_response_iss_parameter_supported ===
						true &&
						issuer === null)
				)
					return yield* authorizationFailure("CallbackMismatch")
				const error = url.searchParams.get("error")
				if (error !== null)
					yield* intents.receive(id, {
						callback: null,
						status: error === "access_denied" ? "Cancelled" : "Failed",
						reason: error === "access_denied" ? null : "GrantRejected",
					})
				else {
					if (url.searchParams.get("code") === null)
						return yield* authorizationFailure("CallbackMismatch")
					yield* intents.receive(id, {
						callback: url.href,
						status: "Received",
						reason: null,
					})
					// A failed completion is already saved on the flow. The caller reads
					// that state after the redirect, so the redirect still happens.
					yield* Option.match(owner, {
						onNone: () => Effect.void,
						onSome: (owner) =>
							complete(owner, id).pipe(
								Effect.catchTag("AppAuthorizationFailed", () => Effect.void),
							),
					})
				}
				return {
					flowId: id,
					returnTo: record.state.returnTo,
					requiresLogin: Option.isNone(owner),
				}
			}),
		})
	})
export const layer = (publicOrigin: string) =>
	Layer.effect(Authorizations, make(publicOrigin))
