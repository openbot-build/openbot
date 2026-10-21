import assert from "node:assert/strict"
import { test } from "node:test"
import { SessionStore } from "@openbot-build/core"
import { AuthApi, SessionView } from "@openbot-build/api"
import { Redacted, Schema } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import * as SessionHost from "../src/sessions/SessionHost.ts"

test(
	"public record restore keeps the member, Agent and delegation identity",
	{ timeout: 30000 },
	async () => {
		const publicOrigin = "https://restore.example.test"
		const host = await BrowserHost.start({ publicOrigin })
		try {
			const alice = await host.login("restore-alice")
			const bob = await host.login("restore-bob")
			const headers = (session: Redacted.Redacted<string>) => ({
				cookie:
					AuthApi.SessionCookie +
					"=" +
					encodeURIComponent(Redacted.value(session)),
				origin: publicOrigin,
				"content-type": "application/json",
			})
			const create = async (session: Redacted.Redacted<string>) => {
				const response = await fetch(host.address + "/v1/sessions", {
					method: "POST",
					headers: headers(session),
					body: "{}",
				})
				assert.equal(response.status, 201, await response.clone().text())
				return Schema.decodeSync(SessionView)(await response.json())
			}
			const view = await create(alice.session)
			const other = await create(bob.session)
			const path = "/v1/sessions/" + view.session.id + "/record"
			const exported = await fetch(host.address + path, {
				headers: headers(alice.session),
			})
			assert.equal(exported.status, 200)
			const record = Schema.decodeSync(SessionStore.Record)(
				await exported.json(),
			)
			const savedHost = Schema.decodeUnknownSync(SessionHost.SessionHostState)(
				record.session.business[SessionHost.sessionHostId],
			)
			const restore = (
				session: Redacted.Redacted<string>,
				input: SessionHost.SessionHostState,
				expected: SessionView["session"] | null = view.session,
			) =>
				fetch(host.address + path, {
					method: "PUT",
					headers: headers(session),
					body: JSON.stringify({
						expected,
						record: {
							...record,
							session: {
								...record.session,
								business: {
									...record.session.business,
									[SessionHost.sessionHostId]: input,
								},
							},
						},
					}),
				})
			const stolen = await restore(bob.session, savedHost, null)
			assert.equal(stolen.status, 400, await stolen.clone().text())
			for (const forged of [
				{
					...savedHost,
					chain: { ...savedHost.chain, userId: bob.identity.userId },
				},
				{
					...savedHost,
					chain: { ...savedHost.chain, organizationId: "another-organization" },
				},
				{
					...savedHost,
					chain: { ...savedHost.chain, tokenId: "another-token" },
				},
				{
					...savedHost,
					agent: other.agent,
					chain: { ...savedHost.chain, agents: [other.agent] },
				},
				{ ...savedHost, kind: "review" as const, review: "another-request" },
			]) {
				const rejected = await restore(alice.session, forged)
				assert.equal(rejected.status, 400, await rejected.clone().text())
			}
			const valid = await restore(alice.session, savedHost)
			assert.equal(valid.status, 200, await valid.clone().text())
			const restored = Schema.decodeSync(SessionView)(await valid.json())
			assert.deepEqual(
				restored.session.business[SessionHost.sessionHostId],
				savedHost,
			)
			assert.equal(restored.session.id, view.session.id)
		} finally {
			await host.close()
		}
	},
)
