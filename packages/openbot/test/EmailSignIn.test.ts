import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { AuthApi } from "@openbot-build/api"
import * as Model from "@openbot-build/domain/Access"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import {
	Cookies,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/http"
import {
	Transport,
	TransportError,
	type Message,
} from "../src/mail/Transport.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"

it.live(
	"email codes keep first access closed, grant only verified identities and cannot be replayed or used for OIDC accounts",
	() =>
		Effect.gen(function* () {
			const messages = yield* Ref.make<ReadonlyArray<Message>>([])
			const fail = yield* Ref.make(false)
			const origin = "https://email.example.com"
			const host = yield* BrowserHost.start({
				publicOrigin: origin,
				registration: { ...Model.defaults, emailSignIn: true },
				mailTransport: Layer.succeed(Transport, {
					send: (_, message) =>
						Ref.get(fail).pipe(
							Effect.flatMap((failed) =>
								failed
									? Effect.fail(TransportError.make({ cause: "Mail is down." }))
									: Ref.update(messages, Arr.append(message)),
							),
						),
				}),
			})
			const address = yield* host.address
			const call = (path: string, payload: unknown, requestOrigin = origin) =>
				HttpClientRequest.post(address + path, {
					headers: { origin: requestOrigin },
				}).pipe(
					HttpClientRequest.bodyJson(payload),
					Effect.flatMap(HttpClient.execute),
				)
			const send = (email: string, invitation?: string) =>
				call("/auth/email/send", {
					email,
					...(invitation === undefined ? {} : { invitation }),
				})
			const verify = (challenge: string, code: string) =>
				call("/auth/email/verify", { challenge, code })
			const lastCode = Effect.map(
				Ref.get(messages),
				(all) => /\b(\d{8})\b/.exec(all[all.length - 1]?.text ?? "")?.[1] ?? "",
			)
			const challenge = Schema.Struct({ challenge: Schema.String })
			const sqlRun = <A>(
				work: (
					sql: PgClient.PgClient,
				) => Effect.Effect<A, import("effect/sql").SqlError.SqlError>,
			) => host.run(Effect.flatMap(PgClient.PgClient, work))
			assert.strictEqual((yield* send("blocked@example.com")).status, 403)
			yield* host.updatePlatform((p) => ({
				...p,
				mail: {
					host: "smtp.example.com",
					port: 587,
					security: "starttls",
					from: "openbot@example.com",
					fromName: "OpenBot",
					username: null,
					password: null,
					passwordHint: null,
					invitationUrl: null,
				},
			}))
			assert.strictEqual(
				(yield* call(
					"/auth/email/send",
					{ email: "outside@example.com" },
					"https://evil.example.com",
				)).status,
				403,
			)
			const closed = yield* HttpClientResponse.schemaBodyJson(challenge)(
				yield* send("closed@example.com"),
			)
			const closedCode = yield* lastCode
			assert.strictEqual(closedCode.length, 8)
			assert.strictEqual(
				(yield* verify(closed.challenge, closedCode)).status,
				403,
			)
			assert.strictEqual(
				(yield* sqlRun((sql) => sql`select id from openbot_auth_user`)).length,
				0,
			)
			yield* sqlRun(
				(sql) =>
					sql`insert into openbot_platform_admins (email,provider_id,user_id,added_at) values ('admin@example.com','email',null,0)`,
			)
			const adminStart = yield* HttpClientResponse.schemaBodyJson(challenge)(
				yield* send("admin@example.com"),
			)
			const adminCode = yield* lastCode
			assert.strictEqual(
				(yield* call("/auth/sign-in/email-otp", {
					email: "admin@example.com",
					otp: adminCode,
				})).status,
				403,
			)
			const signed = yield* verify(adminStart.challenge, adminCode)
			assert.strictEqual(signed.status, 204)
			const cookie = Redacted.make(
				Option.getOrThrow(
					Cookies.getValue(signed.cookies, AuthApi.SessionCookie),
				),
			)
			const asAdmin = Caller.withCookie({ address, publicOrigin: origin })
			const session = yield* Caller.read(
				AuthApi.SessionInfo,
				asAdmin(cookie, "/auth/session"),
			)
			assert.strictEqual(session.platformAdmin, true)
			assert.strictEqual(session.memberships.length, 1)
			assert.strictEqual(session.memberships[0]?.kind, "personal")
			assert.strictEqual(session.memberships[0]?.ownerUserId, session.userId)
			assert.strictEqual(
				(yield* verify(adminStart.challenge, adminCode)).status,
				403,
			)
			assert.strictEqual(
				(yield* asAdmin(cookie, "/v1/platform/user_grants", "POST", {
					email: "staff@example.com",
					providerId: "email",
				})).status,
				204,
			)
			const staff = yield* HttpClientResponse.schemaBodyJson(challenge)(
				yield* send("staff@example.com"),
			)
			const staffCode = yield* lastCode
			assert.strictEqual(
				(yield* verify(Str.slice(0, -5)(staff.challenge) + "wrong", staffCode))
					.status,
				403,
			)
			assert.strictEqual(
				(yield* verify(staff.challenge, staffCode)).status,
				204,
			)
			yield* host.updatePlatform((p) => ({
				...p,
				registration: {
					...Model.defaults,
					emailSignIn: true,
					selfService: "allow",
				},
			}))
			yield* host.login("oidc-person", undefined, { organization: false })
			const other = yield* HttpClientResponse.schemaBodyJson(challenge)(
				yield* send("oidc-person@example.com"),
			)
			assert.strictEqual(
				(yield* verify(other.challenge, yield* lastCode)).status,
				403,
			)
			const wrong = yield* HttpClientResponse.schemaBodyJson(challenge)(
				yield* send("wrong@example.com"),
			)
			const rightCode = yield* lastCode
			const wrongCode = rightCode === "00000000" ? "11111111" : "00000000"
			for (let i = 0; i < 3; i++)
				assert.strictEqual(
					(yield* verify(wrong.challenge, wrongCode)).status,
					403,
				)
			assert.strictEqual(
				(yield* verify(wrong.challenge, rightCode)).status,
				403,
			)
			yield* Ref.set(fail, true)
			assert.strictEqual((yield* send("failed@example.com")).status, 503)
			assert.strictEqual((yield* send("failed@example.com")).status, 403)
		}).pipe(Effect.scoped, Effect.provide(BrowserHost.layerPlatform)),
	{ timeout: 120000 },
)
