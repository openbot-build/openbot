import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Authorization, Execution } from "@openbot-build/domain"
import { Effect, Layer } from "effect"
import { Digest } from "effect/crypto"
import { Bots } from "@openbot-build/conversation-contract/bots/Bots"
import { Requests } from "@openbot-build/conversation-contract/capabilities/Requests"
import { Channels } from "@openbot-build/conversation-contract/channels/Channels"
import { Organization } from "@openbot-build/identity-contract/organization/Organization"
import * as ChannelDeliveryWork from "../src/ChannelDeliveryWork.ts"
import { ChannelQueue } from "../src/ChannelQueue.ts"
import { ChannelRegistry } from "../src/ChannelRegistry.ts"
import { ChannelWatch } from "../src/ChannelWatch.ts"
import * as ChannelWatchWork from "../src/ChannelWatchWork.ts"
import { Calls } from "@openbot-build/server-execution/Calls"
import * as Engine from "@openbot-build/server-execution/Engine"
import { Observation } from "@openbot-build/server-execution/Observation"
import {
	type MemberExecution,
	Store,
} from "@openbot-build/server-execution/Store"
import * as Workflows from "@openbot-build/server-execution/Workflows"
import { Records } from "@openbot-build/server-kernel/Records"

const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const key = { namespace: "org", id: Execution.Id.make("channel-work") }
const parent = Engine.define("test-channel-parent")
// Channel access reads only these fields.
const saved = {
	workflow: parent._tag,
	input: { channelId: "channel" },
	identity: { owner: { organizationId: "org", userId: "user" }, actor },
} as unknown as MemberExecution
const work = {
	execution: saved,
	input: { sourceExecutionId: Execution.Id.make("channel-parent") },
}
/** The parent policy allows the Channel work. */
const parentPolicy = Layer.effectDiscard(
	Effect.flatMap(Workflows.Workflows, (workflows) =>
		workflows.contribute({
			workflow: parent,
			plugin: "test",
			journal: 1,
			run: () => Effect.die("This test hosts no handler."),
			policy: Workflows.Policy.Public({ authorize: () => Effect.void }),
		}),
	),
).pipe(Layer.orDie)
const services = Layer.mergeAll(
	Layer.mock(Store, { loadMember: () => Effect.succeed(saved) }),
	Layer.mock(Channels, {
		get: () =>
			Effect.succeedSome({
				id: "channel",
				enabled: true,
				actor: "user",
			} as never),
	}),
	Layer.mock(Authorization.Auth, { check: () => Effect.void } as never),
	Layer.mock(ChannelQueue, { load: () => Effect.succeed(work as never) }),
	Layer.mock(ChannelWatch, { load: () => Effect.succeed(work as never) }),
	Layer.mock(ChannelRegistry, {}),
	Layer.mock(Observation, {}),
	Layer.mock(Calls, {}),
	Layer.mock(Records, {}),
	Layer.mock(Digest.Digest, {}),
	Layer.mock(Requests, {}),
	Layer.mock(Bots, {}),
	Layer.mock(Organization, {}),
	// ChatRecords builds its Drizzle database at once. These checks run no query.
	Layer.succeed(PgClient.PgClient, {} as never),
)

for (const [name, make] of [
	["ChannelDeliveryWork", ChannelDeliveryWork.make],
	["ChannelWatchWork", ChannelWatchWork.make],
] as const)
	for (const mode of ["advance", "replay"] as const)
		it.effect(
			`${name} answers Forbidden for ${mode} only when the parent workflow has no policy`,
			() =>
				Effect.gen(function* () {
					const failure = yield* Effect.flip(
						Effect.flatMap(make, ({ authorize }) =>
							authorize(key, actor, mode),
						).pipe(Effect.provide(Workflows.layer)),
					)
					assert.deepStrictEqual(failure, Execution.Forbidden.make({}))
					// With the parent policy, the same check passes.
					yield* Effect.flatMap(make, ({ authorize }) =>
						authorize(key, actor, mode),
					).pipe(
						Effect.provide(
							Layer.provideMerge(parentPolicy, Layer.fresh(Workflows.layer)),
						),
					)
				}).pipe(Effect.provide(services)),
		)
