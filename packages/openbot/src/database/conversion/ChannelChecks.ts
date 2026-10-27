import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Imported from "./Executions.ts"
import * as Legacy from "./LegacyV1.ts"
import * as Rows from "./LegacyChannels.ts"
import * as Progress from "./Progress.ts"

const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const object = Schema.Record(Schema.String, Schema.Json)
const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
	Schema.decodeEffect(Schema.fromJsonString(schema))
const fail = (message: string) => Progress.InvalidData.make({ message })

/** Read every changed Channel and resource row again before allowing startup. */
export const verify = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	const history = (
		id: string,
		organizationId: string,
		kind: string,
		resourceId: string,
	) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				namespace: string
				input: string
				status: string
				created_at: bigint
				resource_kind: string
				resource_id: string
				organization_id: string
				workflow: string
			}>`select namespace, input, status, created_at, resource_kind, resource_id, organization_id, workflow from openbot_executions where id = ${id}`
			if (
				row === undefined ||
				row.workflow !== Imported.workflowName ||
				row.organization_id !== organizationId ||
				row.resource_kind !== kind ||
				row.resource_id !== resourceId
			)
				return yield* fail("A moved Channel or resource has another execution.")
			const input = yield* secrets
				.open(
					row.input,
					yield* encode(["execution", row.namespace, id, "input"]),
				)
				.pipe(Effect.flatMap(decode(Imported.Input)))
			if (input.owner.organizationId !== organizationId)
				return yield* fail("A moved resource history has another owner.")
			return {
				input,
				status: row.status,
				createdAt: Number(row.created_at),
				body: yield* Schema.decodeUnknownEffect(object)(input.history),
			}
		})
	const proof = (collection: string, key: string) =>
		Effect.gen(function* () {
			const [row] = yield* sql<{
				body: string
			}>`select body from openbot_data_upgrade_records where version = ${Progress.version} and collection = ${collection} and key = ${key}`
			if (row === undefined)
				return yield* fail("A moved resource has no saved source link.")
			return yield* secrets
				.open(
					row.body,
					yield* encode(["data-upgrade", Progress.version, collection, key]),
				)
				.pipe(
					Effect.flatMap(decode(Schema.Struct({ executionId: Schema.String }))),
				)
		})
	const same = (actual: Schema.Json, expected: Schema.Json) =>
		Schema.toEquivalence(Schema.Json)(actual, expected)
	const linked = (id: string | null) =>
		id === null
			? Effect.fail(fail("A moved resource has no execution ID."))
			: Effect.succeed(id)
	type Row = { key: string; body: string }
	const table = <S extends Schema.Decoder<unknown>, E>(
		name: string,
		schema: S,
		read: (cursor: string | null, limit: number) => ReturnType<typeof sql<Row>>,
		check: (row: S["Type"], key: string) => Effect.Effect<void, E>,
	) =>
		progress.verify({
			name: `verify:${name}`,
			read,
			key: (row) => row.key,
			check: (row) =>
				decode(schema)(row.body).pipe(
					Effect.flatMap((value) => check(value, row.key)),
				),
		})
	yield* table(
		"channels",
		Rows.Channel,
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(t)::text as body from openbot_channels t where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const saved = yield* history(
					yield* linked(row.execution_id),
					row.organization_id,
					"Channel",
					row.id,
				)
				const sealed = yield* secrets
					.open(row.credentials, `openbot_channels:${row.id}:credentials`)
					.pipe(
						Effect.flatMap(
							decode(
								Schema.Struct({
									credentials: Rows.Credentials,
									caller: Schema.Null,
								}),
							),
						),
					)
				yield* decode(Rows.Hints)(row.hints)
				if (
					sealed.credentials.kind !== row.kind ||
					saved.input.owner.userId !== row.actor ||
					!same(row, {
						...saved.body,
						credentials: row.credentials,
						hints: row.hints,
						execution_id: row.execution_id,
					})
				)
					return yield* fail("A moved Channel does not match its saved source.")
			}),
	)
	yield* table(
		"channel-inbox",
		Rows.Inbox,
		(cursor, limit) =>
			sql<Row>`select json_build_array(channel_id, event_id)::text as key, to_jsonb(t)::text as body from openbot_channel_inbox t where (${cursor}::text is null or json_build_array(channel_id, event_id)::text > ${cursor}) order by json_build_array(channel_id, event_id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const saved = yield* history(
					yield* linked(row.execution_id),
					row.organization_id,
					"ChannelInput",
					row.channel_id + ":" + row.event_id,
				)
				const event = yield* Schema.decodeUnknownEffect(Rows.Event)(
					saved.body["event"],
				)
				if (
					event.eventId !== row.event_id ||
					event.conversation.key !== row.conversation_key ||
					!same(row, {
						...saved.body,
						event: row.execution_id,
						execution_id: row.execution_id,
						claim: null,
						lease_until: 0,
					})
				)
					return yield* fail(
						"A moved Channel input does not match its saved source.",
					)
			}),
	)
	yield* table(
		"channel-deliveries",
		Schema.Struct({ ...Rows.Delivery.fields, state: Schema.String }),
		(cursor, limit) =>
			sql<Row>`select id as key, to_jsonb(t)::text as body from openbot_channel_deliveries t where (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const saved = yield* history(
					yield* linked(row.execution_id),
					row.organization_id,
					"ChannelDelivery",
					row.id,
				)
				yield* Schema.decodeUnknownEffect(Rows.Target)(saved.body["target"])
				yield* Schema.decodeUnknownEffect(Rows.Message)(saved.body["message"])
				const ref = yield* Schema.decodeUnknownEffect(
					Schema.NullOr(Rows.MessageRef),
				)(saved.body["ref"])
				const {
					message: _message,
					target: _target,
					ref: _ref,
					...body
				} = saved.body
				if (
					!same(row, {
						...body,
						target: row.execution_id,
						body: row.execution_id,
						ref: ref === null ? null : yield* encode(ref),
						execution_id: row.execution_id,
						state: saved.status === "completed" ? "done" : saved.status,
						claim: null,
						lease_until: 0,
					})
				)
					return yield* fail(
						"A moved Channel delivery does not match its saved source.",
					)
			}),
	)
	yield* table(
		"triggers",
		Rows.Trigger,
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(t)::text as body from openbot_triggers t where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const saved = yield* history(
					yield* linked(row.schedule_execution_id),
					row.organization_id,
					"Trigger",
					row.id,
				)
				const sealed = yield* secrets
					.open(
						row.prompt,
						yield* encode(["trigger", row.organization_id, row.id]),
					)
					.pipe(
						Effect.flatMap(
							decode(
								Schema.Struct({ prompt: Schema.String, caller: Schema.Null }),
							),
						),
					)
				if (
					sealed.prompt !== saved.body["prompt"] ||
					saved.input.owner.userId !== row.actor ||
					!same(row, {
						...saved.body,
						prompt: row.prompt,
						schedule_execution_id: row.schedule_execution_id,
					})
				)
					return yield* fail("A moved trigger does not match its saved source.")
			}),
	)
	yield* table(
		"reminders",
		Rows.ReminderRow,
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(t)::text as body from openbot_bot_records t where kind = 'reminder' and (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row) =>
			Effect.gen(function* () {
				const wrapped = yield* decode(Rows.SealedReminder)(row.body)
				const reminder = yield* secrets
					.open(
						wrapped.sealed,
						yield* encode(["reminder", row.organization_id, row.id]),
					)
					.pipe(
						Effect.flatMap(
							decode(
								Schema.Struct({
									...Legacy.Reminder.fields,
									executionId: Schema.String,
								}),
							),
						),
					)
				const saved = yield* history(
					reminder.executionId,
					row.organization_id,
					"Reminder",
					row.id,
				)
				if (
					wrapped.id !== row.id ||
					reminder.id !== row.id ||
					reminder.userId !== row.owner ||
					reminder.chat !== row.scope ||
					reminder.status !== row.status ||
					!same(reminder, { ...saved.body, executionId: reminder.executionId })
				)
					return yield* fail(
						"A moved reminder does not match its saved source.",
					)
			}),
	)
	yield* table(
		"computer-calls",
		Rows.ComputerCallRow,
		(cursor, limit) =>
			sql<Row>`select id as key, to_jsonb(t)::text as body from openbot_computer_calls t where (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		(row, key) =>
			Effect.gen(function* () {
				const link = yield* proof("computer-call", key)
				const [computer] = yield* sql<{
					organization_id: string
				}>`select organization_id from openbot_computers where id = ${row.computer_id}`
				if (computer === undefined)
					return yield* fail("A moved Computer call has no Computer.")
				const saved = yield* history(
					link.executionId,
					computer.organization_id,
					"ComputerCall",
					row.id,
				)
				const value = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						id: Schema.String,
						computerId: Schema.String,
						call: Rows.ComputerCall,
						reply: Schema.NullOr(Rows.ComputerReply),
					}),
				)(saved.body)
				if (
					value.id !== row.id ||
					value.call.id !== row.id ||
					value.computerId !== row.computer_id ||
					row.call !== link.executionId ||
					row.reply !== (value.reply === null ? null : link.executionId) ||
					(value.reply !== null && value.reply.id !== row.id) ||
					row.created_at !== saved.createdAt
				)
					return yield* fail(
						"A moved Computer call does not match its saved source.",
					)
			}),
	)
	yield* table(
		"computers",
		Rows.Computer,
		(cursor, limit) =>
			sql<Row>`select json_build_array(organization_id, id)::text as key, to_jsonb(t)::text as body from openbot_computers t where (${cursor}::text is null or json_build_array(organization_id, id)::text > ${cursor}) order by json_build_array(organization_id, id)::text limit ${limit}`,
		(row, key) =>
			Effect.gen(function* () {
				const link = yield* proof("computer", key)
				const saved = yield* history(
					link.executionId,
					row.organization_id,
					"Computer",
					row.id,
				)
				const features = yield* decode(Rows.ComputerFeatures)(row.features)
				if (
					!same(features, saved.body["features"] ?? null) ||
					saved.input.owner.userId !== row.created_by ||
					!same(row, {
						...saved.body,
						features: row.features,
						token_hash: row.token_hash,
						state:
							saved.body["source"] === "connector" &&
							saved.body["state"] === "running"
								? "offline"
								: (saved.body["state"] ?? null),
					})
				)
					return yield* fail(
						"A moved Computer does not match its saved source.",
					)
			}),
	)
})
