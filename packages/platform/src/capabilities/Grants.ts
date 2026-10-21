import { randomUUID } from "node:crypto"
import type { Session } from "@openbot-build/core"
import { AgentsApi } from "@openbot-build/platform-api"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { AgentRecords } from "../agents/AgentRecords.ts"
import { covers } from "./Capability.ts"

type Grant = AgentsApi.Grant

/** Stored decisions about the capabilities of Agents. */
export class Grants extends Context.Service<
	Grants,
	{
		/**
		 * The Grant that decides a request, if there is one. A deny Grant wins over an allow Grant.
		 * Session Grants only count in their own Session.
		 */
		readonly match: (input: {
			readonly organizationId: string
			readonly agent: string
			readonly capability: AgentsApi.Capability
			readonly session: Session.Id
		}) => Effect.Effect<Option.Option<Grant>, AgentsApi.AgentStorageUnavailable>
		/** Marks a `once` Grant as used, so it does not count again. */
		readonly use: (
			organizationId: string,
			grant: Grant,
		) => Effect.Effect<void, AgentsApi.AgentStorageUnavailable>
		/** `used` keeps a `once` Grant only as a record, because its one call already has it. */
		readonly create: (
			organizationId: string,
			input: Omit<Grant, "id" | "status" | "createdAt">,
			used?: boolean,
		) => Effect.Effect<Grant, AgentsApi.AgentStorageUnavailable>
		readonly list: (
			organizationId: string,
			agent: string,
			status?: Grant["status"],
		) => Effect.Effect<ReadonlyArray<Grant>, AgentsApi.AgentStorageUnavailable>
		/** Revokes a Grant and every Grant that came from it. Returns the revoked Grants. */
		readonly revoke: (
			organizationId: string,
			agent: string,
			id: string,
		) => Effect.Effect<
			ReadonlyArray<Grant>,
			AgentsApi.AgentNotFound | AgentsApi.AgentStorageUnavailable
		>
	}
>()("@openbot-build/platform/capabilities/Grants") {}

export const make: Effect.Effect<typeof Grants.Service, never, AgentRecords> =
	Effect.gen(function* () {
		const records = yield* AgentRecords
		const grants = records.collection(
			"grant",
			AgentsApi.Grant,
			AgentsApi.GrantStatus,
		)
		const put = (organizationId: string, grant: Grant) =>
			grants
				.put(
					{
						organizationId,
						id: grant.id,
						owner: grant.agent,
						scope: grant.parent ?? "",
						status: grant.status,
					},
					grant,
				)
				.pipe(Effect.as(grant))
		const revokeTree = (
			organizationId: string,
			grant: Grant,
		): Effect.Effect<ReadonlyArray<Grant>, AgentsApi.AgentStorageUnavailable> =>
			Effect.gen(function* () {
				const revoked = yield* put(organizationId, {
					...grant,
					status: "revoked",
				})
				const children = yield* grants.list(organizationId, {
					scope: grant.id,
					status: "active",
				})
				const below = yield* Effect.forEach(children, (child) =>
					revokeTree(organizationId, child),
				)
				return [revoked, ...below.flat()]
			})
		return Grants.of({
			match: (input) =>
				grants
					.list(input.organizationId, {
						owner: input.agent,
						status: "active",
					})
					.pipe(
						Effect.map((list) => {
							const matching = list.filter(
								(grant) =>
									covers({
										stored: grant.capability,
										request: input.capability,
									}) &&
									(grant.scope !== "session" ||
										grant.session === input.session),
							)
							return Option.orElse(
								Option.fromNullishOr(
									matching.find((grant) => grant.effect === "deny"),
								),
								() => Option.fromNullishOr(matching[0]),
							)
						}),
					),
			use: (organizationId, grant) =>
				grant.scope === "once"
					? put(organizationId, { ...grant, status: "used" }).pipe(
							Effect.asVoid,
						)
					: Effect.void,
			create: (organizationId, input, used) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					return yield* put(organizationId, {
						...input,
						id: "grt_" + randomUUID().replaceAll("-", ""),
						status: used === true && input.scope === "once" ? "used" : "active",
						createdAt: now,
					})
				}),
			list: (organizationId, agent, status) =>
				grants.list(organizationId, {
					owner: agent,
					...(status === undefined ? {} : { status }),
				}),
			revoke: (organizationId, agent, id) =>
				records.transaction(
					"grant:" + organizationId + ":" + id,
					Effect.gen(function* () {
						const grant = yield* grants.find(organizationId, id)
						if (Option.isNone(grant) || grant.value.agent !== agent)
							return yield* AgentsApi.AgentNotFound.make({ agent: id })
						if (grant.value.status === "revoked") return []
						return yield* revokeTree(organizationId, grant.value)
					}),
				),
		})
	})
export const layer = Layer.effect(Grants, make)
