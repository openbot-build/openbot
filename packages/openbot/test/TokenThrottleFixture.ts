import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { Authorization, type Settings as Limits } from "@openbot-build/domain"
import { Effect, Layer } from "effect"
import { organizationDefaults } from "@openbot-build/server-kernel/settings/Documents"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import * as TokenThrottle from "@openbot-build/server-billing/billing/TokenThrottle"

export const none: Limits.TokenRateLimits = {
	organization: null,
	member: null,
	bot: null,
	token: null,
}

/** Settings with only the token rates of the platform and of the organization. */
export const settings = (
	platform: Limits.TokenRateLimits,
	organization: Limits.TokenRateLimits,
) =>
	Layer.mock(Settings, {
		platform: Effect.succeedSome({
			document: {
				publicOrigin: "https://openbot.example.com",
				authSecret: "unused",
				identityProvider: null,
				organizationCreation: "anyone" as const,
				ceiling: Authorization.emptyPolicy,
				appRestrictions: [],
				tokenRate: platform,
			},
			version: 1,
			updatedAt: 0,
		}),
		organization: () =>
			Effect.succeed({
				document: { ...organizationDefaults, tokenRate: organization },
				version: 1,
				updatedAt: 0,
			}),
	})

export const scope = (
	subjectId: string,
	tokensPerSecond = 100,
	burstTokens = 10,
): TokenThrottle.Scope => ({
	identity: { organizationId: "org", kind: "organization", subjectId },
	rate: { tokensPerSecond, burstTokens },
})

export const make = TokenThrottle.make.pipe(
	Effect.provide([ErrorRecordsFixture.layer, settings(none, none)]),
)
