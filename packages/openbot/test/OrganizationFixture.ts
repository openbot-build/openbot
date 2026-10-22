import { Effect, Layer, Option, Stream } from "effect"
import { Organization } from "../src/organization/Organization.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"
import { Roles, builtin } from "../src/authorization/Roles.ts"
import { Settings } from "../src/settings/Settings.ts"
import {
	type OrganizationDocument,
	memberDefaults,
	organizationDefaults,
} from "../src/settings/Documents.ts"
import type { AppIndexApi } from "@openbot-build/api"
import { PlatformAdmins } from "../src/platform/PlatformAdmins.ts"
import { ModelProviders } from "../src/models/ModelProviders.ts"
import { Models } from "../src/models/Models.ts"
import { ModelRegistry } from "../src/models/ModelRegistry.ts"
import { Sso } from "../src/sso/Sso.ts"

/**
 * An organization where every account is an active Super Administrator.
 * Tests that fake the sign-in use it, because their accounts are not stored.
 */
export const layerEveryoneAdministrator = Layer.succeed(Organization, {
	admit: () =>
		Effect.succeed([
			{
				organizationId: "test-org",
				name: "Test",
				status: "active" as const,
				roles: ["super_administrator"],
			},
		]),
	memberships: () => Effect.die("unused"),
	member: (_, userId) =>
		Effect.succeedSome({
			userId,
			email: null,
			name: null,
			status: "active" as const,
			roles: ["super_administrator" as const],
			policies: [],
			joinedAt: "2026-01-01T00:00:00.000Z",
		}),
	activeMember: (_, userId) =>
		Effect.succeedSome({
			userId,
			email: null,
			name: null,
			status: "active" as const,
			roles: ["super_administrator" as const],
			policies: [],
			joinedAt: "2026-01-01T00:00:00.000Z",
		}),
	get: () => Effect.die("unused"),
	list: () => Effect.die("unused"),
	create: () => Effect.die("unused"),
	update: () => Effect.die("unused"),
	setStatus: () => Effect.die("unused"),
	listMembers: () => Effect.die("unused"),
	updateMember: () => Effect.die("unused"),
	removeMember: () => Effect.die("unused"),
	roleInUse: () => Effect.die("unused"),
})

/** Only the built-in roles. */
export const layerBuiltinRoles = Layer.succeed(Roles, {
	list: () => Effect.succeed(builtin),
	get: (_, roleId) =>
		Effect.succeed(
			Option.fromNullishOr(builtin.find((role) => role.id === roleId)),
		),
	create: () => Effect.die("unused"),
	update: () => Effect.die("unused"),
	delete: () => Effect.die("unused"),
})

/**
 * Settings kept in memory. Without options, there are no platform settings,
 * and every organization has the defaults.
 */
export const layerSettings = (
	options: {
		readonly appRestrictions?: ReadonlyArray<AppIndexApi.Restriction>
		readonly organization?: Partial<OrganizationDocument>
	} = {},
) =>
	Layer.succeed(Settings, {
		platform:
			options.appRestrictions === undefined
				? Effect.succeedNone
				: Effect.succeedSome({
						document: {
							publicOrigin: "https://openbot.example.com",
							authSecret: "unused",
							identityProvider: null,
							organizationCreation: "anyone" as const,
							policyCeiling: [],
							appRestrictions: options.appRestrictions,
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
		initializePlatform: () => Effect.die("unused"),
		updatePlatform: () => Effect.die("unused"),
		replacePlatform: () => Effect.die("unused"),
		updateOrganization: () => Effect.die("unused"),
		member: () =>
			Effect.succeed({ document: memberDefaults, version: 0, updatedAt: 0 }),
		updateMember: () => Effect.die("unused"),
		notify: () => Effect.void,
		changes: Stream.never,
	})

export const layerDefaultSettings = layerSettings()

/** What the authorization check needs for a faked member. */
export const layerAuthorization = Layer.mergeAll(
	layerEveryoneAdministrator,
	layerBuiltinRoles,
	layerDefaultSettings,
)

/**
 * Services of the platform, model and SSO APIs for tests that build the API by
 * hand but never call those endpoints. Only the sign-in checks work.
 */
export const layerUnusedPlatform = Layer.mergeAll(
	layerBuiltinRoles,
	layerDefaultSettings,
	Layer.succeed(PlatformAdmins, {
		list: Effect.die("unused"),
		add: () => Effect.die("unused"),
		remove: () => Effect.die("unused"),
		check: () => Effect.succeed(false),
	}),
	Layer.succeed(ModelProviders, {
		list: () => Effect.die("unused"),
		get: () => Effect.die("unused"),
		available: () => Effect.succeed([]),
		create: () => Effect.die("unused"),
		update: () => Effect.die("unused"),
		delete: () => Effect.die("unused"),
		openKey: () => Effect.die("unused"),
	}),
	Layer.succeed(Models, {
		list: () => Effect.die("unused"),
		get: () => Effect.die("unused"),
		available: () => Effect.succeed([]),
		create: () => Effect.die("unused"),
		update: () => Effect.die("unused"),
		delete: () => Effect.die("unused"),
	}),
	Layer.succeed(ModelRegistry, {
		catalog: () => Effect.die("unused"),
		view: () => Effect.die("unused"),
		resolve: () => Effect.die("unused"),
		rulesModel: () => Effect.die("unused"),
		agentMemoryModel: () => Effect.die("unused"),
		decision: () => Effect.die("unused"),
	}),
	Layer.succeed(Sso, {
		listDomains: () => Effect.die("unused"),
		addDomain: () => Effect.die("unused"),
		verifyDomain: () => Effect.die("unused"),
		removeDomain: () => Effect.die("unused"),
		listConnections: () => Effect.die("unused"),
		getConnection: () => Effect.die("unused"),
		createConnection: () => Effect.die("unused"),
		updateConnection: () => Effect.die("unused"),
		deleteConnection: () => Effect.die("unused"),
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
