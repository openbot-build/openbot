import { Effect, Layer } from "effect"
import { Organization } from "../src/organization/Organization.ts"
import { AuditLog } from "../src/audit/AuditLog.ts"

/**
 * An organization where every account is an active Super Administrator.
 * Tests that fake the sign-in use it, because their accounts are not stored.
 */
export const layerEveryoneAdministrator = Layer.succeed(Organization, {
	admit: () => Effect.succeed({ organizationId: "test-org", joined: false }),
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
	get: () => Effect.die("unused"),
	update: () => Effect.die("unused"),
	listMembers: () => Effect.die("unused"),
	updateMember: () => Effect.die("unused"),
	removeMember: () => Effect.die("unused"),
})

/** An audit log that keeps nothing. */
export const layerNoAudit = Layer.succeed(AuditLog, {
	record: () => Effect.void,
	list: () => Effect.succeed({ items: [], next: null }),
})
