import { Execution } from "@openbot-build/domain"
import * as TestCleanup from "../../apps/TestCleanup.ts"
import * as Store from "../../execution/Store.ts"
import { Array as Arr, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Authority from "./Authority.ts"
import * as Executions from "./Executions.ts"
import * as Legacy from "./LegacyApps.ts"
import * as Version from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"
import { AuthorizationHistory, History } from "./AppHistory.ts"

const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema), {
		onExcessProperty: "error",
	})

export { AppHistory, CodeHistory } from "./AppHistory.ts"
export class InvalidAppRecord extends Schema.TaggedError<
	InvalidAppRecord,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidAppRecord", { message: Schema.String }) {}
const invalid = (message: string) => InvalidAppRecord.make({ message })
const terminal = (status: string) =>
	status === "Succeeded" ||
	status === "Failed" ||
	status === "Cancelled" ||
	status === "Expired"
const appStatus = (
	value: Legacy.Invocation,
): Executions.RecordInput["status"] => {
	switch (value.status) {
		case "Completed":
			return "completed"
		case "Failed":
			return "failed"
		case "Rejected":
			return "cancelled"
		case "Sending":
			return value.readOnly ? "interrupted" : "outcome_unknown"
		case "OutcomeUnknown":
			return "outcome_unknown"
		default:
			return "interrupted"
	}
}
type Call = NonNullable<Executions.RecordInput["calls"]>[number]
type AppRow = {
	key: string
	owner: string
	id: string
	chat: string
	status: string
	body: string
}
type CodeRow = AppRow & { call_id: string }
type TestRow = {
	key: string
	namespace: string
	id: string
	owner: string
	card_url: string
	status: string
	cleanup: string
	expires_at: string
	value: string
	private_state: string | null
}
type FlowRow = {
	key: string
	namespace: string
	flow_id: string
	test_id: string
	owner: string
	status: string
	expires_at: string
	value: string
	body: string | null
	callback: string | null
	consumed: boolean
}

/** All writes join Progress.batch. Cleanup is queued for startup. No request is sent here. */
export const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	const writer = yield* Executions.make
	const store = yield* Store.Store
	const ownerOf = (owner: string) =>
		Schema.decodeEffect(Version.Owner)(owner).pipe(
			Effect.map(([organizationId, userId]) => ({ organizationId, userId })),
		)
	const imported = (
		owner: string,
		status: Executions.RecordInput["status"],
		history: Schema.Json,
	) =>
		Effect.gen(function* () {
			const member = yield* ownerOf(owner)
			return {
				_tag: "Imported" as const,
				format: 1 as const,
				source: Version.source,
				owner: member,
				authority: Authority.missing(member),
				reason:
					status === "outcome_unknown"
						? ("OutsideResultUnknown" as const)
						: status === "interrupted"
							? ("OriginalCallerMissing" as const)
							: ("History" as const),
				history,
			} satisfies Executions.Input
		})
	const open = <S extends Schema.ConstraintDecoder<unknown>>(
		schema: S,
		body: string,
		binding: ReadonlyArray<string>,
	) =>
		encode(binding).pipe(
			Effect.flatMap((aad) => secrets.open(body, aad)),
			Effect.flatMap(decode(schema)),
		)
	const app = (row: AppRow) =>
		Effect.gen(function* () {
			const value = yield* open(Legacy.Invocation, row.body, [
				"app-invocation",
				row.owner,
				row.id,
			])
			if (
				value.id !== row.id ||
				value.chat !== row.chat ||
				(value.status !== row.status &&
					!(row.status === "OutcomeUnknown" && value.status === "Sending"))
			)
				return yield* invalid("The App call indexes do not match its body.")
			if (
				(value.status === "Completed" && value.result?._tag !== "Completed") ||
				(value.status === "InputRequired" &&
					value.result?._tag !== "InputRequired") ||
				(value.result?.operationId !== undefined &&
					value.result.operationId !== value.id)
			)
				return yield* invalid("The App call result does not match its state.")
			if (
				(value.status === "Sending" || row.status === "OutcomeUnknown") &&
				value.result !== null &&
				value.result._tag !== "InputRequired" &&
				!(
					value.result._tag === "Failed" &&
					value.result.reason === "OutcomeUnknown"
				)
			)
				return yield* invalid(
					"An open App call has a final result for the same round.",
				)
			return {
				...value,
				status: yield* Schema.decodeEffect(Legacy.InvocationStatus)(row.status),
			}
		})
	const invocations = {
		name: "apps:invocations",
		read: (cursor: string | null, limit: number) =>
			sql<AppRow>`select json_build_array(owner, id)::text as key, owner, id, chat, status, body from openbot_app_invocations where (${cursor}::text is null or json_build_array(owner, id)::text > ${cursor}) order by json_build_array(owner, id)::text limit ${limit}`,
		key: (row: AppRow) => row.key,
		convert: (row: AppRow) =>
			Effect.gen(function* () {
				const value = yield* app(row)
				const status = appStatus(value)
				const previous = value.result
				if (previous?._tag === "InputRequired" && value.round === 0)
					return yield* invalid("An App input request has no saved round.")
				const known: ReadonlyArray<Call> =
					previous === null ||
					(previous._tag === "Failed" && previous.reason === "OutcomeUnknown")
						? []
						: [
								{
									step: `app:${previous._tag === "InputRequired" ? value.round - 1 : value.round}`,
									attempt: 1,
									status: "completed",
									input: { source: value.source, arguments: value.arguments },
									result: previous,
								},
							]
				const calls: ReadonlyArray<Call> =
					status === "outcome_unknown"
						? [
								...known,
								{
									step: `app:${value.round}`,
									attempt: 1,
									status: "outcome_unknown",
									input: { source: value.source, arguments: value.arguments },
									result: null,
								},
							]
						: known

				yield* writer.write({
					namespace: row.owner,
					collection: "app-invocation",
					sourceKey: row.key,
					resource: { kind: "AppCall", id: row.id },
					context: { kind: "Chat", id: value.chat },
					input: yield* imported(row.owner, status, {
						_tag: "AppCall",
						version: 1,
						invocation: value,
					}),
					status,
					calls,
					// The old App call had no time fields. Zero means that the time was not saved.
					createdAt: 0,
					updatedAt: 0,
				})
			}),
	}
	const codeRuns = {
		name: "apps:code-runs",
		read: (cursor: string | null, limit: number) =>
			sql<CodeRow>`select json_build_array(owner, id)::text as key, owner, id, chat, call_id, status, body from openbot_code_runs where (${cursor}::text is null or json_build_array(owner, id)::text > ${cursor}) order by json_build_array(owner, id)::text limit ${limit}`,
		key: (row: CodeRow) => row.key,
		convert: (row: CodeRow) =>
			Effect.gen(function* () {
				const value = yield* open(Legacy.Run, row.body, [
					"code-run",
					row.owner,
					row.id,
				])
				const owner = yield* ownerOf(row.owner)
				if (
					value.id !== row.id ||
					value.chat !== row.chat ||
					value.callId !== row.call_id ||
					value.status !== row.status ||
					value.organizationId !== owner.organizationId ||
					value.userId !== owner.userId
				)
					return yield* invalid("The Code Mode indexes do not match its body.")
				const calls = yield* Effect.forEach(value.calls, (call, index) =>
					Effect.gen(function* () {
						if (call.index !== index)
							return yield* invalid("The Code Mode call order is not valid.")
						let unknown = false
						if (call.operationId !== undefined) {
							const [found] =
								yield* sql<AppRow>`select json_build_array(owner, id)::text as key, owner, id, chat, status, body from openbot_app_invocations where owner = ${row.owner} and id = ${call.operationId}`
							if (found === undefined)
								return yield* invalid("A Code Mode call has no saved App call.")
							const linked = yield* app(found)
							if (linked.chat !== value.chat || linked.turn !== value.turn)
								return yield* invalid(
									"A Code Mode call points to another Chat or Turn.",
								)
							unknown = appStatus(linked) === "outcome_unknown"
						}
						if (unknown)
							return [
								{
									step: `code:${index}`,
									attempt: 1,
									status: "outcome_unknown",
									input: call,
									result: null,
								} satisfies Call,
							]
						return call.outcome._tag === "Waiting"
							? []
							: [
									{
										step: `code:${index}`,
										attempt: 1,
										status: "completed",
										input: call,
										result: call.outcome,
									} satisfies Call,
								]
					}),
				)
				const stored = Arr.flatten(calls)
				const unknown = Arr.some(
					stored,
					(call) => call.status === "outcome_unknown",
				)
				if (
					(value.status === "Completed" &&
						(unknown || value.result?._tag !== "Completed")) ||
					(value.status === "Failed" && value.result?._tag !== "Failed")
				)
					return yield* invalid(
						"The Code Mode result does not match its state.",
					)
				const status = unknown
					? "outcome_unknown"
					: value.status === "Completed"
						? "completed"
						: value.status === "Failed"
							? "failed"
							: value.status === "Cancelled"
								? "cancelled"
								: "interrupted"
				yield* writer.write({
					namespace: row.owner,
					collection: "code-run",
					sourceKey: row.key,
					resource: { kind: "CodeRun", id: row.id },
					context: { kind: "Chat", id: value.chat },
					input: yield* imported(row.owner, status, {
						_tag: "CodeRun",
						version: 1,
						run: value,
					}),
					status,
					calls: stored,
					createdAt: value.createdAt,
					updatedAt: value.updatedAt,
				})
			}),
	}

	const checkSecret = (row: {
		owner: string
		kind: string
		id: string
		connection_id: string
		body: string
	}) =>
		Effect.gen(function* () {
			const aad = [row.kind, row.owner, row.id]
			if (row.kind === "app-view") {
				const value = yield* open(Legacy.View, row.body, aad)
				if (value.id !== row.id || value.connectionId !== row.connection_id)
					return yield* invalid("The App view binding does not match its row.")
				return
			}
			if (row.kind === "app-view-action") {
				const value = yield* open(Legacy.ViewAction, row.body, aad)
				const [, requestId] = yield* decode(
					Schema.Tuple([Schema.String, Schema.String]),
				)(row.id)
				if (value.requestId !== requestId)
					return yield* invalid(
						"The App view action binding does not match its row.",
					)
				return
			}
			if (row.kind === "app-ui-state") {
				yield* open(Legacy.ViewState, row.body, aad)
				yield* decode(Schema.Tuple([Schema.String, Schema.String]))(row.id)
				return
			}
			const value =
				row.kind === "flow"
					? yield* open(Legacy.Flow, row.body, aad)
					: row.kind === "credential"
						? yield* open(Legacy.Credential, row.body, aad)
						: yield* invalid("The App secret kind is not known.")
			if (
				value.binding.owner !== row.owner ||
				value.binding.connectionId !== row.connection_id ||
				("flowId" in value && value.flowId !== row.id)
			)
				return yield* invalid("The App secret binding does not match its row.")
		})
	const appSecrets = {
		name: "apps:secrets",
		read: (cursor: string | null, limit: number) =>
			sql<{
				key: string
				owner: string
				kind: string
				id: string
				connection_id: string
				body: string
			}>`select json_build_array(owner, kind, id)::text as key, owner, kind, id, connection_id, body from openbot_app_secrets where (${cursor}::text is null or json_build_array(owner, kind, id)::text > ${cursor}) order by json_build_array(owner, kind, id)::text limit ${limit}`,
		key: (row: { key: string }) => row.key,
		convert: (row: {
			key: string
			owner: string
			kind: string
			id: string
			connection_id: string
			body: string
		}) =>
			checkSecret(row).pipe(
				Effect.andThen(
					progress.record("app-secret", row.key, "converted", {
						kind: row.kind,
						id: row.id,
						connectionId: row.connection_id,
					}),
				),
			),
	}

	const authorizations = {
		name: "apps:authorizations",
		read: (cursor: string | null, limit: number) =>
			sql<
				typeof Legacy.AuthorizationRow.Encoded
			>`select id, owner, connection_id, revision, expires_at::text, return_to, status, callback, reason, issuer, resource, scopes from openbot_app_authorizations where (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		key: (row: typeof Legacy.AuthorizationRow.Encoded) => row.id,
		convert: (row: typeof Legacy.AuthorizationRow.Encoded) =>
			Effect.gen(function* () {
				const value = yield* Schema.decodeEffect(Legacy.AuthorizationRow)(row)
				const callback =
					value.callback === null
						? null
						: yield* secrets.open(
								value.callback,
								yield* encode(["app-authorization", value.owner, value.id]),
							)
				const [secret] = yield* sql<{
					body: string
					consumed: boolean
				}>`select body, consumed from openbot_app_secrets where owner = ${value.owner} and kind = 'flow' and id = ${value.id}`
				const flow =
					secret === undefined
						? null
						: yield* open(Legacy.Flow, secret.body, [
								"flow",
								value.owner,
								value.id,
							])
				if (
					(!terminal(value.status) && flow === null) ||
					(flow !== null &&
						(flow.binding.owner !== value.owner ||
							flow.binding.connectionId !== value.connection_id ||
							flow.flowId !== value.id ||
							flow.binding.issuer !== value.issuer ||
							flow.binding.resource !== value.resource))
				)
					return yield* invalid(
						"An App authorization has no matching saved flow.",
					)
				const status =
					value.status === "Processing" ||
					(!terminal(value.status) && secret?.consumed === true)
						? "outcome_unknown"
						: value.status === "Succeeded"
							? "completed"
							: value.status === "Cancelled"
								? "cancelled"
								: value.status === "Failed"
									? "failed"
									: "interrupted"
				const key = yield* writer.write({
					namespace: value.owner,
					collection: "app-authorization",
					sourceKey: value.id,
					resource: { kind: "AppAuthorization", id: value.id },
					context: { kind: "Connection", id: value.connection_id },
					input: yield* imported(value.owner, status, {
						_tag: "AppAuthorization",
						version: 1,
						state: { ...value, callback },
						flow,
					}),
					status,
					createdAt: 0,
					updatedAt: 0,
					calls:
						status === "outcome_unknown"
							? [
									{
										step: "redeem",
										attempt: 1,
										status: "outcome_unknown",
										input: { flowId: value.id },
										result: null,
									},
								]
							: [],
				})
				yield* sql`update openbot_app_authorizations set execution_id = ${key.id}, status = ${status === "outcome_unknown" ? "Failed" : value.status}, reason = ${status === "outcome_unknown" ? "OutcomeUnknown" : value.reason} where id = ${value.id}`
			}),
	}
	const developerFlows = {
		name: "apps:developer-flows",
		read: (cursor: string | null, limit: number) =>
			sql<FlowRow>`select json_build_array(namespace, flow_id)::text as key, namespace, flow_id, test_id, owner, status, expires_at::text, value, body, callback, consumed from openbot_developer_test_flows where (${cursor}::text is null or json_build_array(namespace, flow_id)::text > ${cursor}) order by json_build_array(namespace, flow_id)::text limit ${limit}`,
		key: (row: FlowRow) => row.key,
		convert: (row: FlowRow) =>
			Effect.gen(function* () {
				const value = yield* decode(Legacy.TestAuthorization)(row.value)
				if (
					value.flowId !== row.flow_id ||
					value.status !== row.status ||
					value.expiresAt !== Number(row.expires_at)
				)
					return yield* invalid(
						"The developer flow indexes do not match its body.",
					)
				const flow =
					row.body === null
						? null
						: yield* secrets
								.open(
									row.body,
									(yield* encode(["developer-test", row.owner, row.test_id])) +
										":flow:" +
										row.flow_id,
								)
								.pipe(Effect.flatMap(decode(Legacy.Flow)))
				if (
					(!terminal(value.status) && flow === null) ||
					(flow !== null &&
						(flow.flowId !== row.flow_id ||
							flow.binding.owner !== row.owner ||
							flow.binding.connectionId !== row.test_id ||
							flow.binding.resource !== value.resource ||
							flow.binding.issuer !== value.issuer))
				)
					return yield* invalid(
						"The developer flow binding does not match its row.",
					)
				const callback =
					row.callback === null
						? null
						: yield* secrets.open(
								row.callback,
								yield* encode([
									"developer-callback",
									row.owner,
									row.test_id,
									row.flow_id,
								]),
							)
				const status =
					value.status === "Exchanging" ||
					(!terminal(value.status) && row.consumed)
						? "outcome_unknown"
						: value.status === "Succeeded"
							? "completed"
							: value.status === "Failed"
								? "failed"
								: terminal(value.status)
									? "cancelled"
									: "interrupted"
				yield* writer.write({
					namespace: row.owner,
					collection: "developer-flow",
					sourceKey: row.key,
					resource: { kind: "DeveloperAuthorization", id: row.flow_id },
					context: { kind: "DeveloperTest", id: row.test_id },
					input: yield* imported(row.owner, status, {
						_tag: "DeveloperAuthorization",
						version: 1,
						namespace: row.namespace,
						testId: row.test_id,
						state: value,
						flow,
						callback,
					}),
					status,
					createdAt: 0,
					updatedAt: 0,
					calls:
						status === "outcome_unknown"
							? [
									{
										step: "redeem",
										attempt: 1,
										status: "outcome_unknown",
										input: { flowId: row.flow_id },
										result: null,
									},
								]
							: [],
				})
			}),
	}
	const developerTests = {
		name: "apps:developer-tests",
		read: (cursor: string | null, limit: number) =>
			sql<TestRow>`select json_build_array(namespace, id)::text as key, namespace, id, owner, card_url, status, cleanup, expires_at::text, value, private_state from openbot_developer_tests where (${cursor}::text is null or json_build_array(namespace, id)::text > ${cursor}) order by json_build_array(namespace, id)::text limit ${limit}`,
		key: (row: TestRow) => row.key,
		convert: (row: TestRow) =>
			Effect.gen(function* () {
				const value = yield* decode(Legacy.Test)(row.value)
				if (
					value.id !== row.id ||
					value.cardUrl !== row.card_url ||
					value.status !== row.status ||
					value.cleanup !== row.cleanup ||
					value.expiresAt !== Number(row.expires_at)
				)
					return yield* invalid(
						"The developer test indexes do not match its body.",
					)
				const privateState =
					row.private_state === null
						? null
						: yield* open(Legacy.PrivateTest, row.private_state, [
								"developer-test",
								row.owner,
								row.id,
							])
				const connection = privateState?.connection
				if (
					connection != null &&
					(connection.owner !== row.owner ||
						connection.connectionId !== row.id ||
						connection.cardUrl !== row.card_url ||
						connection.endpoint !== value.endpoint)
				)
					return yield* invalid(
						"The developer test has another connection's private state.",
					)
				for (const credential of privateState?.credentials ?? []) {
					if (
						credential.credential.binding.owner !== row.owner ||
						credential.credential.binding.connectionId !== row.id ||
						credential.credential.binding.resource !== value.endpoint
					)
						return yield* invalid(
							"The developer test credential has another binding.",
						)
				}
				const authorization = connection?.authorization
				if (
					authorization?._tag === "Authorized" &&
					!Arr.some(
						privateState?.credentials ?? [],
						(entry) => entry.reference === authorization.credentialRef,
					)
				)
					return yield* invalid(
						"The developer test has no saved credential for its grant.",
					)
				if (value.authorization !== null) {
					const [flow] = yield* sql<{
						owner: string
						test_id: string
					}>`select owner, test_id from openbot_developer_test_flows where namespace = ${row.namespace} and flow_id = ${value.authorization.flowId}`
					if (
						flow === undefined ||
						flow.owner !== row.owner ||
						flow.test_id !== row.id
					)
						return yield* invalid(
							"The developer test has no matching authorization.",
						)
				}
				const unknown = value.authorization?.status === "Exchanging"
				const status = unknown
					? "outcome_unknown"
					: value.status === "Succeeded"
						? "completed"
						: value.status === "Failed"
							? "failed"
							: value.status === "Cancelled"
								? "cancelled"
								: "interrupted"
				const key = yield* writer.write({
					namespace: row.owner,
					collection: "developer-test",
					sourceKey: row.key,
					resource: { kind: "DeveloperTest", id: row.id },
					input: yield* imported(row.owner, status, {
						_tag: "DeveloperTest",
						version: 1,
						namespace: row.namespace,
						test: value,
						privateState,
					}),
					status,
					createdAt: value.createdAt,
					updatedAt: value.checkedAt ?? value.createdAt,
					calls:
						value.authorization?.status === "Exchanging"
							? [
									{
										step: "redeem",
										attempt: 1,
										status: "outcome_unknown",
										input: { flowId: value.authorization.flowId },
										result: null,
									},
								]
							: [],
				})
				const cleanup =
					privateState !== null || value.cleanup !== "Complete"
						? yield* store.submit(
								row.owner,
								Execution.CommandKey.make(
									"data-upgrade:test-expiry:" + row.key,
								),
								yield* TestCleanup.submission(
									row.namespace,
									row.owner,
									row.id,
									value.createdAt,
								),
							)
						: undefined
				const next = {
					...value,
					executionId: key.id,
					...(cleanup === undefined
						? {}
						: { cleanupExecutionId: cleanup.executionId }),
					status:
						value.status === "Running" || unknown
							? "Interrupted"
							: value.status,
					reason: unknown
						? "The authorization result is unknown. Read the saved execution before any new sign-in."
						: value.status === "Running"
							? "The old run has no saved caller or checkpoint."
							: value.reason,
				}
				yield* sql`update openbot_developer_tests set value = ${yield* encode(next)}, status = ${next.status} where namespace = ${row.namespace} and id = ${row.id}`
			}),
	}
	const run = (limit = 100) =>
		Effect.gen(function* () {
			for (const step of [
				invocations,
				codeRuns,
				appSecrets,
				authorizations,
				developerFlows,
				developerTests,
			]) {
				let complete = false
				while (!complete) {
					// Each step keeps its own input type; the batch method accepts the common union here.
					const result = yield* batch(step.name, limit)
					complete = result.complete
				}
			}
		})
	const batch = (name: string, limit: number) => {
		switch (name) {
			case invocations.name:
				return progress.batch(invocations, limit)
			case codeRuns.name:
				return progress.batch(codeRuns, limit)
			case appSecrets.name:
				return progress.batch(appSecrets, limit)
			case authorizations.name:
				return progress.batch(authorizations, limit)
			case developerFlows.name:
				return progress.batch(developerFlows, limit)
			case developerTests.name:
				return progress.batch(developerTests, limit)
			default:
				return Effect.die("The App data move step is not known.")
		}
	}
	const verify = Effect.gen(function* () {
		yield* progress.verify({
			name: "verify:app-secrets",
			read: appSecrets.read,
			key: appSecrets.key,
			check: checkSecret,
		})
		yield* progress.verify({
			name: "verify:app-history",
			read: (cursor, limit) =>
				sql<{
					id: string
					namespace: string
					input: string
					resource_kind: string
					resource_id: string
					context_kind: string | null
					context_id: string | null
				}>`select id, namespace, input, resource_kind, resource_id, context_kind, context_id from openbot_executions where workflow = ${Executions.workflowName} and resource_kind in ('AppCall', 'CodeRun', 'AppAuthorization', 'DeveloperAuthorization', 'DeveloperTest') and (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
			key: (row) => row.id,
			check: (row) =>
				Effect.gen(function* () {
					const input = yield* open(Executions.Input, row.input, [
						"execution",
						row.namespace,
						row.id,
						"input",
					])
					const history = yield* Schema.decodeUnknownEffect(History)(
						input.history,
					)
					const member = yield* ownerOf(row.namespace)
					if (!Schema.toEquivalence(Authority.Owner)(input.owner, member))
						return yield* invalid("The App history has another owner.")
					switch (history._tag) {
						case "AppCall": {
							const [source] =
								yield* sql<AppRow>`select json_build_array(owner, id)::text as key, owner, id, chat, status, body from openbot_app_invocations where owner = ${row.namespace} and id = ${history.invocation.id}`
							if (
								source === undefined ||
								row.resource_kind !== history._tag ||
								row.resource_id !== history.invocation.id ||
								row.context_kind !== "Chat" ||
								row.context_id !== history.invocation.chat ||
								!Schema.toEquivalence(Legacy.Invocation)(
									yield* app(source),
									history.invocation,
								)
							)
								return yield* invalid(
									"The saved App history does not match its source.",
								)
							break
						}
						case "CodeRun": {
							const [source] = yield* sql<{
								body: string
							}>`select body from openbot_code_runs where owner = ${row.namespace} and id = ${history.run.id}`
							if (
								source === undefined ||
								row.resource_kind !== history._tag ||
								row.resource_id !== history.run.id ||
								row.context_kind !== "Chat" ||
								row.context_id !== history.run.chat ||
								!Schema.toEquivalence(Legacy.Run)(
									yield* open(Legacy.Run, source.body, [
										"code-run",
										row.namespace,
										history.run.id,
									]),
									history.run,
								)
							)
								return yield* invalid(
									"The saved Code Mode history does not match its source.",
								)
							break
						}
						case "AppAuthorization": {
							const [source] = yield* sql<
								typeof Legacy.AuthorizationRow.Encoded & {
									execution_id: string | null
								}
							>`select execution_id, id, owner, connection_id, revision, expires_at::text, return_to, status, callback, reason, issuer, resource, scopes from openbot_app_authorizations where id = ${history.state.id}`
							if (
								source === undefined ||
								row.resource_kind !== history._tag ||
								source.owner !== row.namespace ||
								source.execution_id !== row.id ||
								row.resource_id !== history.state.id ||
								row.context_kind !== "Connection" ||
								row.context_id !== history.state.connection_id ||
								source.connection_id !== history.state.connection_id
							)
								return yield* invalid(
									"The App authorization lost its execution link.",
								)
							const callback =
								source.callback === null
									? null
									: yield* secrets.open(
											source.callback,
											yield* encode([
												"app-authorization",
												row.namespace,
												history.state.id,
											]),
										)
							if (callback !== history.state.callback)
								return yield* invalid(
									"The App callback changed during the data move.",
								)
							const state = yield* Schema.decodeEffect(Legacy.AuthorizationRow)(
								source,
							)
							if (
								!Schema.toEquivalence(AuthorizationHistory.fields.state)(
									{ ...state, callback },
									{
										...history.state,
										...(input.reason === "OutsideResultUnknown"
											? { status: "Failed" as const, reason: "OutcomeUnknown" }
											: {}),
									},
								)
							)
								return yield* invalid(
									"The App authorization changed during the data move.",
								)
							const [secret] = yield* sql<{
								body: string
							}>`select body from openbot_app_secrets where owner = ${row.namespace} and kind = 'flow' and id = ${history.state.id}`
							const flow =
								secret === undefined
									? null
									: yield* open(Legacy.Flow, secret.body, [
											"flow",
											row.namespace,
											history.state.id,
										])
							if (
								!Schema.toEquivalence(Schema.NullOr(Legacy.Flow))(
									flow,
									history.flow,
								)
							)
								return yield* invalid(
									"The App flow changed during the data move.",
								)
							break
						}
						case "DeveloperAuthorization": {
							const [source] =
								yield* sql<FlowRow>`select json_build_array(namespace, flow_id)::text as key, namespace, flow_id, test_id, owner, status, expires_at::text, value, body, callback, consumed from openbot_developer_test_flows where namespace = ${history.namespace} and flow_id = ${history.state.flowId}`
							if (
								source === undefined ||
								row.resource_kind !== history._tag ||
								row.resource_id !== history.state.flowId ||
								source.owner !== row.namespace ||
								source.test_id !== history.testId ||
								!Schema.toEquivalence(Legacy.TestAuthorization)(
									yield* decode(Legacy.TestAuthorization)(source.value),
									history.state,
								)
							)
								return yield* invalid(
									"The developer flow changed during the data move.",
								)
							const flow =
								source.body === null
									? null
									: yield* secrets
											.open(
												source.body,
												(yield* encode([
													"developer-test",
													row.namespace,
													history.testId,
												])) +
													":flow:" +
													history.state.flowId,
											)
											.pipe(Effect.flatMap(decode(Legacy.Flow)))
							if (
								!Schema.toEquivalence(Schema.NullOr(Legacy.Flow))(
									flow,
									history.flow,
								)
							)
								return yield* invalid(
									"The sealed developer flow changed during the data move.",
								)
							const callback =
								source.callback === null
									? null
									: yield* secrets.open(
											source.callback,
											yield* encode([
												"developer-callback",
												row.namespace,
												history.testId,
												history.state.flowId,
											]),
										)
							if (callback !== history.callback)
								return yield* invalid(
									"The developer callback changed during the data move.",
								)
							break
						}
						case "DeveloperTest": {
							const [source] = yield* sql<{
								owner: string
								value: string
								private_state: string | null
							}>`select owner, value, private_state from openbot_developer_tests where namespace = ${history.namespace} and id = ${history.test.id}`
							if (
								source === undefined ||
								source.owner !== row.namespace ||
								row.resource_kind !== history._tag ||
								row.resource_id !== history.test.id
							)
								return yield* invalid(
									"The developer test history has another source.",
								)
							const value = yield* Schema.decodeEffect(
								Schema.fromJsonString(
									Schema.Struct({
										executionId: Schema.String,
										...Legacy.Test.fields,
									}),
								),
							)(source.value)
							if (value.executionId !== row.id)
								return yield* invalid(
									"The developer test lost its execution link.",
								)
							const unknown = input.reason === "OutsideResultUnknown"
							const expected = {
								...history.test,
								status:
									history.test.status === "Running" || unknown
										? ("Interrupted" as const)
										: history.test.status,
								reason: unknown
									? "The authorization result is unknown. Read the saved execution before any new sign-in."
									: history.test.status === "Running"
										? "The old run has no saved caller or checkpoint."
										: history.test.reason,
							}
							if (!Schema.toEquivalence(Legacy.Test)(value, expected))
								return yield* invalid(
									"The developer test changed during the data move.",
								)
							const state =
								source.private_state === null
									? null
									: yield* open(Legacy.PrivateTest, source.private_state, [
											"developer-test",
											row.namespace,
											history.test.id,
										])
							if (
								!Schema.toEquivalence(Schema.NullOr(Legacy.PrivateTest))(
									state,
									history.privateState,
								)
							)
								return yield* invalid(
									"The developer test private state changed during the data move.",
								)
							break
						}
					}
				}),
		})
	})
	const check = Effect.gen(function* () {
		const counts = yield* sql<{ step: string; count: number }>`
			select 'apps:invocations' as step, count(*)::float8 as count from openbot_app_invocations
			union all select 'apps:code-runs', count(*)::float8 from openbot_code_runs
			union all select 'apps:secrets', count(*)::float8 from openbot_app_secrets
			union all select 'apps:authorizations', count(*)::float8 from openbot_app_authorizations
			union all select 'apps:developer-flows', count(*)::float8 from openbot_developer_test_flows
			union all select 'apps:developer-tests', count(*)::float8 from openbot_developer_tests`
		for (const count of counts) {
			const [step] = yield* sql<{
				rows: number
				complete: boolean
			}>`select rows::float8 as rows, complete from openbot_data_upgrade_steps where version = ${Progress.version} and step = ${count.step}`
			if (step === undefined || !step.complete || step.rows !== count.count)
				return yield* invalid("The App data move counts do not match.")
		}
		const expected = Arr.reduce(
			counts,
			0,
			(sum, count) => sum + (count.step === "apps:secrets" ? 0 : count.count),
		)
		const [saved] = yield* sql<{
			count: number
		}>`select count(*)::float8 as count from openbot_executions where workflow = ${Executions.workflowName} and resource_kind in ('AppCall', 'CodeRun', 'AppAuthorization', 'DeveloperAuthorization', 'DeveloperTest')`
		if (saved?.count !== expected)
			return yield* invalid("An App source row has no imported execution.")
		return counts
	})
	return { run, batch, verify, check }
})
export const run = make.pipe(Effect.flatMap((move) => move.run()))
export const verify = make.pipe(Effect.flatMap((move) => move.verify))
export const check = make.pipe(Effect.flatMap((move) => move.check))
