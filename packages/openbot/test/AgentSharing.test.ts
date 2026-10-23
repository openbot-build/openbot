import assert from "node:assert/strict"
import { test } from "node:test"
import { Session } from "@openbot-build/core"
import {
	AgentMemory,
	AgentsApi,
	RequestsApi,
	SessionView,
} from "@openbot-build/api"
import { Schema } from "effect"
import * as BrowserHost from "./BrowserHost.ts"
import { withCookie, withToken } from "./Caller.ts"

const publicOrigin = "https://sharing.example.com"

test(
	"a person joins a shared Agent by invitation and uses it in their own organization",
	{ timeout: 180000 },
	async () => {
		// Each person gets their own organization.
		const host = await BrowserHost.start({ publicOrigin, sharedDomain: false })
		try {
			const send = withCookie({ address: host.address, publicOrigin })
			const json = async <A, I>(
				schema: Schema.Codec<A, I>,
				response: Promise<Response>,
				status = 200,
			): Promise<A> => {
				const value = await response
				const body = await value.text()
				assert.equal(value.status, status, body)
				return Schema.decodeUnknownSync(schema)(JSON.parse(body))
			}
			const until = async <A>(
				label: string,
				check: () => Promise<A | undefined>,
			): Promise<A> => {
				for (let tries = 0; tries < 400; tries++) {
					const value = await check()
					if (value !== undefined) return value
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				throw new Error("Timed out: " + label)
			}
			const alice = await host.login("sharing-alice")
			const carol = await host.login("sharing-carol")
			const dave = await host.login("sharing-dave")
			assert.notEqual(
				alice.identity.organizationId,
				carol.identity.organizationId,
			)

			const guide = await json(
				AgentsApi.Agent,
				send(alice.session, "/v1/agents", "POST", {
					name: "Guide",
					role: "Answers questions",
					instructions: "Answer short.",
				}),
				201,
			)
			// Only a lasting top Agent can be shared.
			const child = await json(
				AgentsApi.Agent,
				send(alice.session, "/v1/agents", "POST", {
					name: "Child",
					role: "Helps",
					instructions: "Help.",
					agent: guide.id,
				}),
				201,
			)
			assert.equal(
				(
					await send(
						alice.session,
						`/v1/agents/${child.id}/invitations`,
						"POST",
						{},
					)
				).status,
				400,
			)

			// An invitation link, ready for a QR code.
			const link = await json(
				AgentsApi.AgentInvitationSecret,
				send(alice.session, `/v1/agents/${guide.id}/invitations`, "POST", {
					path: "/join",
				}),
				201,
			)
			assert.ok(link.secret?.startsWith(AgentsApi.InvitationSecretPrefix))
			assert.equal(link.url, publicOrigin + "/join#" + link.secret)
			assert.equal(link.invitation.email, null)
			assert.equal(link.invitation.expiresAt, null)
			const again = await json(
				AgentsApi.AgentInvitationSecret,
				send(
					alice.session,
					`/v1/agents/${guide.id}/invitations/${link.invitation.id}/secret`,
				),
			)
			assert.equal(again.secret, link.secret)
			// People of other organizations cannot manage the invitations.
			assert.equal(
				(await send(carol.session, `/v1/agents/${guide.id}/invitations`))
					.status,
				404,
			)

			// Carol accepts the link in her own organization.
			const accept = (
				session: typeof carol.session,
				payload: Record<string, unknown>,
				status = 200,
			) =>
				json(
					AgentsApi.Agent,
					send(session, "/v1/agent-invitations/accept", "POST", payload),
					status,
				)
			const linked = await accept(carol.session, { secret: link.secret })
			assert.notEqual(linked.id, guide.id)
			assert.equal(linked.name, "Guide")
			assert.deepEqual(linked.owner, {
				_tag: "Member",
				userId: carol.identity.userId,
			})
			assert.deepEqual(linked.source, {
				organizationId: alice.identity.organizationId,
				agent: guide.id,
			})
			assert.equal(
				(await accept(carol.session, { secret: link.secret })).id,
				linked.id,
			)
			const listed = await json(
				Schema.Array(AgentsApi.Agent),
				send(carol.session, "/v1/agents"),
			)
			assert.ok(listed.some((agent) => agent.id === linked.id))
			assert.deepEqual(
				(
					await json(
						Schema.Array(AgentsApi.AgentMember),
						send(alice.session, `/v1/agents/${guide.id}/members`),
					)
				).map((member) => [member.userId, member.organizationId]),
				[[carol.identity.userId, carol.identity.organizationId]],
			)

			// Only the people of the shared Agent change what it is.
			assert.equal(
				(
					await send(carol.session, `/v1/agents/${linked.id}`, "PATCH", {
						expected: linked.revision,
						instructions: "Something else.",
					})
				).status,
				400,
			)
			await json(
				AgentsApi.Agent,
				send(alice.session, `/v1/agents/${guide.id}`, "PATCH", {
					expected: guide.revision,
					name: "Guide Two",
				}),
			)
			assert.equal(
				(
					await json(
						AgentsApi.Agent,
						send(carol.session, `/v1/agents/${linked.id}`),
					)
				).name,
				"Guide Two",
			)

			// Carol works with it in her own Session, and decides its requests herself.
			const created = await json(
				SessionView,
				send(carol.session, "/v1/sessions", "POST", { agent: linked.id }),
				201,
			)
			assert.equal(created.agent, linked.id)
			const path = "/v1/sessions/" + created.session.id
			const view = () => json(SessionView, send(carol.session, path))
			const turn = (input: string) =>
				until("the Turn starts", async () => {
					const current = await view()
					const started = await send(carol.session, path + "/turns", "POST", {
						expected: current.session.revision,
						input,
					})
					if (started.status === 409) return undefined
					assert.equal(started.status, 202, await started.text())
					return true
				})
			const completed = () =>
				until("the Turn completes", async () => {
					const current = await view()
					return Session.status(current.session)._tag === "Completed"
						? current
						: undefined
				})
			await turn("Hello")
			await completed()
			await turn("This needs approval")
			const pending = await until("a pending request", async () => {
				const list = await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(carol.session, "/v1/requests?status=pending"),
				)
				return list[0]
			})
			assert.equal(pending.agent, linked.id)
			await json(
				RequestsApi.CapabilityRequest,
				send(carol.session, "/v1/requests/" + pending.id, "POST", {
					expected: pending.revision,
					decision: "allow",
					scope: "lifetime",
				}),
			)
			await completed()
			// Her decision is a Grant of her own linked Agent. The shared Agent does not get it.
			assert.equal(
				(
					await json(
						Schema.Array(AgentsApi.Grant),
						send(carol.session, `/v1/agents/${linked.id}/grants`),
					)
				).length,
				1,
			)
			assert.deepEqual(
				await json(
					Schema.Array(AgentsApi.Grant),
					send(alice.session, `/v1/agents/${guide.id}/grants`),
				),
				[],
			)

			// The Agent keeps one memory for each person, in its own organization.
			await json(
				AgentMemory.State,
				send(carol.session, `/v1/agents/${linked.id}/memory`, "POST", {
					expected: 0,
					command: {
						_tag: "Remember",
						key: "drink",
						content: "Carol likes tea.",
						kind: "preference",
					},
				}),
			)
			const aboutCarol = await json(
				AgentMemory.State,
				send(
					alice.session,
					`/v1/agents/${guide.id}/memory?person=${carol.identity.userId}`,
				),
			)
			assert.equal(aboutCarol.entries["drink"]?.content, "Carol likes tea.")
			assert.equal(
				(
					await send(
						carol.session,
						`/v1/agents/${linked.id}/memory?person=${alice.identity.userId}`,
					)
				).status,
				400,
			)

			// An email invitation shows in the list of the person, and needs the Agent route.
			const emailed = await json(
				AgentsApi.AgentInvitationSecret,
				send(alice.session, `/v1/agents/${guide.id}/invitations`, "POST", {
					email: "sharing-dave@example.com",
				}),
				201,
			)
			assert.equal(emailed.secret, null)
			const mine = (await (
				await send(dave.session, "/v1/invitations")
			).json()) as {
				readonly items: ReadonlyArray<{
					readonly id: string
					readonly agent?: { readonly id: string }
				}>
			}
			assert.deepEqual(
				mine.items.map((item) => [item.id, item.agent?.id]),
				[[emailed.invitation.id, guide.id]],
			)
			assert.equal(
				(
					await send(
						dave.session,
						`/v1/invitations/${emailed.invitation.id}/accept`,
						"POST",
					)
				).status,
				400,
			)
			assert.equal(
				(
					await send(carol.session, "/v1/agent-invitations/accept", "POST", {
						invitation: emailed.invitation.id,
					})
				).status,
				404,
			)
			const daveLinked = await accept(dave.session, {
				invitation: emailed.invitation.id,
			})
			assert.equal(
				(
					await send(dave.session, "/v1/agent-invitations/accept", "POST", {
						invitation: emailed.invitation.id,
					})
				).status,
				400,
			)

			// Leaving: archiving a linked Agent ends the membership.
			await json(
				AgentsApi.Agent,
				send(dave.session, `/v1/agents/${daveLinked.id}`, "PATCH", {
					expected: daveLinked.revision,
					archived: true,
				}),
			)
			assert.deepEqual(
				(
					await json(
						Schema.Array(AgentsApi.AgentMember),
						send(alice.session, `/v1/agents/${guide.id}/members`),
					)
				).map((member) => member.userId),
				[carol.identity.userId],
			)

			// A user token works like the session cookie.
			const erin = await host.login("sharing-erin")
			const token = (await (
				await send(erin.session, "/v1/user/tokens", "POST", { name: "join" })
			).json()) as { readonly secret: string }
			const joined = await withToken(host.address)(
				token.secret,
				"/v1/agent-invitations/accept",
				"POST",
				{ secret: link.secret },
			)
			assert.equal(joined.status, 200, await joined.clone().text())

			// A revoked link opens no more. The people who joined stay.
			assert.equal(
				(
					await send(
						alice.session,
						`/v1/agents/${guide.id}/invitations/${link.invitation.id}`,
						"DELETE",
					)
				).status,
				204,
			)
			const frank = await host.login("sharing-frank")
			assert.equal(
				(
					await send(frank.session, "/v1/agent-invitations/accept", "POST", {
						secret: link.secret,
					})
				).status,
				400,
			)
			assert.equal(
				(await send(carol.session, `/v1/agents/${linked.id}`)).status,
				200,
			)

			// When the people of the shared Agent take Carol off, her linked Agent stops.
			assert.equal(
				(
					await send(
						alice.session,
						`/v1/agents/${guide.id}/members/${carol.identity.userId}`,
						"DELETE",
					)
				).status,
				204,
			)
			assert.equal(
				(await send(carol.session, `/v1/agents/${linked.id}`)).status,
				404,
			)
		} finally {
			await host.close()
		}
	},
)
