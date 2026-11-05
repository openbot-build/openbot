import { assert, describe, it, layer } from "@effect/vitest"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Array as Arr, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as DatabasePostgres from "../src/app/DatabasePostgres.ts"
import * as RunnerManifest from "@openbot-build/server-execution/execution/RunnerManifest"
import * as TestHost from "./TestHost.ts"

const mine: RunnerManifest.Seen = {
	runnerAddress: "a:3000",
	manifestHash: "sha256:m1",
	activeHash: "sha256:a1",
}
const sameRunner = (address: string): RunnerManifest.Seen => ({
	...mine,
	runnerAddress: address,
})
const otherEntries: RunnerManifest.Seen = {
	runnerAddress: "b:3000",
	manifestHash: "sha256:m2",
	activeHash: "sha256:a2",
}
const otherActive = (activeHash: string): RunnerManifest.Seen => ({
	runnerAddress: "c:3000",
	manifestHash: mine.manifestHash,
	activeHash,
})

/** Runs the rule over beats. Each beat gives the others that it sees, and the result says when it reported. */
const beats = (list: ReadonlyArray<ReadonlyArray<RunnerManifest.Seen>>) =>
	Arr.reduce(
		list,
		{
			state: RunnerManifest.initial,
			reports: [] as ReadonlyArray<boolean>,
		},
		(acc, others) => {
			const result = RunnerManifest.compare(acc.state, mine, others)
			return {
				state: result.state,
				reports: [...acc.reports, Option.isSome(result.report)],
			}
		},
	).reports

describe("RunnerManifest.compare", () => {
	it("gives no report with no other runner or with the same plugins", () => {
		assert.deepStrictEqual(beats([[], [sameRunner("b:3000")], []]), [
			false,
			false,
			false,
		])
	})

	it("reports other entries at once and one time only", () => {
		assert.deepStrictEqual(
			beats([[otherEntries], [otherEntries], [otherEntries]]),
			[true, false, false],
		)
	})

	it("reports again when the mismatch went away and came back", () => {
		assert.deepStrictEqual(beats([[otherEntries], [], [otherEntries]]), [
			true,
			false,
			true,
		])
	})

	it("reports other active plugins only on the second beat", () => {
		const other = otherActive("sha256:a9")
		assert.deepStrictEqual(beats([[other], [other], [other]]), [
			false,
			true,
			false,
		])
	})

	it("never reports active plugins that change on each beat", () => {
		assert.deepStrictEqual(
			beats([
				[otherActive("sha256:x1")],
				[otherActive("sha256:x2")],
				[otherActive("sha256:x3")],
			]),
			[false, false, false],
		)
	})

	it("names every different runner in the report, sorted by address", () => {
		const result = RunnerManifest.compare(RunnerManifest.initial, mine, [
			otherActive("sha256:a9"),
			otherEntries,
			sameRunner("d:3000"),
		])
		assert.isTrue(Option.isSome(result.report))
		assert.deepStrictEqual(
			Option.map(result.report, (report) =>
				Arr.map(report.others, (other) => other.runnerAddress),
			),
			Option.some(["b:3000", "c:3000"]),
		)
	})
})

const manifest = (hash: string): RunnerManifest.Manifest => ({
	manifestHash: hash,
	activeHash: "sha256:active",
	plugins: [
		{ id: "audit", name: "@openbot-build/plugin-audit", disabled: false },
	],
	forks: ["@openbot-build/plugin-audit"],
	workflows: ["chat"],
	features: [{ id: "memory", version: 1 }],
})

const processA = "00000000-0000-4000-8000-00000000000a"
const processB = "00000000-0000-4000-8000-00000000000b"

// The database is a real server, so these tests use the real clock.
layer(TestHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "120 seconds",
})((it) => {
	it.effect(
		"the store keeps one row for each runner, and old rows expire",
		() =>
			Effect.gen(function* () {
				const options = yield* TestHost.makeSettings
				yield* TestHost.migrate(options)
				yield* Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient
					const store = yield* RunnerManifest.makeStore
					const rows = sql<{
						readonly runner_address: string
						readonly manifest_hash: string
					}>`select runner_address, manifest_hash from openbot_execution_runners order by runner_address`

					yield* store.write("a:3000", processA, manifest("sha256:1"))
					yield* store.write("a:3000", processA, manifest("sha256:2"))
					assert.deepStrictEqual(
						Arr.map(yield* rows, (row) => [
							row.runner_address,
							row.manifest_hash,
						]),
						[["a:3000", "sha256:2"]],
					)
					// Its own row is never one of the others.
					assert.deepStrictEqual(yield* store.others("a:3000"), [])

					yield* store.write("b:3000", processB, manifest("sha256:3"))
					assert.deepStrictEqual(yield* store.others("a:3000"), [
						{
							runnerAddress: "b:3000",
							manifestHash: "sha256:3",
							activeHash: "sha256:active",
						},
					])

					// A runner that has not written for two minutes is not live.
					yield* sql`update openbot_execution_runners set seen_at = now() - interval '2 minutes' where runner_address = 'b:3000'`
					assert.deepStrictEqual(yield* store.others("a:3000"), [])
					yield* store.expire
					assert.strictEqual((yield* rows).length, 2)

					// After eleven minutes the row goes away. A fresh row stays.
					yield* sql`update openbot_execution_runners set seen_at = now() - interval '11 minutes' where runner_address = 'b:3000'`
					yield* store.expire
					assert.deepStrictEqual(
						Arr.map(yield* rows, (row) => row.runner_address),
						["a:3000"],
					)

					// Only the process that wrote the row deletes it.
					yield* store.remove("a:3000", processB)
					assert.strictEqual((yield* rows).length, 1)
					yield* store.remove("a:3000", processA)
					assert.strictEqual((yield* rows).length, 0)
				}).pipe(
					Effect.provide(
						DatabasePostgres.layer(options).pipe(
							Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
						),
					),
				)
			}),
	)

	it.effect("a new process at the same address starts a new row", () =>
		Effect.gen(function* () {
			const options = yield* TestHost.makeSettings
			yield* TestHost.migrate(options)
			yield* Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				const store = yield* RunnerManifest.makeStore
				const started = sql<{
					readonly started_at: Date
					readonly process_id: string
				}>`select started_at, process_id from openbot_execution_runners`
				yield* store.write("a:3000", processA, manifest("sha256:1"))
				yield* sql`update openbot_execution_runners set started_at = now() - interval '1 hour'`
				const first = yield* started
				yield* store.write("a:3000", processA, manifest("sha256:1"))
				assert.deepStrictEqual(yield* started, first)
				yield* store.write("a:3000", processB, manifest("sha256:1"))
				const second = yield* started
				assert.strictEqual(second[0]?.process_id, processB)
				assert.isTrue(
					(second[0]?.started_at.getTime() ?? 0) >
						(first[0]?.started_at.getTime() ?? 0),
				)
			}).pipe(
				Effect.provide(
					DatabasePostgres.layer(options).pipe(
						Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
					),
				),
			)
		}),
	)
})
