import type { Caller, OrganizationApi } from "@openbot-build/api"
import { Context, type Effect, Schema } from "effect"

export class AuditUnavailable extends Schema.TaggedError<
	AuditUnavailable,
	{ readonly brand: unique symbol }
>()("AuditUnavailable", { cause: Schema.Defect() }) {}

export interface Entry {
	readonly organizationId: string
	readonly action: OrganizationApi.AuditAction
	readonly actor: Caller
	readonly resource: string
	readonly details: Schema.JsonObject
}

export interface ListOptions {
	readonly after?: string
	readonly limit: number
	readonly action?: OrganizationApi.AuditAction
	readonly actor?: string
}

/** The audit log only grows. Nothing in the API can change or remove an entry. */
export class AuditLog extends Context.Service<
	AuditLog,
	{
		readonly record: (entry: Entry) => Effect.Effect<void, AuditUnavailable>
		readonly list: (
			organizationId: string,
			options: ListOptions,
		) => Effect.Effect<
			{
				readonly items: ReadonlyArray<OrganizationApi.AuditLogEntry>
				readonly next: string | null
			},
			AuditUnavailable
		>
	}
>()("@openbot-build/openbot/audit/AuditLog") {}
