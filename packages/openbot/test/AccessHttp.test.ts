import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { AuthApi } from "@openbot-build/api"
import * as Model from "@openbot-build/domain/Access"
import { Effect, Option, Schema } from "effect"
import { Cookies, Headers, HttpClientResponse } from "effect/http"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"

const page = Schema.Struct({
	items: Schema.Array(Model.Request),
	next: Schema.NullOr(Schema.String),
})
it.live(
	"the real OIDC callback gates user creation and binds an invite through protected state",
	() =>
		Effect.gen(function* () {
			const origin = "https://openbot.example.com"
			const host = yield* BrowserHost.start({
				publicOrigin: origin,
				platformAdmins: ["admin@example.com"],
				registration: Model.defaults,
			})
			const admin = yield* host.login("admin", undefined, {
				organization: false,
			})
			const call = Caller.withCookie({
				address: yield* host.address,
				publicOrigin: origin,
			})
			const asAdmin = (
				path: string,
				method: "GET" | "POST" | "PATCH" = "GET",
				payload?: unknown,
			) => call(admin.session, path, method, payload)
			const me = yield* asAdmin("/auth/session")
			const session = yield* HttpClientResponse.schemaBodyJson(
				AuthApi.SessionInfo,
			)(me)
			assert.strictEqual(session.platformAdmin, true)
			assert.deepStrictEqual(session.memberships, [])
			assert.strictEqual((yield* asAdmin("/v1/platform/users")).status, 200)
			const refused = yield* host.authenticate("closed")
			assert.strictEqual(
				Option.getOrNull(Headers.get(refused.headers, "location")),
				origin + "/sign-in?reason=closed",
			)
			assert.ok(
				Option.isNone(Cookies.getValue(refused.cookies, AuthApi.SessionCookie)),
			)
			yield* host.updatePlatform((p) => ({
				...p,
				registration: { ...Model.defaults, selfService: "approval" },
			}))
			const pending = yield* host.authenticate("pending")
			assert.strictEqual(
				Option.getOrNull(Headers.get(pending.headers, "location")),
				origin + "/sign-in?reason=pending",
			)
			assert.ok(
				Option.isNone(Cookies.getValue(pending.cookies, AuthApi.SessionCookie)),
			)
			yield* host.run(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					assert.strictEqual(
						(yield* sql`select id from openbot_auth_user where email='pending@example.com'`)
							.length,
						0,
					)
				}),
			)
			const requests = yield* HttpClientResponse.schemaBodyJson(page)(
				yield* asAdmin("/v1/platform/registration_requests"),
			)
			const request = requests.items[0]!
			assert.strictEqual(
				(yield* asAdmin(
					"/v1/platform/registration_requests/" + request.id,
					"PATCH",
					{ expectedVersion: request.version, status: "approved" },
				)).status,
				204,
			)
			const person = yield* host.login("pending", undefined, {
				organization: false,
			})
			assert.strictEqual(
				(yield* call(person.session, "/v1/platform/users")).status,
				403,
			)
			assert.strictEqual(
				(yield* asAdmin(
					"/v1/platform/users/" + person.identity.userId,
					"PATCH",
					{ status: "suspended" },
				)).status,
				204,
			)
			assert.strictEqual(
				(yield* call(person.session, "/auth/session")).status,
				401,
			)
			const suspended = yield* host.authenticate("pending")
			assert.strictEqual(
				Option.getOrNull(Headers.get(suspended.headers, "location")),
				origin + "/sign-in?reason=suspended",
			)
			yield* host.updatePlatform((p) => ({
				...p,
				registration: Model.defaults,
			}))
			yield* host.run(
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					yield* sql`insert into openbot_organizations (id,name,status,created_at) values ('invite-org','Invite','active',0)`
					yield* sql`insert into openbot_invitations (id,organization_id,target,email,roles,status,invited_by,created_at,expires_at) values ('invite','invite-org','organization','guest@example.com','["member"]','pending','admin',0,9999999999999)`
				}),
			)
			const wrong = yield* host.authenticate("wrong", undefined, "invite")
			assert.strictEqual(
				Option.getOrNull(Headers.get(wrong.headers, "location")),
				origin + "/sign-in?reason=invitation",
			)
			const invited = yield* host.authenticate("guest", undefined, "invite")
			assert.ok(
				Option.isSome(Cookies.getValue(invited.cookies, AuthApi.SessionCookie)),
			)
		}).pipe(Effect.scoped, Effect.provide(BrowserHost.layerPlatform)),
	{ timeout: 120000 },
)

it.live(
	"signed group claims control mapping changes and a missing claim cannot reuse an old role",
	() =>
		Effect.gen(function* () {
			// The native test IdP callback reads this value while signing its ID token.
			let groups: unknown = ["employees"]
			const host = yield* BrowserHost.start({
				publicOrigin: "https://groups.example.com",
				registration: {
					...Model.defaults,
					sso: "allow",
					provider: {
						...Model.providerDefaults,
						trusted: true,
						groupsClaim: "groups",
						mappings: [
							{
								group: "employees",
								organizationId: "group-org",
								roles: ["member"],
							},
						],
					},
				},
				groups: () => groups,
			})
			const sqlRun = <A>(
				work: (
					sql: PgClient.PgClient,
				) => Effect.Effect<A, import("effect/sql").SqlError.SqlError>,
			) => host.run(Effect.flatMap(PgClient.PgClient, work))
			yield* sqlRun(
				(sql) =>
					sql`insert into openbot_organizations (id,name,status,created_at) values ('group-org','Group team','active',0)`,
			)
			const initial = yield* host.authenticate("staff")
			assert.ok(
				Option.isSome(Cookies.getValue(initial.cookies, AuthApi.SessionCookie)),
			)
			assert.strictEqual(
				(yield* sqlRun((sql) => sql`select role from openbot_mapped_roles`))
					.length,
				1,
			)
			groups = []
			const removed = yield* host.authenticate("staff")
			assert.ok(
				Option.isSome(Cookies.getValue(removed.cookies, AuthApi.SessionCookie)),
			)
			assert.strictEqual(
				(yield* sqlRun((sql) => sql`select role from openbot_mapped_roles`))
					.length,
				0,
			)
			groups = ["employees"]
			yield* host.authenticate("staff")
			for (const malformed of [undefined, "employees", [3]]) {
				groups = malformed
				const denied = yield* host.authenticate("staff")
				assert.strictEqual(
					Option.getOrNull(Headers.get(denied.headers, "location")),
					"https://groups.example.com/sign-in?reason=groups",
				)
				assert.ok(
					Option.isNone(
						Cookies.getValue(denied.cookies, AuthApi.SessionCookie),
					),
				)
			}
			groups = ["employees"]
			yield* host.updatePlatform((p) => ({
				...p,
				registration: {
					...p.registration!,
					provider: { ...p.registration!.provider, groupsClaim: "new_groups" },
				},
			}))
			const changed = yield* host.authenticate("staff")
			assert.strictEqual(
				Option.getOrNull(Headers.get(changed.headers, "location")),
				"https://groups.example.com/sign-in?reason=groups",
			)
		}).pipe(Effect.scoped, Effect.provide(BrowserHost.layerPlatform)),
	{ timeout: 120000 },
)
