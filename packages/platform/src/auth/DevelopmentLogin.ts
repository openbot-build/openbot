import type { BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"

/** Registered only when the local development configuration is chosen on purpose. */
export const developmentLogin = () =>
	({
		id: "openbot-development-login",
		endpoints: {
			signInDevelopment: createAuthEndpoint(
				"/development/sign-in",
				{ method: "POST" },
				async (ctx) => {
					const existing = await ctx.context.internalAdapter.findUserByEmail(
						"developer@localhost.test",
					)
					const user =
						existing?.user ??
						(await ctx.context.internalAdapter.createUser(
							{
								name: "Local Developer",
								email: "developer@localhost.test",
								emailVerified: false,
							},
							{ method: "openbot-development-login" },
						))
					const session = await ctx.context.internalAdapter.createSession(
						user.id,
					)
					await setSessionCookie(ctx, { session, user })
					return ctx.json({ success: true })
				},
			),
		},
	}) satisfies BetterAuthPlugin
