import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, HashMap, Layer, Stream, Option } from "effect"
import { Organization } from "../src/organization/Organization.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"
import * as AuthorizationLayer from "../src/authorization/Layer.ts"
import { Roles, builtin } from "../src/authorization/Roles.ts"
import { Settings } from "../src/settings/Settings.ts"
import {
	type OrganizationDocument,
	memberDefaults,
	organizationDefaults,
} from "../src/settings/Documents.ts"
import { type AppIndexApi, Authorization } from "@openbot-build/api"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import { ProviderOAuth } from "../src/models/ProviderOAuth.ts"
import { ModelProviders } from "../src/models/ModelProviders.ts"
import { Models } from "../src/models/Models.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import { Sso } from "../src/sso/Sso.ts"
import { Billing } from "../src/billing/Billing.ts"
import { RateLimiter } from "../src/billing/RateLimit.ts"

/**
 * An organization where every account is an active Super Administrator.
 * Tests that fake the sign-in use it, because their accounts are not stored.
 */
export const layerEveryoneAdministrator = Layer.mock(Organization, {
	admit: () =>
		Effect.succeed([
			{
				organizationId: "test-org",
				name: "Test",
				status: "active" as const,
				roles: ["super_administrator"],
			},
		]),
	member: (_, userId) =>
		Effect.succeedSome({
			userId,
			email: null,
			name: null,
			status: "active" as const,
			roles: ["super_administrator" as const],
			policy: Authorization.emptyPolicy,
			joinedAt: "2026-01-01T00:00:00.000Z",
		}),
	activeMember: (_, userId) =>
		Effect.succeedSome({
			userId,
			email: null,
			name: null,
			status: "active" as const,
			roles: ["super_administrator" as const],
			policy: Authorization.emptyPolicy,
			joinedAt: "2026-01-01T00:00:00.000Z",
		}),
})

/** Only the built-in roles. */
export const layerBuiltinRoles = Layer.mock(Roles, {
	list: () => Effect.succeed(builtin),
	get: (_, roleId) =>
		Effect.succeed(Arr.findFirst(builtin, (role) => role.id === roleId)),
})

/**
 * Settings kept in memory. Without options, there are no platform settings,
 * and every organization has the defaults. A public origin or App
 * restrictions give platform settings.
 */
export const layerSettings = (
	options: {
		readonly publicOrigin?: string
		readonly appRestrictions?: ReadonlyArray<AppIndexApi.Restriction>
		readonly organization?: Partial<OrganizationDocument>
	} = {},
) =>
	Layer.mock(Settings, {
		platform:
			options.appRestrictions === undefined &&
			options.publicOrigin === undefined
				? Effect.succeedNone
				: Effect.succeedSome({
						document: {
							publicOrigin:
								options.publicOrigin ?? "https://openbot.example.com",
							authSecret: "unused",
							identityProvider: null,
							organizationCreation: "anyone" as const,
							ceiling: Authorization.emptyPolicy,
							appRestrictions: options.appRestrictions ?? [],
						},
						version: 1,
						updatedAt: 0,
					}),
		organization: () =>
			Effect.succeed({
				document: { ...organizationDefaults, ...options.organization },
				version: 0,
				updatedAt: 0,
			}),
		member: () =>
			Effect.succeed({ document: memberDefaults, version: 0, updatedAt: 0 }),
		notify: () => Effect.void,
		changes: Stream.never,
	})

/** Settings kept in memory, with no platform settings and the defaults for every organization. */
export const layerDefaultSettings = layerSettings()

/**
 * The authorizer, with what it needs for a faked member. The caller gives the
 * tokens. Nobody is a platform admin.
 */
export const layerAuthorization = AuthorizationLayer.layer.pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			layerEveryoneAdministrator,
			layerBuiltinRoles,
			layerDefaultSettings,
			Layer.mock(PlatformAdmins, {
				list: Effect.succeed([]),
				check: () => Effect.succeed(false),
			}),
		),
	),
)

/**
 * Services of the platform, model and SSO APIs for tests that build the API by
 * hand but never call those endpoints. Only the sign-in checks work.
 */
export const layerUnusedPlatform = Layer.mergeAll(
	Layer.mock(ProviderOAuth, {}),
	layerBuiltinRoles,
	layerDefaultSettings,
	Layer.succeed(RateLimiter, { hit: () => Effect.void }),
	Layer.mock(Billing, {
		reserve: () =>
			Effect.succeed({ id: Execution.CallId.make("usage_test"), startedAt: 0 }),
		unknown: () => Effect.void,
		releaseExecution: () => Effect.succeed(true),
		record: () => Effect.void,
		currentPrices: () => Effect.succeed(HashMap.empty()),
		botSpend: () => Effect.succeed(0),
		chatSpend: () => Effect.succeed(0),
	}),
	Layer.mock(PlatformAdmins, { check: () => Effect.succeed(false) }),
	Layer.mock(ModelProviders, { available: () => Effect.succeed([]) }),
	Layer.mock(Models, { available: () => Effect.succeed([]) }),
	Layer.mock(ModelRegistry, { defaultModel: Option.none() }),
	Layer.mock(Sso, {
		all: Effect.succeed([]),
		openSecret: () => Effect.succeedNone,
		providerOf: () => Effect.succeedNone,
	}),
)

/** An audit log that keeps nothing. */
export const layerNoAudit = Layer.succeed(AuditLog, {
	record: () => Effect.void,
	list: () => Effect.succeed({ items: [], next: null }),
})
