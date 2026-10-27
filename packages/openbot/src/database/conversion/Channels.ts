import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Authority from "./Authority.ts"
import * as Executions from "./Executions.ts"
import * as Legacy from "./LegacyV1.ts"
import * as Rows from "./LegacyChannels.ts"
import * as Progress from "./Progress.ts"

export class Invalid extends Schema.TaggedError<
	Invalid,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidChannel", { message: Schema.String }) {}
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema))
const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema), {
		onExcessProperty: "error",
	})
type Row = { key: string; body: string }

/** Run after seal:reminder. Each row and its execution link commit with the batch cursor. */
export const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	const executions = yield* Executions.make
	const owner = (organizationId: string, userId: string) => ({
		organizationId,
		userId,
	})
	const write = (
		input: Omit<Executions.RecordInput, "namespace" | "input"> & {
			readonly owner: typeof Authority.Owner.Type
			readonly reason: Executions.Input["reason"]
			readonly history: Schema.Json
		},
	) =>
		Effect.gen(function* () {
			const { owner, reason, history, ...record } = input
			return yield* executions.write({
				...record,
				namespace: yield* encode([owner.organizationId, owner.userId]),
				input: {
					_tag: "Imported",
					format: 1,
					source: Legacy.source,
					owner,
					authority: Authority.missing(owner),
					reason,
					history,
				},
			})
		})
	const batch = <E>(
		name: string,
		read: (
			cursor: string | null,
			limit: number,
		) => Effect.Effect<ReadonlyArray<Row>, E>,
		convert: (row: Row) => Effect.Effect<void, E>,
	) =>
		Effect.gen(function* () {
			let complete = false
			while (!complete) {
				const result = yield* progress.batch(
					{ name, read, key: (row) => row.key, convert },
					100,
				)
				complete = result.complete
			}
		})
	const channelOwner = (organizationId: string, id: string) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				actor: string
			}>`select actor from openbot_channels where organization_id = ${organizationId} and id = ${id}`
			if (row === undefined)
				return yield* Invalid.make({
					message: "The Channel of a saved item is missing.",
				})
			return owner(organizationId, row.actor)
		})

	yield* batch(
		"import:channels",
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(c)::text as body from openbot_channels c where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.Channel)(row.body)
				if (record.execution_id !== null)
					return yield* Invalid.make({
						message: "An old Channel already has an execution.",
					})
				const credentials = yield* secrets
					.open(record.credentials, `openbot_channels:${record.id}:credentials`)
					.pipe(Effect.flatMap(decodeBody(Rows.Credentials)))
				yield* decodeBody(Rows.Hints)(record.hints)
				if (credentials.kind !== record.kind)
					return yield* Invalid.make({
						message: "The Channel kind does not match its secrets.",
					})
				const person = owner(record.organization_id, record.actor)
				const {
					credentials: _credentials,
					hints: _hints,
					execution_id: _executionId,
					...history
				} = record
				const key = yield* write({
					collection: "channel",
					sourceKey: row.key,
					owner: person,
					resource: { kind: "Channel", id: record.id },
					reason: "OriginalCallerMissing",
					status: "interrupted",
					history,
					createdAt: record.created_at,
					updatedAt: record.updated_at,
				})
				// Null is a missing authority, never a session cookie or an unrestricted token.
				const sealed = yield* secrets.seal(
					yield* encode({ credentials, caller: null }),
					`openbot_channels:${record.id}:credentials`,
				)
				yield* sql`update openbot_channels set credentials = ${sealed}, execution_id = ${key.id} where organization_id = ${record.organization_id} and id = ${record.id}`
				yield* progress.record("channel", row.key, "needs_authorization", {
					executionId: key.id,
					authority: Authority.missing(person),
				})
			}),
	)

	yield* batch(
		"import:channel-inbox",
		(cursor, limit) =>
			sql<Row>`select json_build_array(channel_id, event_id)::text as key, (to_jsonb(i) || jsonb_build_object('position', migration_position))::text as body from (select old.*, row_number() over (order by received_at, event_id, channel_id) as migration_position from openbot_channel_inbox old) i where (${cursor}::text is null or json_build_array(channel_id, event_id)::text > ${cursor}) order by json_build_array(channel_id, event_id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.Inbox)(row.body)
				if (record.execution_id !== null)
					return yield* Invalid.make({
						message: "An old Channel input already has an execution.",
					})
				const event = yield* decodeBody(Rows.Event)(record.event)
				if (
					event.eventId !== record.event_id ||
					event.conversation.key !== record.conversation_key
				)
					return yield* Invalid.make({
						message: "The Channel input indexes do not match its body.",
					})
				const person = yield* channelOwner(
					record.organization_id,
					record.channel_id,
				)
				const { event: _event, execution_id: _executionId, ...history } = record
				const unknown =
					record.done_at === null &&
					(record.claim !== null || record.attempts > 0)
				const key = yield* write({
					collection: "channel-input",
					sourceKey: row.key,
					owner: person,
					resource: {
						kind: "ChannelInput",
						id: record.channel_id + ":" + record.event_id,
					},
					context: { kind: "Channel", id: record.channel_id },
					// The old done time also covered discarded input. It is not proof of success.
					reason: unknown
						? "OutsideResultUnknown"
						: record.done_at === null
							? "OriginalCallerMissing"
							: "CheckpointMissing",
					status: unknown ? "outcome_unknown" : "interrupted",
					history: { ...history, event },
					createdAt: record.received_at,
					updatedAt: record.done_at ?? record.received_at,
					calls: unknown
						? [
								{
									step: "handle-input",
									attempt: Math.max(1, record.attempts),
									status: "outcome_unknown",
									input: event,
									result: null,
								},
							]
						: [],
				})
				// The new serial column was filled in table order. Keep the old input order instead.
				yield* sql`update openbot_channel_inbox set event = ${key.id}, execution_id = ${key.id}, position = ${record.position}, claim = null, lease_until = 0 where channel_id = ${record.channel_id} and event_id = ${record.event_id}`
				yield* progress.record(
					"channel-input",
					row.key,
					"needs_authorization",
					{ executionId: key.id, authority: Authority.missing(person) },
				)
			}),
	)

	yield* batch(
		"import:channel-deliveries",
		(cursor, limit) =>
			sql<Row>`select id as key, to_jsonb(d)::text as body from openbot_channel_deliveries d where (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.Delivery)(row.body)
				if (record.execution_id !== null)
					return yield* Invalid.make({
						message: "An old Channel delivery already has an execution.",
					})
				const target = yield* decodeBody(Rows.Target)(record.target)
				const message = yield* decodeBody(Rows.Message)(record.body)
				const ref =
					record.ref === null
						? null
						: yield* decodeBody(Rows.MessageRef)(record.ref)
				if (record.state === "done" && ref === null)
					return yield* Invalid.make({
						message: "A sent Channel message has no saved reference.",
					})
				const person = yield* channelOwner(
					record.organization_id,
					record.channel_id,
				)
				const {
					target: _target,
					body: _body,
					ref: _ref,
					execution_id: _executionId,
					...history
				} = record
				// A claimed send or an old live reply can have reached the platform without a result.
				const unknown =
					record.state !== "done" &&
					(record.claim !== null ||
						record.attempts > 0 ||
						record.state === "live")
				const status = unknown
					? "outcome_unknown"
					: record.state === "done"
						? "completed"
						: record.state === "failed"
							? "failed"
							: "interrupted"
				const key = yield* write({
					collection: "channel-delivery",
					sourceKey: row.key,
					owner: person,
					resource: { kind: "ChannelDelivery", id: record.id },
					context: { kind: "Channel", id: record.channel_id },
					reason: unknown
						? "OutsideResultUnknown"
						: status === "interrupted"
							? "OriginalCallerMissing"
							: "History",
					status,
					history: { ...history, target, message, ref },
					createdAt: record.updated_at,
					updatedAt: record.updated_at,
					calls:
						unknown || status === "completed"
							? [
									{
										step: "send",
										attempt: Math.max(1, record.attempts),
										status: unknown ? "outcome_unknown" : "completed",
										input: { target, message },
										result: unknown ? null : ref,
									},
								]
							: [],
				})
				yield* sql`update openbot_channel_deliveries set target = ${key.id}, body = ${key.id}, execution_id = ${key.id}, state = ${status === "completed" ? "done" : status}, claim = null, lease_until = 0 where id = ${record.id}`
				yield* progress.record(
					"channel-delivery",
					row.key,
					status === "completed" || status === "failed"
						? "converted"
						: "needs_authorization",
					{ executionId: key.id, authority: Authority.missing(person) },
				)
			}),
	)

	yield* batch(
		"import:triggers",
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(t)::text as body from openbot_triggers t where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.Trigger)(row.body)
				if (record.schedule_execution_id !== null)
					return yield* Invalid.make({
						message: "An old trigger already has an execution.",
					})
				if (
					record.schedule_cron === null &&
					(record.schedule_time_zone !== null || record.next_run_at !== null)
				)
					return yield* Invalid.make({
						message: "The trigger has a time but no schedule.",
					})
				const person = owner(record.organization_id, record.actor)
				const { schedule_execution_id: _executionId, ...history } = record
				const key = yield* write({
					collection: "trigger",
					sourceKey: row.key,
					owner: person,
					resource: { kind: "Trigger", id: record.id },
					reason: "OriginalCallerMissing",
					status: "interrupted",
					history,
					createdAt: record.created_at,
					updatedAt: record.updated_at,
				})
				const sealed = yield* secrets.seal(
					yield* encode({ prompt: record.prompt, caller: null }),
					yield* encode(["trigger", record.organization_id, record.id]),
				)
				yield* sql`update openbot_triggers set prompt = ${sealed}, schedule_execution_id = ${key.id} where organization_id = ${record.organization_id} and id = ${record.id}`
				yield* progress.record("trigger", row.key, "needs_authorization", {
					executionId: key.id,
					authority: Authority.missing(person),
				})
			}),
	)

	yield* batch(
		"import:reminders",
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(r)::text as body from openbot_bot_records r where kind = 'reminder' and (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.ReminderRow)(row.body)
				const body = yield* decodeBody(Rows.SealedReminder)(record.body)
				if (body.id !== record.id)
					return yield* Invalid.make({
						message: "The reminder ID does not match its sealed record.",
					})
				const binding = yield* encode([
					"reminder",
					record.organization_id,
					record.id,
				])
				const reminder = yield* secrets
					.open(body.sealed, binding)
					.pipe(Effect.flatMap(decodeBody(Legacy.Reminder)))
				if (
					reminder.id !== record.id ||
					reminder.userId !== record.owner ||
					reminder.chat !== record.scope ||
					reminder.status !== record.status
				)
					return yield* Invalid.make({
						message: "The reminder indexes do not match its record.",
					})
				const person = owner(record.organization_id, reminder.userId)
				const key = yield* write({
					collection: "reminder",
					sourceKey: row.key,
					owner: person,
					resource: { kind: "Reminder", id: reminder.id },
					context: { kind: "Chat", id: reminder.chat },
					// The old worker marked done before it saved the Chat notice.
					reason:
						reminder.status === "waiting"
							? "OriginalCallerMissing"
							: reminder.status === "done"
								? "CheckpointMissing"
								: "History",
					status: reminder.status === "cancelled" ? "cancelled" : "interrupted",
					history: reminder,
					createdAt: reminder.createdAt,
					updatedAt: reminder.createdAt,
				})
				const sealed = yield* secrets.seal(
					yield* encode({ ...reminder, executionId: key.id }),
					binding,
				)
				yield* sql`update openbot_bot_records set body = ${yield* encode({ id: reminder.id, sealed })} where kind = 'reminder' and organization_id = ${record.organization_id} and id = ${record.id}`
				yield* progress.record(
					"reminder-execution",
					row.key,
					reminder.status === "waiting" ? "needs_authorization" : "converted",
					{ executionId: key.id, authority: Authority.missing(person) },
				)
			}),
	)

	yield* batch(
		"import:computer-calls",
		(cursor, limit) =>
			sql<Row>`select id as key, to_jsonb(c)::text as body from openbot_computer_calls c where (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.ComputerCallRow)(row.body)
				const call = yield* decodeBody(Rows.ComputerCall)(record.call)
				const reply =
					record.reply === null
						? null
						: yield* decodeBody(Rows.ComputerReply)(record.reply)
				if (call.id !== record.id || (reply !== null && reply.id !== record.id))
					return yield* Invalid.make({
						message: "The Computer call IDs do not match.",
					})
				const [computer] = yield* sql<{
					organization_id: string
					created_by: string
				}>`select organization_id, created_by from openbot_computers where id = ${record.computer_id}`
				if (computer === undefined)
					return yield* Invalid.make({
						message: "The Computer of a saved call is missing.",
					})
				const person = owner(computer.organization_id, computer.created_by)
				const key = yield* write({
					collection: "computer-call",
					sourceKey: row.key,
					owner: person,
					resource: { kind: "ComputerCall", id: record.id },
					context: { kind: "Computer", id: record.computer_id },
					reason: reply === null ? "OutsideResultUnknown" : "History",
					status:
						reply === null
							? "outcome_unknown"
							: reply.result._tag === "Failed"
								? "failed"
								: "completed",
					history: {
						id: record.id,
						computerId: record.computer_id,
						call,
						reply,
					},
					createdAt: record.created_at,
					updatedAt: record.created_at,
					calls: [
						{
							step: "connector",
							attempt: 1,
							status: reply === null ? "outcome_unknown" : "completed",
							input: call,
							result: reply,
						},
					],
				})
				// The old transport is gone. Keep its row and ID, with a link to the sealed history.
				yield* sql`update openbot_computer_calls set call = ${key.id}, reply = ${reply === null ? null : key.id} where id = ${record.id}`
				yield* progress.record("computer-call", row.key, "converted", {
					executionId: key.id,
				})
			}),
	)

	yield* batch(
		"import:computers",
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(c)::text as body from openbot_computers c where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const record = yield* decode(Rows.Computer)(row.body)
				const features = yield* decodeBody(Rows.ComputerFeatures)(
					record.features,
				)
				const {
					token_hash: _tokenHash,
					features: _features,
					...history
				} = record
				const person = owner(record.organization_id, record.created_by)
				const unknown =
					record.source === "provider" && record.state === "starting"
				const key = yield* write({
					collection: "computer",
					sourceKey: row.key,
					owner: person,
					resource: { kind: "Computer", id: record.id },
					reason: unknown ? "OutsideResultUnknown" : "CheckpointMissing",
					status: unknown ? "outcome_unknown" : "interrupted",
					history: { ...history, features },
					createdAt: record.created_at,
					updatedAt: record.updated_at,
					calls: unknown
						? [
								{
									step: "start-computer",
									attempt: 1,
									status: "outcome_unknown",
									input: {
										providerId: record.provider_id,
										template: record.template,
										ref: record.ref,
									},
									result: null,
								},
							]
						: [],
				})
				// A stopped old server cannot own a connector socket. Provider state needs a fresh check.
				if (record.source === "connector" && record.state === "running")
					yield* sql`update openbot_computers set state = 'offline' where organization_id = ${record.organization_id} and id = ${record.id}`
				yield* progress.record("computer", row.key, "converted", {
					executionId: key.id,
				})
			}),
	)
})

/** Counts cover every source row, including pending input and timers. */
export const check = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const counts = yield* sql<{ step: string; count: number }>`
		select 'import:channels' as step, count(*)::float8 as count from openbot_channels
		union all select 'import:channel-inbox', count(*)::float8 from openbot_channel_inbox
		union all select 'import:channel-deliveries', count(*)::float8 from openbot_channel_deliveries
		union all select 'import:triggers', count(*)::float8 from openbot_triggers
		union all select 'import:reminders', count(*)::float8 from openbot_bot_records where kind = 'reminder'
		union all select 'import:computer-calls', count(*)::float8 from openbot_computer_calls
		union all select 'import:computers', count(*)::float8 from openbot_computers`
	for (const count of counts) {
		const [step] = yield* sql<{
			rows: number
			complete: boolean
		}>`select rows::float8 as rows, complete from openbot_data_upgrade_steps where version = ${Progress.version} and step = ${count.step}`
		if (step === undefined || !step.complete || step.rows !== count.count)
			return yield* Invalid.make({
				message: "The Channel and resource data move counts do not match.",
			})
	}
	const [links] = yield* sql<{
		missing: number
	}>`select count(*)::float8 as missing from (
		select organization_id, execution_id as id, 'Channel' as kind, id as resource_id from openbot_channels
		union all select organization_id, execution_id, 'ChannelInput', channel_id || ':' || event_id from openbot_channel_inbox
		union all select organization_id, execution_id, 'ChannelDelivery', id from openbot_channel_deliveries
		union all select organization_id, schedule_execution_id, 'Trigger', id from openbot_triggers
	) r where not exists (select 1 from openbot_executions e where e.id = r.id and e.organization_id = r.organization_id and e.workflow = ${Executions.workflowName} and e.resource_kind = r.kind and e.resource_id = r.resource_id)`
	if (links?.missing !== 0)
		return yield* Invalid.make({
			message: "An imported Channel or trigger has no execution link.",
		})
	const [history] = yield* sql<{
		missing: number
	}>`select count(*)::float8 as missing from (
		select organization_id, 'Reminder' as kind, id as resource_id from openbot_bot_records where kind = 'reminder'
		union all select c.organization_id, 'ComputerCall', r.id from openbot_computer_calls r join openbot_computers c on c.id = r.computer_id
		union all select organization_id, 'Computer', id from openbot_computers
	) r where not exists (select 1 from openbot_executions e where e.organization_id = r.organization_id and e.workflow = ${Executions.workflowName} and e.resource_kind = r.kind and e.resource_id = r.resource_id)`
	if (history?.missing !== 0)
		return yield* Invalid.make({
			message: "An imported reminder or Computer has no execution history.",
		})
	return counts
})
