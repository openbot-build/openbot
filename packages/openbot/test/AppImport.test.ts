import { assert, it } from "@effect/vitest"
import { NodeCrypto } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	AppDiscoveryFailed,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Discovery } from "@openbot-build/protocol"
import { Effect, Layer } from "effect"
import { Connections } from "../src/apps/Connections.ts"
import * as Experience from "../src/apps/Experience.ts"
import { Lifecycle } from "../src/apps/Lifecycle.ts"

const alice = {
	kind: "member" as const,
	organizationId: "organization",
	userId: "alice",
}
const app = {
	name: "Work",
	cardUrl: "https://publisher.test/card",
	remoteIndex: 0,
}
const transfer = { format: "openbot-apps-v1" as const, apps: [app] }

/** The import with a fake `prepareConnection`. The import uses no other service on these paths. */
const importWith = (
	prepareConnection: Connections["Service"]["prepareConnection"],
) =>
	Effect.flatMap(Experience.Experience, (experience) =>
		experience.import(alice, transfer),
	).pipe(
		Effect.provide(
			Experience.layer.pipe(
				Layer.provide(
					Layer.mergeAll(
						// The import calls only `prepareConnection` of these services.
						Layer.succeed(Connections, {
							prepareConnection,
						} as Connections["Service"]),
						Layer.succeed(Lifecycle, {} as Lifecycle["Service"]),
						// Building the Drizzle database does not use the client.
						Layer.succeed(PgClient.PgClient, {} as PgClient.PgClient),
						NodeCrypto.layer,
					),
				),
			),
		),
	)

it.effect("an import tells the member why an App could not be discovered", () =>
	Effect.gen(function* () {
		const imported = yield* importWith(() =>
			Effect.fail(
				AppDiscoveryFailed.make({
					reason: "NoDeclaration",
					issues: [
						Discovery.Issue.make({
							url: "https://publisher.test/card",
							reason: "The page names no App Card.",
						}),
					],
				}),
			),
		)
		assert.deepStrictEqual(imported.entries, [
			{
				entry: app,
				draft: null,
				error:
					"The App could not be discovered (NoDeclaration). Review its public address before trying again. The page names no App Card.",
			},
		])
	}),
)

it.effect(
	"an import fails as unavailable when the storage of drafts fails",
	() =>
		Effect.gen(function* () {
			const failure = yield* Effect.flip(
				importWith(() => Effect.fail(ExperienceStorageUnavailable.make({}))),
			)
			assert.strictEqual(failure._tag, "ExperienceStorageUnavailable")
		}),
)
