import { Effect, Layer } from "effect"
import { SqlMessageStorage, SqlRunnerStorage } from "effect/cluster"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { fileURLToPath } from "node:url"
import * as Shared from "../sessions/SessionEncoding.ts"
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
	refs,
	versions,
	contents,
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
	agentRecords,
	workflows,
	workflowRuns,
	workflowRecordings,
	workflowRevisions,
	workflowWaits,
} from "./Schema.ts"
import {
	openbot_auth_user,
	openbot_auth_session,
	openbot_auth_account,
	openbot_auth_verification,
} from "./AuthSchema.ts"

const folder = fileURLToPath(new URL("../../migrations", import.meta.url))

/** The table prefix of the durable execution tables of Workflow Runs. */
export const clusterPrefix = "openbot_cluster"

export const check = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
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
	yield* db
		.select({ id: refs.id, revision: refs.revision, turn: refs.turn })
		.from(refs)
		.limit(0)
	yield* db.select({ id: versions.id }).from(versions).limit(0)
	yield* db.select({ id: contents.id }).from(contents).limit(0)
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
	yield* db.select().from(agentRecords).limit(0)
	yield* db.select().from(workflows).limit(0)
	yield* db.select().from(workflowRuns).limit(0)
	yield* db.select().from(workflowRecordings).limit(0)
	yield* db.select().from(workflowRevisions).limit(0)
	yield* db.select().from(workflowWaits).limit(0)
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

/**
 * Apply the current schema with the standard Drizzle migrator, which keeps a journal.
 * Then make the tables of the durable execution. Effect keeps their own journal.
 */
export const initialize = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	yield* migrate(db, { migrationsFolder: folder })
	yield* Effect.scoped(
		Layer.build(
			Layer.mergeAll(
				SqlMessageStorage.layerMigrations({ prefix: clusterPrefix }),
				SqlRunnerStorage.layerMigrations({ prefix: clusterPrefix }),
			),
		),
	)
	yield* check
}).pipe(Effect.mapError(Shared.databaseError))
