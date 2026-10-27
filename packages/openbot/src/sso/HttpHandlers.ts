import { OpenBotApi, type OrganizationApi, SsoApi } from "@openbot-build/api"

import { type Caller, Identity } from "@openbot-build/domain"
import { Array as Arr, DateTime, Effect, Option, Struct } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../errors/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey } from "../audit/Resources.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { type Connection, Sso } from "./Sso.ts"

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
	createdAt: DateTime.formatIso(DateTime.makeUnsafe(connection.createdAt)),
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(connection.updatedAt)),
})

export const layer = HttpApiBuilder.group(OpenBotApi, "sso", (handlers) =>
	Effect.gen(function* () {
		const sso = yield* Sso
		const audit = yield* AuditLog
		const settings = yield* Settings
		/** The redirect URI of a connection uses the public origin of the platform now. */
		const publicOrigin = Platform.publicOriginOr(settings, () =>
			SsoApi.SsoUnavailable.make({}),
		)
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
				.pipe(
					Failures.replace("Could not write the audit log", () =>
						SsoApi.SsoUnavailable.make({}),
					),
				)
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
						params.domain,
					)
					yield* record(caller, "domain.verified", { domain: domain.domain })
					return domain
				}),
			)
			.handle("removeDomain", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					yield* sso.removeDomain(caller.organizationId, params.domain)
					yield* record(caller, "domain.removed", { domain: params.domain })
				}),
			)
			.handle("listSsoConnections", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					const items = yield* sso.listConnections(caller.organizationId)
					return {
						items: Arr.map(items, (connection) =>
							view({ connection, publicOrigin: origin }),
						),
					}
				}),
			)
			.handle("getSsoConnection", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					const found = yield* sso.getConnection(
						caller.organizationId,
						params.connectionId,
					)
					if (Option.isNone(found))
						return yield* SsoApi.SsoConnectionNotFound.make({
							connectionId: params.connectionId,
						})
					return view({ connection: found.value, publicOrigin: origin })
				}),
			)
			.handle("createSsoConnection", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					// Read the origin first, so a failure changes nothing.
					const origin = yield* publicOrigin
					const created = yield* sso.createConnection(
						caller.organizationId,
						payload,
					)
					yield* record(caller, "sso_connection.created", {
						connectionId: created.id,
						domains: [...created.domains],
					})
					return view({ connection: created, publicOrigin: origin })
				}),
			)
			.handle("updateSsoConnection", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					// Read the origin first, so a failure changes nothing.
					const origin = yield* publicOrigin
					const updated = yield* sso.updateConnection(
						caller.organizationId,
						params.connectionId,
						payload,
					)
					yield* record(caller, "sso_connection.updated", {
						connectionId: updated.id,
						changes: Arr.filter(
							Struct.keys(payload),
							(key) => key !== "expectedVersion",
						),
					})
					return view({ connection: updated, publicOrigin: origin })
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
