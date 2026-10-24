import {
	type Caller,
	Identity,
	OpenBotApi,
	type OrganizationApi,
	SsoApi,
} from "@openbot-build/api"
import { DateTime, Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey } from "../audit/Resources.ts"
import { type Connection, Sso } from "./Sso.ts"

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

/** The API form. The client secret only shows whether it is set. */
export const view = ({
	connection,
	publicOrigin,
}: {
	readonly connection: Connection
	readonly publicOrigin: string
}): SsoApi.SsoConnection => ({
	id: connection.id,
	name: connection.name,
	issuer: connection.issuer,
	clientId: connection.clientId,
	clientSecret: {
		set: connection.clientSecret !== null,
		hint: connection.clientSecretHint,
	},
	domains: connection.domains,
	enforce: connection.enforce,
	redirectUri: publicOrigin + "/auth/callback/" + connection.id,
	version: connection.version,
	createdAt: iso(connection.createdAt),
	updatedAt: iso(connection.updatedAt),
})

export const layer = (config: { readonly publicOrigin: string }) =>
	HttpApiBuilder.group(OpenBotApi, "sso", (handlers) =>
		Effect.gen(function* () {
			const sso = yield* Sso
			const audit = yield* AuditLog
			const unavailable = () => SsoApi.SsoUnavailable.make({})
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditActionOf<"domain" | "sso_connection">,
				details: Parameters<typeof audit.record>[0]["details"],
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource: organizationKey(caller.organizationId),
						details,
					})
					.pipe(Effect.mapError(unavailable))
			const toView = (connection: Connection) =>
				view({ connection, publicOrigin: config.publicOrigin })
			return handlers
				.handle("listDomains", () =>
					Effect.flatMap(Identity, (caller) =>
						sso.listDomains(caller.organizationId),
					).pipe(Effect.map((items) => ({ items }))),
				)
				.handle("addDomain", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const domain = yield* sso.addDomain(
							caller.organizationId,
							payload.domain,
						)
						yield* record(caller, "domain.added", { domain: domain.domain })
						return domain
					}),
				)
				.handle("verifyDomain", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const domain = yield* sso.verifyDomain(
							caller.organizationId,
							params.domain.toLowerCase(),
						)
						yield* record(caller, "domain.verified", { domain: domain.domain })
						return domain
					}),
				)
				.handle("removeDomain", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* sso.removeDomain(
							caller.organizationId,
							params.domain.toLowerCase(),
						)
						yield* record(caller, "domain.removed", { domain: params.domain })
					}),
				)
				.handle("listSsoConnections", () =>
					Effect.flatMap(Identity, (caller) =>
						sso.listConnections(caller.organizationId),
					).pipe(Effect.map((items) => ({ items: items.map(toView) }))),
				)
				.handle("getSsoConnection", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const found = yield* sso.getConnection(
							caller.organizationId,
							params.connectionId,
						)
						if (Option.isNone(found))
							return yield* SsoApi.SsoConnectionNotFound.make({
								connectionId: params.connectionId,
							})
						return toView(found.value)
					}),
				)
				.handle("createSsoConnection", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const created = yield* sso.createConnection(
							caller.organizationId,
							payload,
						)
						yield* record(caller, "sso_connection.created", {
							connectionId: created.id,
							domains: [...created.domains],
						})
						return toView(created)
					}),
				)
				.handle("updateSsoConnection", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const updated = yield* sso.updateConnection(
							caller.organizationId,
							params.connectionId,
							payload,
						)
						yield* record(caller, "sso_connection.updated", {
							connectionId: updated.id,
							changes: Object.keys(payload).filter(
								(key) => key !== "expectedVersion",
							),
						})
						return toView(updated)
					}),
				)
				.handle("deleteSsoConnection", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* sso.deleteConnection(
							caller.organizationId,
							params.connectionId,
						)
						yield* record(caller, "sso_connection.deleted", {
							connectionId: params.connectionId,
						})
					}),
				)
		}),
	)
