import { createHmac } from "node:crypto"
import { createAuthEndpoint } from "better-auth/api"
import { deleteSessionCookie } from "better-auth/cookies"

// These helpers are not registered on the public SDK router. The private HTTP
// boundary verifies the service token and, for revocation, a durable auth lease.
export const read = createAuthEndpoint(
	"/private-session-read",
	{ method: "GET", requireHeaders: true },
	async (ctx) => {
		const token = await ctx.getSignedCookie(
			ctx.context.authCookies.sessionToken.name,
			ctx.context.secret,
		)
		const session =
			typeof token === "string"
				? await ctx.context.internalAdapter.findSession(token)
				: null
		if (session === null || session.session.expiresAt <= new Date()) {
			// getSession(disableRefresh) still deletes expired database rows. This probe
			// only reads the adapter, even while an identity snapshot is frozen.
			deleteSessionCookie(ctx)
			return { accountId: null }
		}
		return { accountId: session.user.id }
	},
)

export const revoke = (input: {
	readonly accountId: string
	readonly credentialDigest: string
	readonly key: string
}) =>
	createAuthEndpoint(
		"/private-session-revoke",
		{ method: "POST", requireHeaders: true },
		async (ctx) => {
			const token = await ctx.getSignedCookie(
				ctx.context.authCookies.sessionToken.name,
				ctx.context.secret,
			)
			if (
				typeof token !== "string" ||
				createHmac("sha256", input.key).update(token).digest("hex") !==
					input.credentialDigest
			)
				throw new Error(
					"Revocation credential does not match its verified receipt",
				)
			const existing = await ctx.context.internalAdapter.findSession(token)
			if (existing !== null && existing.user.id !== input.accountId)
				throw new Error(
					"Revocation account does not match its verified receipt",
				)
			if (typeof token === "string") {
				// The SDK signOut endpoint catches storage errors. A migration receipt must
				// instead fail closed until removal is confirmed by the authoritative store.
				await ctx.context.internalAdapter.deleteSession(token)
				if ((await ctx.context.internalAdapter.findSession(token)) !== null)
					throw new Error("Session revocation was not confirmed")
			}
			deleteSessionCookie(ctx)
			return { revoked: true }
		},
	)
