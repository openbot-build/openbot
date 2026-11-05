import { Access } from "@openbot-build/identity-contract/access/Access"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, HashMap, Layer, Stream, Option } from "effect"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import * as AuthorizationLayer from "@openbot-build/plugin-authorization/Layer"
import {
	Roles,
	builtin,
} from "@openbot-build/identity-contract/authorization/Roles"
import { Settings } from "@openbot-build/server-kernel/settings/Settings"
import {
	type OrganizationDocument,
	memberDefaults,
	organizationDefaults,
} from "@openbot-build/server-kernel/settings/Documents"
import { type AppIndexApi, Authorization } from "@openbot-build/api"
import { PlatformAdmins } from "@openbot-build/identity-contract/platform/PlatformAdmins"
import { ProviderOAuth } from "@openbot-build/models-contract/models/ProviderOAuth"
import { ModelProviders } from "@openbot-build/models-contract/models/ModelProviders"
import { Models } from "@openbot-build/models-contract/models/Models"
import { ModelRegistry } from "@openbot-build/models-contract/models/ModelRegistry"
import { Sso } from "@openbot-build/identity-contract/sso/Sso"
import { Billing } from "@openbot-build/server-billing/billing/Billing"
import { RateLimiter } from "@openbot-build/server-billing/billing/RateLimit"
import { Mail } from "@openbot-build/identity-contract/mail/Mail"

/**
 * An organization where every account is an active Super Administrator.
 * Tests that fake the sign-in use it, because their accounts are not stored.
 */
export const layerEveryoneAdministrator = Layer.mock(Organization, {
	ensurePersonal: () => Effect.succeed("test-org"),
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
	Layer.mock(Access, {}),
	Layer.succeed(Mail, {
		signInCode: () => Effect.succeed({ status: "disabled" }),
		invitation: () => Effect.succeed({ status: "disabled" }),
		test: () => Effect.succeed({ status: "disabled" }),
	}),
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
