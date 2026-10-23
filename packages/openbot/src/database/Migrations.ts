import { ChatStore } from "@openbot-build/core"
import { Effect } from "effect"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { fileURLToPath } from "node:url"
import * as Shared from "../chats/ChatEncoding.ts"
import {
	appInvocations,
	developerClaims,
	developerProofs,
	developerMembers,
	developerInvitations,
	developerApps,
	developerReports,
	developerTests,
	developerTestFlows,
	developerIndexRequests,
	developerSubscriptions,
	developerNotices,
	appIndexEntries,
	appIndexJobs,
	appIndexResults,
	appAuthorizations,
	appRecords,
	appConnections,
	appDrafts,
	appSecrets,
	chats,
	chatItems,
	chatTurns,
	organizations,
	settings,
	platformAdmins,
	roles,
	modelProviders,
	models,
	providerModels,
	organizationDomains,
	ssoConnections,
	members,
	tokens,
	auditLogs,
	botRecords,
	botMemories,
	botMemoryTags,
	triggers,
	channels,
	channelIdentities,
	channelLinks,
	channelConversations,
	channelInbox,
	channelDeliveries,
	computerProviders,
	computers,
	computerAccess,
	computerPairings,
	computerCalls,
	computerUsage,
	codeRuns,
	usageEvents,
	modelPrices,
	budgets,
	organizationCredits,
	creditGrants,
	rateWindows,
} from "./Schema.ts"
import {
	openbot_auth_user,
	openbot_auth_session,
	openbot_auth_account,
	openbot_auth_verification,
} from "./AuthSchema.ts"
import * as Db from "./Database.ts"

const folder = fileURLToPath(new URL("../../migrations", import.meta.url))

export const check = Effect.gen(function* () {
	const db = yield* Db.make
	yield* db.select().from(developerClaims).limit(0)
	yield* db.select().from(developerProofs).limit(0)
	yield* db.select().from(developerMembers).limit(0)
	yield* db.select().from(developerInvitations).limit(0)
	yield* db.select().from(developerApps).limit(0)
	yield* db.select().from(developerReports).limit(0)
	yield* db.select().from(developerTests).limit(0)
	yield* db.select().from(developerTestFlows).limit(0)
	yield* db.select().from(developerIndexRequests).limit(0)
	yield* db.select().from(developerSubscriptions).limit(0)
	yield* db.select().from(developerNotices).limit(0)
	yield* db.select().from(appInvocations).limit(0)
	yield* db.select().from(appIndexEntries).limit(0)
	yield* db.select().from(appIndexJobs).limit(0)
	yield* db.select().from(appIndexResults).limit(0)
	yield* db.select().from(appAuthorizations).limit(0)
	yield* db.select().from(appRecords).limit(0)
	yield* db.select().from(appConnections).limit(0)
	yield* db.select().from(appDrafts).limit(0)
	yield* db.select().from(appSecrets).limit(0)
	yield* db.select().from(chats).limit(0)
	yield* db.select().from(chatItems).limit(0)
	yield* db.select().from(chatTurns).limit(0)
	yield* db.select().from(organizations).limit(0)
	yield* db.select().from(settings).limit(0)
	yield* db.select().from(platformAdmins).limit(0)
	yield* db.select().from(roles).limit(0)
	yield* db.select().from(modelProviders).limit(0)
	yield* db.select().from(models).limit(0)
	yield* db.select().from(providerModels).limit(0)
	yield* db.select().from(organizationDomains).limit(0)
	yield* db.select().from(ssoConnections).limit(0)
	yield* db.select().from(members).limit(0)
	yield* db.select().from(tokens).limit(0)
	yield* db.select().from(auditLogs).limit(0)
	yield* db.select().from(botRecords).limit(0)
	yield* db.select().from(botMemories).limit(0)
	yield* db.select().from(botMemoryTags).limit(0)
	yield* db.select().from(triggers).limit(0)
	yield* db.select().from(channels).limit(0)
	yield* db.select().from(channelIdentities).limit(0)
	yield* db.select().from(channelLinks).limit(0)
	yield* db.select().from(computerProviders).limit(0)
	yield* db.select().from(computers).limit(0)
	yield* db.select().from(computerAccess).limit(0)
	yield* db.select().from(computerPairings).limit(0)
	yield* db.select().from(computerCalls).limit(0)
	yield* db.select().from(computerUsage).limit(0)
	yield* db.select().from(channelConversations).limit(0)
	yield* db.select().from(channelInbox).limit(0)
	yield* db.select().from(channelDeliveries).limit(0)
	yield* db.select().from(codeRuns).limit(0)
	yield* db.select().from(usageEvents).limit(0)
	yield* db.select().from(modelPrices).limit(0)
	yield* db.select().from(budgets).limit(0)
	yield* db.select().from(organizationCredits).limit(0)
	yield* db.select().from(creditGrants).limit(0)
	yield* db.select().from(rateWindows).limit(0)
	yield* db
		.select({ id: openbot_auth_user.id })
		.from(openbot_auth_user)
		.limit(0)
	yield* db
		.select({ id: openbot_auth_session.id })
		.from(openbot_auth_session)
		.limit(0)
	yield* db
		.select({ id: openbot_auth_account.id })
		.from(openbot_auth_account)
		.limit(0)
	yield* db
		.select({ id: openbot_auth_verification.id })
		.from(openbot_auth_verification)
		.limit(0)
}).pipe(Effect.mapError(Shared.databaseError))

/** Apply the current schema with the standard Drizzle migrator, which keeps a journal. */
export const initialize = Effect.gen(function* () {
	const db = yield* Db.make
	yield* migrate(db, { migrationsFolder: folder }).pipe(
		// Keep the words of the database, so a broken migration says what broke.
		Effect.mapError(
			(error) =>
				new ChatStore.ChatStoreError({
					reason: "storage-failed",
					message: "A database migration failed: " + String(error),
				}),
		),
	)
	yield* check
}).pipe(Effect.mapError(Shared.databaseError))
