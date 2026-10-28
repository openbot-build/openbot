import { Provider } from "@openbot-build/core"
import { Models } from "@openbot-build/domain"
import * as Contract from "@openbot-build/domain/ProviderOAuth"
import { and, eq } from "drizzle-orm"
import {
	Clock,
	Context,
	Crypto,
	DateTime,
	Effect,
	Layer,
	Redacted,
	Result,
	Schema,
} from "effect"
import { Base64Url } from "effect/encoding"
import * as Db from "../database/Database.ts"
import {
	modelProviders,
	providerOAuth,
	providerOAuthAuthorizations,
	providerOAuthHosts,
} from "../database/Schema.ts"
import * as Failures from "../errors/Failures.ts"
import { Secrets } from "../secrets/Secrets.ts"
import {
	authorizeUrl,
	ChatGptOAuth,
	Credentials,
} from "../providers/chatgpt/OAuth.ts"
import { type Owner, ownerColumns } from "./ModelProviders.ts"

export type Errors =
	| Contract.ModelProviderLoginRequired
	| Contract.ModelProviderAuthorizationInvalid
	| Contract.ModelProviderOAuthUnavailable
	| Models.ModelProviderNotFound
	| Models.ModelProviderInvalid
	| Models.ModelProviderConflict

/** OAuth sessions belong to providers, not to callers of a model. */
export class ProviderOAuth extends Context.Service<
	ProviderOAuth,
	{
		readonly start: (
			owner: Owner,
			providerId: string,
			userId: string,
			request: Contract.StartProviderOAuthAuthorizationRequest,
		) => Effect.Effect<Contract.ProviderOAuthAuthorization, Errors>
		readonly complete: (
			owner: Owner,
			providerId: string,
			userId: string,
			id: string,
			request: Contract.CompleteProviderOAuthAuthorizationRequest,
		) => Effect.Effect<void, Errors>
		readonly disconnect: (
			owner: Owner,
			providerId: string,
		) => Effect.Effect<{ readonly revoked: boolean }, Errors>
		readonly remove: (
			owner: Owner,
			providerId: string,
		) => Effect.Effect<{ readonly revoked: boolean }, Errors>
		readonly models: (
			owner: Owner,
			providerId: string,
		) => Effect.Effect<Contract.ProviderOAuthModels, Errors>
		readonly invalidate: (
			providerId: string,
			token: Redacted.Redacted<string>,
		) => Effect.Effect<void, Errors>
		readonly accessToken: (
			providerId: string,
		) => Effect.Effect<Redacted.Redacted<string>, Errors>
	}
>()("@openbot-build/openbot/models/ProviderOAuth") {}

const Pending = Schema.Struct({
	redirectUri: Schema.String,
	state: Schema.RedactedFromValue(Schema.String),
	nonce: Schema.RedactedFromValue(Schema.String),
	verifier: Schema.RedactedFromValue(Schema.String),
	clientId: Schema.String,
	subject: Schema.optionalKey(Schema.String),
})
const Registration = Schema.Struct({
	clientId: Schema.String,
	subject: Schema.String,
	email: Schema.optionalKey(Schema.String),
})
const pendingJson = Schema.fromJsonString(Pending)
const credentialsJson = Schema.fromJsonString(Credentials)
const registrationJson = Schema.fromJsonString(Registration)
const binding = (id: string) => "openbot_provider_oauth:" + id
const pendingBinding = (id: string) =>
	"openbot_provider_oauth_authorizations:" + id
const invalid = (message: string) =>
	Contract.ModelProviderAuthorizationInvalid.make({ message })
const known = Schema.is(
	Schema.Union([
		Contract.ModelProviderLoginRequired,
		Contract.ModelProviderAuthorizationInvalid,
		Contract.ModelProviderOAuthUnavailable,
		Models.ModelProviderNotFound,
		Models.ModelProviderConflict,
		Models.ModelProviderInvalid,
	]),
)
const unavailable = Failures.map("Could not use provider sign-in", (error) =>
	known(error) ? error : Contract.ModelProviderOAuthUnavailable.make({}),
)
type Transaction = Parameters<Parameters<Db.Database["transaction"]>[0]>[0]
const ownerWhere = (owner: Owner, id: string) => {
	const columns = ownerColumns(owner)
	return and(
		eq(modelProviders.id, id),
		eq(modelProviders.ownerKind, columns.ownerKind),
		eq(modelProviders.ownerId, columns.ownerId),
	)
}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const oauth = yield* ChatGptOAuth
	const random = crypto
		.randomBytes(32)
		.pipe(Effect.orDie, Effect.map(Base64Url.encode))
	const open = (id: string, value: string) =>
		secrets
			.open(value, binding(id))
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(credentialsJson)))
	const seal = (id: string, value: Credentials) =>
		Schema.encodeEffect(credentialsJson)(value).pipe(
			Effect.flatMap((text) => secrets.seal(text, binding(id))),
		)
	const readRegistration = (id: string, value: string) =>
		secrets
			.open(value, binding(id) + ":registration")
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(registrationJson)))
	const find = (tx: Transaction, owner: Owner, id: string) =>
		Effect.gen(function* () {
			const [provider] = yield* tx
				.select()
				.from(modelProviders)
				.where(ownerWhere(owner, id))
				.for("update")
			if (provider === undefined)
				return yield* Models.ModelProviderNotFound.make({
					providerId: Provider.Id.make(id),
				})
			if (provider.kind !== "chatgpt")
				return yield* Models.ModelProviderInvalid.make({
					message: "This provider does not use ChatGPT sign-in.",
				})
			return provider
		})
	const hostId = Effect.gen(function* () {
		yield* db
			.insert(providerOAuthHosts)
			.values({
				id: "chatgpt",
				hostId: "urn:uuid:" + (yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
			})
			.onConflictDoNothing()
		const [host] = yield* db
			.select()
			.from(providerOAuthHosts)
			.where(eq(providerOAuthHosts.id, "chatgpt"))
		if (host === undefined)
			return yield* Contract.ModelProviderOAuthUnavailable.make({})
		return host.hostId
	})
	const start = Effect.fn("ProviderOAuth.start")(function* (
		owner: Owner,
		providerId: string,
		userId: string,
		request: Contract.StartProviderOAuthAuthorizationRequest,
	) {
		if (!Schema.is(Contract.ProviderOAuthRedirectUri)(request.redirectUri))
			return yield* invalid("Use a local sign-in callback address.")
		const id = yield* random
		const verifier = yield* random
		const state = yield* random
		const nonce = yield* random
		const host = yield* hostId
		const challenge = Base64Url.encode(
			yield* crypto
				.digest("SHA-256", new TextEncoder().encode(verifier))
				.pipe(Effect.orDie),
		)
		const now = yield* Clock.currentTimeMillis
		const expiresAt = now + 600_000
		return yield* db.transaction((tx) =>
			Effect.gen(function* () {
				const provider = yield* find(tx, owner, providerId)
				if (provider.version !== request.expectedVersion)
					return yield* Models.ModelProviderConflict.make({
						version: provider.version,
					})
				const [row] = yield* tx
					.select()
					.from(providerOAuth)
					.where(eq(providerOAuth.providerId, providerId))
				const registration =
					row !== undefined
						? yield* readRegistration(providerId, row.registration)
						: undefined
				const pending = {
					redirectUri: request.redirectUri,
					state: Redacted.make(state),
					nonce: Redacted.make(nonce),
					verifier: Redacted.make(verifier),
					clientId: registration?.clientId ?? "dynamic_agent_client",
					...(registration !== undefined
						? { subject: registration.subject }
						: {}),
				}
				const sealed = yield* Schema.encodeEffect(pendingJson)(pending).pipe(
					Effect.flatMap((text) => secrets.seal(text, pendingBinding(id))),
				)
				yield* tx
					.delete(providerOAuthAuthorizations)
					.where(eq(providerOAuthAuthorizations.providerId, providerId))
				yield* tx.insert(providerOAuthAuthorizations).values({
					id,
					providerId,
					userId,
					version: provider.version,
					request: sealed,
					expiresAt,
				})
				// Do not expose a retained ID token in an authorization URL returned by our API.
				return {
					id,
					url: authorizeUrl({
						clientId: pending.clientId,
						redirectUri: pending.redirectUri,
						hostId: host,
						state,
						nonce,
						challenge,
						firstRegistration: registration === undefined,
					}),
					expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
				}
			}),
		)
	}, unavailable)
	const complete = Effect.fn("ProviderOAuth.complete")(function* (
		owner: Owner,
		providerId: string,
		userId: string,
		id: string,
		request: Contract.CompleteProviderOAuthAuthorizationRequest,
	) {
		if (!Schema.is(Contract.ProviderOAuthCallbackUrl)(request.callbackUrl))
			return yield* invalid("The sign-in callback address is not valid.")
		// Commit the claim even if the exchange fails, since a code can only be used once.
		const result = yield* db.transaction((tx) =>
			Effect.gen(function* () {
				const provider = yield* find(tx, owner, providerId)
				const [row] = yield* tx
					.delete(providerOAuthAuthorizations)
					.where(
						and(
							eq(providerOAuthAuthorizations.id, id),
							eq(providerOAuthAuthorizations.providerId, providerId),
							eq(providerOAuthAuthorizations.userId, userId),
						),
					)
					.returning()
				return yield* Effect.result(
					Effect.gen(function* () {
						if (
							row === undefined ||
							row.expiresAt <= (yield* Clock.currentTimeMillis)
						)
							return yield* invalid(
								"This sign-in request has ended. Start again.",
							)
						if (row.version !== provider.version)
							return yield* Models.ModelProviderConflict.make({
								version: provider.version,
							})
						const pending = yield* secrets
							.open(row.request, pendingBinding(id))
							.pipe(Effect.flatMap(Schema.decodeUnknownEffect(pendingJson)))
						const callback = new URL(request.callbackUrl)
						if (
							callback.origin + callback.pathname !== pending.redirectUri ||
							callback.searchParams.getAll("state").length !== 1 ||
							callback.searchParams.get("state") !==
								Redacted.value(pending.state)
						)
							return yield* invalid(
								"The sign-in callback does not match the request.",
							)
						if (callback.searchParams.has("error"))
							return yield* invalid(
								"ChatGPT did not grant this sign-in request.",
							)
						const code = callback.searchParams.get("code")
						const issued = callback.searchParams.get("client_id")
						const first = pending.clientId === "dynamic_agent_client"
						if (
							code === null ||
							code.length === 0 ||
							callback.searchParams.getAll("code").length !== 1 ||
							callback.searchParams.getAll("client_id").length > 1 ||
							(first &&
								(issued === null ||
									issued.length === 0 ||
									issued === "dynamic_agent_client")) ||
							(!first && issued !== null && issued !== pending.clientId)
						)
							return yield* invalid(
								"The sign-in callback has no valid code or client ID.",
							)
						const clientId = first ? issued : pending.clientId
						if (clientId === null || clientId.length === 0)
							return yield* invalid("The sign-in client ID is missing.")
						const credentials = yield* oauth
							.exchange({
								clientId,
								code,
								redirectUri: pending.redirectUri,
								verifier: Redacted.value(pending.verifier),
								nonce: Redacted.value(pending.nonce),
								...(pending.subject === undefined
									? {}
									: { expectedSubject: pending.subject }),
							})
							.pipe(Effect.timeout("30 seconds"))
						const registration = yield* Schema.encodeEffect(registrationJson)(
							credentials,
						).pipe(
							Effect.flatMap((text) =>
								secrets.seal(text, binding(providerId) + ":registration"),
							),
						)
						const sealed = yield* seal(providerId, credentials)
						yield* tx
							.insert(providerOAuth)
							.values({ providerId, registration, credentials: sealed })
							.onConflictDoUpdate({
								target: providerOAuth.providerId,
								set: { registration, credentials: sealed },
							})
						yield* tx
							.update(modelProviders)
							.set({
								oauth: {
									connected: true,
									loginRequired: false,
									subject: credentials.subject,
									...(credentials.email === undefined
										? {}
										: { email: credentials.email }),
								},
								version: provider.version + 1,
								updatedAt: yield* Clock.currentTimeMillis,
							})
							.where(eq(modelProviders.id, providerId))
					}),
				)
			}),
		)
		return yield* Effect.fromResult(result)
	}, unavailable)
	const accessToken = Effect.fn("ProviderOAuth.accessToken")(function* (
		providerId: string,
	) {
		const result = yield* db.transaction((tx) =>
			Effect.gen(function* () {
				const [provider] = yield* tx
					.select()
					.from(modelProviders)
					.where(eq(modelProviders.id, providerId))
					.for("update")
				if (provider === undefined || provider.kind !== "chatgpt")
					return Result.fail(Contract.ModelProviderLoginRequired.make({}))
				const [row] = yield* tx
					.select()
					.from(providerOAuth)
					.where(eq(providerOAuth.providerId, providerId))
				if (row === undefined || row.credentials === null)
					return Result.fail(Contract.ModelProviderLoginRequired.make({}))
				const current = yield* open(providerId, row.credentials)
				const now = yield* Clock.currentTimeMillis
				if (
					current.expiresAt > now + 60_000 ||
					(current.expiresAt > now && (current.earliestRefreshAt ?? 0) > now)
				)
					return Result.succeed(current.accessToken)
				if ((current.earliestRefreshAt ?? 0) > now)
					return Result.fail(Contract.ModelProviderOAuthUnavailable.make({}))
				const refreshed = yield* Effect.result(
					oauth.refresh(current).pipe(Effect.timeout("30 seconds")),
				)
				if (Result.isFailure(refreshed)) {
					if (refreshed.failure._tag === "ModelProviderLoginRequired") {
						yield* tx
							.update(providerOAuth)
							.set({ credentials: null })
							.where(eq(providerOAuth.providerId, providerId))
						yield* tx
							.update(modelProviders)
							.set({
								oauth: {
									...provider.oauth,
									connected: false,
									loginRequired: true,
								},
								version: provider.version + 1,
								updatedAt: now,
							})
							.where(eq(modelProviders.id, providerId))
					}
					return Result.fail(refreshed.failure)
				}
				yield* tx
					.update(providerOAuth)
					.set({ credentials: yield* seal(providerId, refreshed.success) })
					.where(eq(providerOAuth.providerId, providerId))
				return Result.succeed(refreshed.success.accessToken)
			}),
		)
		return yield* Effect.fromResult(result)
	}, unavailable)

	const invalidate = Effect.fn("ProviderOAuth.invalidate")(function* (
		providerId: string,
		token: Redacted.Redacted<string>,
	) {
		yield* db.transaction((tx) =>
			Effect.gen(function* () {
				const [provider] = yield* tx
					.select()
					.from(modelProviders)
					.where(eq(modelProviders.id, providerId))
					.for("update")
				if (provider === undefined || provider.kind !== "chatgpt") return
				const [row] = yield* tx
					.select()
					.from(providerOAuth)
					.where(eq(providerOAuth.providerId, providerId))
				if (row === undefined || row.credentials === null) return
				const current = yield* open(providerId, row.credentials)
				// A late failure for an old token must not clear a newer connection.
				if (Redacted.value(current.accessToken) !== Redacted.value(token))
					return
				yield* tx
					.update(providerOAuth)
					.set({ credentials: null })
					.where(eq(providerOAuth.providerId, providerId))
				yield* tx
					.update(modelProviders)
					.set({
						oauth: { ...provider.oauth, connected: false, loginRequired: true },
						version: provider.version + 1,
						updatedAt: yield* Clock.currentTimeMillis,
					})
					.where(eq(modelProviders.id, providerId))
			}),
		)
	}, unavailable)
	const end = Effect.fn("ProviderOAuth.end")(function* (
		owner: Owner,
		providerId: string,
		remove: boolean,
	) {
		const credentials = yield* db.transaction((tx) =>
			Effect.gen(function* () {
				const provider = yield* find(tx, owner, providerId)
				const [row] = yield* tx
					.select()
					.from(providerOAuth)
					.where(eq(providerOAuth.providerId, providerId))
				const saved =
					row !== undefined && row.credentials !== null
						? yield* open(providerId, row.credentials)
						: undefined
				yield* tx
					.delete(providerOAuthAuthorizations)
					.where(eq(providerOAuthAuthorizations.providerId, providerId))
				if (remove)
					yield* tx
						.delete(modelProviders)
						.where(eq(modelProviders.id, providerId))
				else {
					yield* tx
						.update(providerOAuth)
						.set({ credentials: null })
						.where(eq(providerOAuth.providerId, providerId))
					yield* tx
						.update(modelProviders)
						.set({
							oauth: {
								...provider.oauth,
								connected: false,
								loginRequired: false,
							},
							version: provider.version + 1,
							updatedAt: yield* Clock.currentTimeMillis,
						})
						.where(eq(modelProviders.id, providerId))
				}
				return saved
			}),
		)
		if (credentials === undefined) return { revoked: true }
		const revoked = yield* oauth.revoke(credentials).pipe(
			Effect.timeout("30 seconds"),
			Effect.as(true),
			Failures.replace("Could not end the remote ChatGPT session", () =>
				Contract.ModelProviderOAuthUnavailable.make({}),
			),
			Effect.tapError((error) =>
				Effect.logWarning("Could not end the remote ChatGPT session", error),
			),
			Effect.orElseSucceed(() => false),
		)
		return { revoked }
	}, unavailable)
	return ProviderOAuth.of({
		start,
		complete,
		accessToken,
		invalidate,
		disconnect: (owner, id) => end(owner, id, false),
		remove: (owner, id) => end(owner, id, true),
		models: Effect.fn("ProviderOAuth.models")(function* (owner, id) {
			yield* db.transaction((tx) => find(tx, owner, id))
			const token = yield* accessToken(id)
			return yield* oauth
				.models(token)
				.pipe(
					Effect.tapError((error) =>
						error._tag === "ModelProviderLoginRequired"
							? invalidate(id, token)
							: Effect.void,
					),
				)
		}, unavailable),
	})
})
export const layer = Layer.effect(ProviderOAuth, make)
