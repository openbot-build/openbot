import type { AgentsApi } from "@openbot-build/api"
import { WorkflowsApi } from "@openbot-build/api"
import { and, eq } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { hash } from "../capabilities/Capability.ts"
import { workflowRecordings } from "../database/Schema.ts"
import { Calls } from "./Runs.ts"
import { unavailable } from "./Workflows.ts"

const callsCodec = Schema.fromJsonString(Schema.toCodecJson(Calls))

/**
 * The key of the recording of one `Act` step. `goal` is the goal after its templates are filled in.
 * Another goal, other input or another Agent makes a new key, so a recording never replays for other work.
 */
export const keyOf = (input: {
	readonly step: WorkflowsApi.StepId
	readonly goal: string
	readonly agent: AgentsApi.AgentId
}) => hash([input.step, input.goal, input.agent])

/** The tool calls of `Act` steps that a later check confirmed. */
export class Recordings extends Context.Service<
	Recordings,
	{
		readonly find: (
			organizationId: string,
			workflowId: string,
			key: string,
		) => Effect.Effect<
			Option.Option<Calls>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		readonly put: (
			organizationId: string,
			workflowId: string,
			input: {
				readonly key: string
				readonly step: WorkflowsApi.StepId
				readonly calls: Calls
				readonly verifiedAt: number
			},
		) => Effect.Effect<void, WorkflowsApi.WorkflowStorageUnavailable>
		readonly list: (
			organizationId: string,
			workflowId: string,
		) => Effect.Effect<
			ReadonlyArray<WorkflowsApi.Recording>,
			WorkflowsApi.WorkflowStorageUnavailable
		>
		readonly clear: (
			organizationId: string,
			workflowId: string,
		) => Effect.Effect<void, WorkflowsApi.WorkflowStorageUnavailable>
	}
>()("@openbot-build/openbot/workflows/Recordings") {}

export const make = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const decode = (text: string) =>
		Schema.decodeEffect(callsCodec)(text).pipe(Effect.mapError(unavailable))
	const of = (organizationId: string, workflowId: string) =>
		and(
			eq(workflowRecordings.organizationId, organizationId),
			eq(workflowRecordings.workflowId, workflowId),
		)
	return Recordings.of({
		find: (organizationId, workflowId, key) =>
			stored(
				db
					.select({ calls: workflowRecordings.calls })
					.from(workflowRecordings)
					.where(
						and(
							of(organizationId, workflowId),
							eq(workflowRecordings.stepKey, key),
						),
					),
			).pipe(
				Effect.flatMap((rows) =>
					rows[0] === undefined
						? Effect.succeedNone
						: Effect.asSome(decode(rows[0].calls)),
				),
			),
		put: (organizationId, workflowId, input) =>
			Schema.encodeEffect(callsCodec)(input.calls).pipe(
				Effect.mapError(unavailable),
				Effect.flatMap((calls) =>
					stored(
						db
							.insert(workflowRecordings)
							.values({
								organizationId,
								workflowId,
								stepKey: input.key,
								step: input.step,
								calls,
								verifiedAt: input.verifiedAt,
							})
							.onConflictDoUpdate({
								target: [
									workflowRecordings.organizationId,
									workflowRecordings.workflowId,
									workflowRecordings.stepKey,
								],
								set: { step: input.step, calls, verifiedAt: input.verifiedAt },
							}),
					),
				),
				Effect.asVoid,
			),
		list: (organizationId, workflowId) =>
			stored(
				db
					.select()
					.from(workflowRecordings)
					.where(of(organizationId, workflowId))
					.orderBy(workflowRecordings.step),
			).pipe(
				Effect.flatMap((rows) =>
					Effect.forEach(rows, (row) =>
						decode(row.calls).pipe(
							Effect.map((calls): WorkflowsApi.Recording => ({
								step: row.step as WorkflowsApi.StepId,
								calls,
								verifiedAt: row.verifiedAt,
							})),
						),
					),
				),
			),
		clear: (organizationId, workflowId) =>
			stored(
				db.delete(workflowRecordings).where(of(organizationId, workflowId)),
			).pipe(Effect.asVoid),
	})
})
export const layer = Layer.effect(Recordings, make)
