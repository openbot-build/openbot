import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import {
	Chat,
	ChatState,
	ChatStoreRepository,
	Item,
	Store,
	Turn,
} from "@openbot-build/core"
import { Authorization, BotMemory, BotsApi } from "@openbot-build/api"
import { Policy } from "@nmnmcc/ability"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Schema,
} from "effect"
import { Prompt } from "effect/ai"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as Todos from "../src/plugins/work/Todos.ts"
import { Stored as StoredRequest } from "../src/capabilities/Requests.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const chatsMigration = "20261023194809_chats"
const host = "@openbot-build/openbot/session-host"
const memoryKey = "@openbot-build/openbot/memory"
// The old store named a namespace with the JSON text of the organization and the member.
const namespaceA = '["org_a","user_a"]'
const namespaceB = '["org_a","user_b"]'

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
// Old Items and windows keep their messages in the same JSON as the store wrote them.
const encodePrompt = Schema.encodeEffect(Item.Entry.fields.content)
const messages = (input: Prompt.RawInput) => encodePrompt(Prompt.make(input))
const said = (text: string): Prompt.RawInput => [
	{ role: "user", content: text },
]
const answered = (text: string): Prompt.RawInput => [
	{ role: "assistant", content: [Prompt.textPart({ text })] },
]
const called = (id: string, approval: boolean): Prompt.RawInput => [
	{
		role: "assistant",
		content: [
			Prompt.toolCallPart({
				id,
				name: "openbot_delegate",
				params: { task: "Look at the plan" },
				providerExecuted: false,
			}),
			...(approval
				? [Prompt.toolApprovalRequestPart({ approvalId: id, toolCallId: id })]
				: []),
		],
	},
]

interface OldItem {
	readonly id: string
	readonly session: string
	readonly turn: string
	readonly input: Prompt.RawInput
}
const allMessages = (items: ReadonlyArray<OldItem>) =>
	Arr.flatMap(items, (item) => Prompt.make(item.input).content)

const contentRow = Effect.fn("ChatsMigration.contentRow")(function* (
	namespace: string,
	item: OldItem,
) {
	return {
		namespace,
		id: "cnt_" + item.id,
		message: item.id,
		content: yield* encodeJson({
			content: yield* messages(item.input),
			origin: { session: item.session, turn: item.turn, step: 0 },
		}),
	}
})

const versionRow = Effect.fn("ChatsMigration.versionRow")(function* (input: {
	readonly namespace: string
	readonly id: string
	readonly items: ReadonlyArray<OldItem>
	readonly value: object
}) {
	return {
		namespace: input.namespace,
		id: input.id,
		schema_version: "timeline/1",
		parents: "[]",
		snapshot_format: 2,
		value: yield* encodeJson(input.value),
		history: yield* encodeJson(
			Arr.map(input.items, (item) => ({
				message: item.id,
				content: "cnt_" + item.id,
			})),
		),
	}
})

const promptWindow = (items: ReadonlyArray<OldItem>) =>
	Effect.map(messages(allMessages(items)), (prompt) => ({
		_tag: "Prompt",
		prompt,
	}))

const oldTurn = (input: {
	readonly id: string
	readonly session: string
	readonly status: { readonly _tag: string; readonly result?: object }
	readonly startedAt: number
	readonly completedAt?: number
	readonly items: ReadonlyArray<string>
}) => ({
	id: input.id,
	session: input.session,
	settings: { mode: "build" },
	status: input.status,
	steps: 1,
	input: Arr.take(input.items, 1),
	items: input.items,
	start: "ver_start_" + input.id,
	...(input.completedAt === undefined
		? {}
		: { end: "ver_end_" + input.id, completedAt: input.completedAt }),
	startedAt: input.startedAt,
})
const completed = (text: string) => ({
	_tag: "Completed",
	result: { text, finishReason: "stop" },
})

const chain = (userId: string, sessions: ReadonlyArray<string> = []) => ({
	organizationId: "org_a",
	userId,
	bots: ["bot_1"],
	sessions,
})

const sessionRow = Effect.fn("ChatsMigration.sessionRow")(function* (input: {
	readonly namespace: string
	readonly id: string
	readonly head: string
	readonly host: object
	readonly title?: string
	readonly turns: ReadonlyArray<ReturnType<typeof oldTurn>>
	readonly inheritedTurns?: ReadonlyArray<ReturnType<typeof oldTurn>>
	readonly pending?: ReadonlyArray<object>
	readonly forkedFrom?: object
}) {
	const last = Arr.last(input.turns)
	return {
		namespace: input.namespace,
		id: input.id,
		body: yield* encodeJson({
			id: input.id,
			revision: 7,
			head: input.head,
			metadata: {
				...(input.title === undefined ? {} : { title: input.title }),
				archived: false,
			},
			settings: { mode: "build" },
			pending: input.pending ?? [],
			turns: input.turns,
			inheritedTurns: input.inheritedTurns ?? [],
			business: { [host]: input.host },
			...(input.forkedFrom === undefined
				? {}
				: { forkedFrom: input.forkedFrom }),
		}),
		head: input.head,
		archived: 0,
		status: Option.match(last, {
			onNone: () => "Idle",
			onSome: (turn) => turn.status._tag,
		}),
		turn: Option.getOrNull(Option.map(last, (turn) => turn.id)),
		response: null,
		response_summary: null,
		revision: 7,
	}
})

const record = (
	kind: string,
	id: string,
	keys: {
		readonly owner: string
		readonly scope: string
		readonly status: string
	},
	body: object,
) =>
	Effect.map(encodeJson(body), (body) => ({
		kind,
		organization_id: "org_a",
		id,
		...keys,
		body,
	}))

const bot = (id: string, kind: string, owner: object) => ({
	id,
	kind,
	owner,
	name: id,
	role: "",
	instructions: "",
	archived: false,
	revision: 3,
	createdAt: 1,
	updatedAt: 2,
})

const grant = (id: string, input: object) => ({
	id,
	bot: "bot_1",
	capability: { action: "tools.call", target: "*" },
	effect: "allow",
	grantedBy: { _tag: "Person", userId: "user_a" },
	status: "active",
	createdAt: 1,
	...input,
})

const request = (
	id: string,
	action: string,
	status: string,
	decision: object | null,
) => ({
	request: {
		id,
		bot: "bot_1",
		capability: { action, target: "*" },
		reason: "The Bot needs it.",
		approver: { _tag: "Person", userId: "user_a" },
		chain: ["bot_1"],
		session: "ses_new",
		turn: "turn_new2",
		toolCallId: "call_wait",
		endorsements: [{ bot: "bot_1", scope: "session" }],
		status,
		decision,
		revision: 2,
		createdAt: 1,
		expiresAt: 2,
	},
	chain: chain("user_a", ["ses_new"]),
})

const policies = [
	{
		effect: "allow",
		permissionGroups: ["sessions.read", "sessions.write", "bots.read"],
		resources: [
			"openbot.org.{org}.user.{self}.session",
			"openbot.org.{org}.user.{self}.session.ses_new",
			"openbot.org.{org}.user.{self}",
		],
	},
]

// A direct Session from before the Fork.
const oldItems: ReadonlyArray<OldItem> = [
	{
		id: "itm_old1",
		session: "ses_old",
		turn: "turn_old1",
		input: said("Plan a trip."),
	},
	{
		id: "itm_old2",
		session: "ses_old",
		turn: "turn_old1",
		input: answered("Where to?"),
	},
]
const turnOld1 = oldTurn({
	id: "turn_old1",
	session: "ses_old",
	status: completed("Where to?"),
	startedAt: 100,
	completedAt: 110,
	items: ["itm_old1", "itm_old2"],
})
// The newest direct Session of the same Bot. It is a Fork of the old one, and its last Turn
// waits for an approval, so its history ends with a tool call without a result.
const newItems: ReadonlyArray<OldItem> = [
	...oldItems,
	{
		id: "itm_new1",
		session: "ses_new",
		turn: "turn_new1",
		input: said("To Rome."),
	},
	{
		id: "itm_new2",
		session: "ses_new",
		turn: "turn_new1",
		input: answered("Rome is nice."),
	},
	{
		id: "itm_new3",
		session: "ses_new",
		turn: "turn_new2",
		input: said("Ask a helper."),
	},
	{
		id: "itm_new4",
		session: "ses_new",
		turn: "turn_new2",
		input: called("call_wait", true),
	},
]
const todos = {
	items: [{ id: "t1", content: "Book a hotel", status: "pending" }],
}
// A chat of a Channel. Its last Turn still ran, and its window was made smaller in that Turn.
const channelItems: ReadonlyArray<OldItem> = [
	{
		id: "itm_c1",
		session: "ses_chan",
		turn: "turn_chan1",
		input: said("Hello team."),
	},
	{
		id: "itm_c2",
		session: "ses_chan",
		turn: "turn_chan1",
		input: answered("Hello."),
	},
	{
		id: "itm_c3",
		session: "ses_chan",
		turn: "turn_chan2",
		input: said("Run it."),
	},
	{
		id: "itm_c4",
		session: "ses_chan",
		turn: "turn_chan2",
		input: called("call_run", false),
	},
]
const delegatedItems: ReadonlyArray<OldItem> = [
	{ id: "itm_d1", session: "ses_del", turn: "turn_del1", input: said("Help.") },
]

const insertOldData = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const insert = (table: string, rows: ReadonlyArray<object>) =>
		Effect.forEach(
			rows,
			(row) => sql`insert into ${sql(table)} ${sql.insert(row as never)}`,
		)
	yield* insert("openbot_organizations", [
		{ id: "org_a", name: "Org A", status: "active", created_at: 1 },
	])
	yield* insert("openbot_auth_user", [
		{ id: "user_a", name: "A", email: "a@example.com" },
	])
	yield* insert(
		"openbot_timeline_contents",
		yield* Effect.forEach(
			[...newItems, ...channelItems, ...delegatedItems],
			(item) => contentRow(namespaceA, item),
		),
	)
	yield* insert("openbot_timeline_versions", [
		yield* versionRow({
			namespace: namespaceA,
			id: "ver_old",
			items: oldItems,
			value: {
				conversation: { context: yield* promptWindow(oldItems), closed: true },
			},
		}),
		yield* versionRow({
			namespace: namespaceA,
			id: "ver_new",
			items: newItems,
			value: {
				[Todos.storeKey]: todos,
				[memoryKey]: { entries: {}, processed: [] },
				conversation: { context: yield* promptWindow(newItems), closed: false },
			},
		}),
		yield* versionRow({
			namespace: namespaceA,
			id: "ver_chan",
			items: channelItems,
			value: {
				conversation: {
					context: {
						_tag: "Native",
						provider: "openai",
						model: "gpt-test",
						items: [{ type: "compaction", id: "cmp_1" }],
						prompt: yield* messages(said("A short note about the chat.")),
					},
					closed: false,
				},
			},
		}),
		yield* versionRow({
			namespace: namespaceA,
			id: "ver_del",
			items: delegatedItems,
			value: {
				conversation: {
					context: yield* promptWindow(delegatedItems),
					closed: true,
				},
			},
		}),
		yield* versionRow({
			namespace: namespaceB,
			id: "ver_b",
			items: [],
			value: {
				conversation: { context: yield* promptWindow([]), closed: true },
			},
		}),
	])
	yield* insert("openbot_session_references", [
		yield* sessionRow({
			namespace: namespaceA,
			id: "ses_old",
			head: "ver_old",
			host: { bot: "bot_1", kind: "direct", chain: chain("user_a") },
			title: "Trip",
			turns: [turnOld1],
		}),
		yield* sessionRow({
			namespace: namespaceA,
			id: "ses_new",
			head: "ver_new",
			host: {
				bot: "bot_1",
				kind: "direct",
				chain: chain("user_a"),
				memory: { use: false },
				planApproval: {
					approver: "person",
					timeoutMs: 1000,
					onTimeout: "stay",
				},
			},
			title: "Trip again",
			forkedFrom: { session: "ses_old", version: "ver_old" },
			inheritedTurns: [turnOld1],
			turns: [
				oldTurn({
					id: "turn_new1",
					session: "ses_new",
					status: completed("Rome is nice."),
					startedAt: 300,
					completedAt: 310,
					items: ["itm_new1", "itm_new2"],
				}),
				oldTurn({
					id: "turn_new2",
					session: "ses_new",
					status: {
						_tag: "Waiting",
						result: { text: "", finishReason: "tool-calls" },
					},
					startedAt: 400,
					items: ["itm_new3", "itm_new4"],
				}),
			],
			pending: [
				{
					id: "itm_steer",
					kind: "steer",
					turn: "turn_new2",
					content: yield* messages(said("Be quick.")),
				},
				{
					id: "itm_action",
					kind: "action",
					turn: "turn_new2",
					action: { name: "open", arguments: {} },
					content: yield* messages(said("Open it.")),
				},
				{
					id: "itm_next",
					kind: "message",
					author: "user_b",
					content: yield* messages(said("And then?")),
				},
			],
		}),
		yield* sessionRow({
			namespace: namespaceA,
			id: "ses_chan",
			head: "ver_chan",
			host: {
				bot: "bot_1",
				kind: "channel",
				chain: chain("user_a"),
				channel: { channel: "chn_1", conversation: "C1", group: true },
			},
			title: "Team room",
			turns: [
				oldTurn({
					id: "turn_chan1",
					session: "ses_chan",
					status: completed("Hello."),
					startedAt: 50,
					completedAt: 60,
					items: ["itm_c1", "itm_c2"],
				}),
				oldTurn({
					id: "turn_chan2",
					session: "ses_chan",
					status: { _tag: "Running" },
					startedAt: 70,
					items: ["itm_c3", "itm_c4"],
				}),
			],
		}),
		yield* sessionRow({
			namespace: namespaceA,
			id: "ses_del",
			head: "ver_del",
			host: {
				bot: "bot_s",
				kind: "delegated",
				chain: { ...chain("user_a", ["ses_new"]), bots: ["bot_1", "bot_s"] },
				parent: {
					session: "ses_new",
					turn: "turn_new2",
					toolCallId: "call_wait",
				},
			},
			turns: [
				oldTurn({
					id: "turn_del1",
					session: "ses_del",
					status: completed("Done."),
					startedAt: 500,
					completedAt: 510,
					items: ["itm_d1"],
				}),
			],
		}),
		// A Session without Turns is the only direct Session of its member with this Bot.
		yield* sessionRow({
			namespace: namespaceB,
			id: "ses_b",
			head: "ver_b",
			host: {
				bot: "bot_2",
				kind: "direct",
				chain: { ...chain("user_b"), bots: ["bot_2"] },
			},
			turns: [],
			pending: [
				{
					id: "itm_b1",
					kind: "message",
					content: yield* messages(said("Hi.")),
				},
			],
		}),
	])
	yield* insert("openbot_channels", [
		{
			organization_id: "org_a",
			id: "chn_1",
			kind: "slack",
			name: "Team",
			bot: "bot_1",
			actor: "user_a",
			enabled: true,
			credentials: "sealed",
			hints: "{}",
			version: 1,
			created_at: 1,
			updated_at: 1,
		},
	])
	yield* insert("openbot_channel_conversations", [
		{
			organization_id: "org_a",
			channel_id: "chn_1",
			conversation_key: "C1",
			kind: "group",
			title: "Team room",
			session: "ses_chan",
			owner: "user_a",
			created_at: 1,
		},
	])
	const delivery = (
		id: string,
		session: string | null,
		turn: string | null,
	) => ({
		id,
		organization_id: "org_a",
		channel_id: "chn_1",
		kind: session === null ? "notice" : "reply",
		target: "C1",
		session,
		turn,
		request: null,
		body: "{}",
		ref: null,
		state: "done",
		next_at: 1,
		updated_at: 1,
	})
	yield* insert("openbot_channel_deliveries", [
		delivery("dlv_keep", "ses_chan", "turn_chan1"),
		delivery("dlv_gone", "ses_del", "turn_del1"),
		delivery("dlv_notice", null, null),
	])
	yield* insert("openbot_app_invocations", [
		{
			owner: "o",
			id: "inv_1",
			session: "ses_new",
			status: "Completed",
			body: "sealed",
		},
	])
	yield* insert("openbot_code_runs", [
		{
			owner: "o",
			id: "run_1",
			session: "ses_new",
			call_id: "call_1",
			status: "done",
			body: "sealed",
		},
	])
	yield* insert(
		"openbot_app_secrets",
		Arr.map(
			["app-view", "app-ui-state", "app-view-action", "app-token"],
			(kind) => ({
				owner: "o",
				kind,
				id: kind + "_1",
				connection_id: "con_1",
				body: "sealed",
			}),
		),
	)
	const persistent = { owner: "user_a", scope: "", status: "persistent" }
	const active = { owner: "bot_1", scope: "", status: "active" }
	const waiting = {
		owner: "person:user_a",
		scope: "ses_new",
		status: "pending",
	}
	yield* insert(
		"openbot_bot_records",
		yield* Effect.all([
			record(
				"bot",
				"bot_1",
				persistent,
				bot("bot_1", "persistent", { _tag: "Member", userId: "user_a" }),
			),
			record(
				"bot",
				"bot_s",
				{ owner: "user_a", scope: "ses_del", status: "session" },
				bot("bot_s", "session", {
					_tag: "Session",
					userId: "user_a",
					session: "ses_del",
					bot: "bot_1",
				}),
			),
			record(
				"grant",
				"grt_keep",
				active,
				grant("grt_keep", { scope: "session", session: "ses_new" }),
			),
			record(
				"grant",
				"grt_gone",
				active,
				grant("grt_gone", { scope: "session", session: "ses_del" }),
			),
			record(
				"grant",
				"grt_life",
				active,
				grant("grt_life", { scope: "lifetime" }),
			),
			record(
				"grant",
				"grt_spawn",
				active,
				grant("grt_spawn", {
					scope: "lifetime",
					capability: { action: "bots.spawn", target: "*" },
				}),
			),
			record(
				"rule",
				"rul_1",
				{ owner: "bot_1", scope: "person:user_a", status: "active" },
				{
					id: "rul_1",
					bot: "bot_1",
					author: { _tag: "Person", userId: "user_a" },
					text: "Allow reading files.",
					status: "active",
					version: 0,
					createdAt: 1,
					updatedAt: 1,
				},
			),
			record(
				"request",
				"req_wait",
				waiting,
				request("req_wait", "tools.call", "pending", null),
			),
			record(
				"request",
				"req_done",
				{ ...waiting, status: "allowed" },
				request("req_done", "tools.call", "allowed", {
					by: { _tag: "Person", userId: "user_a" },
					scope: "session",
					at: 3,
				}),
			),
			record(
				"request",
				"req_promote",
				waiting,
				request("req_promote", "bots.promote", "pending", null),
			),
			record(
				"delegation",
				"dlg_1",
				{ owner: "bot_1", scope: "ses_new", status: "running" },
				{ id: "dlg_1" },
			),
			record(
				"wait",
				"wat_1",
				{ owner: "bot_1", scope: "ses_new", status: "waiting" },
				{ id: "wat_1" },
			),
			record(
				"memory_job",
				"bot_1/ses_new",
				{ owner: "bot_1", scope: "ses_new", status: "pending" },
				{},
			),
			record(
				"confession",
				"cnf_keep",
				{ owner: "ses_new", scope: "turn_new1", status: "" },
				{
					id: "cnf_keep",
					session: "ses_new",
					turn: "turn_new1",
					text: "I made a mistake.",
					reply: "It is fine.",
					at: 1,
				},
			),
			record(
				"confession",
				"cnf_gone",
				{ owner: "ses_del", scope: "turn_del1", status: "" },
				{
					id: "cnf_gone",
					session: "ses_del",
					turn: "turn_del1",
					text: "Hm.",
					reply: "Ok.",
					at: 1,
				},
			),
			record(
				"memory_enrichment",
				"ses_new/turn_new1",
				{ owner: "ses_new", scope: "turn_new1", status: "" },
				{
					session: "ses_new",
					turn: "turn_new1",
					text: "To Rome.",
					inserted: [],
					entries: [],
					at: 1,
				},
			),
			record(
				"memory_enrichment",
				"ses_del/turn_del1",
				{ owner: "ses_del", scope: "turn_del1", status: "" },
				{
					session: "ses_del",
					turn: "turn_del1",
					text: "Help.",
					inserted: [],
					entries: [],
					at: 1,
				},
			),
			record(
				"memory_cursor",
				"bot_1/ses_new",
				{ owner: "bot_1", scope: "ses_new", status: "" },
				{ processed: ["itm_old1", "itm_old2", "itm_new1", "itm_new3"] },
			),
			record(
				"memory_cursor",
				"bot_1/ses_del",
				{ owner: "bot_1", scope: "ses_del", status: "" },
				{ processed: ["itm_d1"] },
			),
		]),
	)
	yield* insert("openbot_bot_memories", [
		{
			organization_id: "org_a",
			home_bot: "bot_1",
			id: "mem_1",
			layer: "fact",
			content: "The person likes Rome.",
			sources: yield* encodeJson([
				{ session: "ses_new", item: "itm_new1" },
				{ entry: "mem_0" },
			]),
			status: "active",
			created_at: 1,
			updated_at: 1,
		},
	])
	yield* insert(
		"openbot_bot_memory_tags",
		Arr.map(["session:ses_new", "from:user_a"], (tag) => ({
			organization_id: "org_a",
			home_bot: "bot_1",
			memory_id: "mem_1",
			tag,
		})),
	)
	const storedPolicies = yield* encodeJson(policies)
	yield* insert("openbot_roles", [
		{
			organization_id: "org_a",
			id: "role_1",
			name: "Helper",
			description: "Sessions and Bots.",
			policies: storedPolicies,
			created_at: 1,
			updated_at: 1,
		},
	])
	yield* insert("openbot_members", [
		{
			organization_id: "org_a",
			user_id: "user_a",
			email: "a@example.com",
			name: "A",
			status: "active",
			roles: '["member"]',
			policies: storedPolicies,
			joined_at: 1,
		},
	])
	yield* insert("openbot_tokens", [
		{
			id: "00000000-0000-4000-8000-000000000031",
			organization_id: "org_a",
			user_id: "user_a",
			name: "Token",
			prefix: "ob_1",
			hash: "hash_1",
			policies: storedPolicies,
			created_at: 1,
		},
	])
	const setting = (kind: string, id: string, document: object) =>
		Effect.map(encodeJson(document), (document) => ({
			scope_kind: kind,
			scope_id: id,
			document,
			version: 1,
			updated_at: 1,
		}))
	yield* insert(
		"openbot_settings",
		yield* Effect.all([
			setting("platform", "platform", {
				policyCeiling: [{ ...policies[0], effect: "deny" }],
			}),
			setting("organization", "org_a", {
				memory: { use: true, generate: false },
				botMemory: true,
			}),
			setting("member", "org_a/user_a", { defaultBot: "bot_1" }),
		]),
	)
	const usage = (id: string, source: string) => ({
		id,
		organization_id: "org_a",
		occurred_at: 1,
		source,
		session_id: "ses_new",
		turn_id: "turn_new1",
		bot_id: "bot_1",
		user_id: "user_a",
		token_id: null,
		provider_id: "prov_a",
		provider_owner: "platform",
		model_id: "small",
		input_uncached: 10,
		input_cache_read: 0,
		input_cache_write: 0,
		output_text: 5,
		output_reasoning: 0,
		price_id: null,
		cost_micros: 7,
		charged: false,
	})
	yield* insert("openbot_usage_events", [
		usage("use_memory", "session_memory"),
		usage("use_turn", "turn"),
	])
})

/** The same store that the server uses for the Chats of one namespace. */
const chatStore = (namespace: string) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const definition = yield* Store.define({
			stores: {
				[ChatHost.chatHostId]: ChatHost.chatHostStore,
				...Todos.stores,
			},
			schemaVersion: "chat/1",
		})
		return yield* ChatStoreRepository.make({
			definition,
			persistence: StoredChats.persistence(db, namespace),
		})
	})

/** Decodes a stored JSON text in the same way as the records of the server. */
const decodeJson = <A, I>(schema: Schema.Codec<A, I>) =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
/** Decodes a stored JSON object, so that a test can look at its keys. */
const decodeObject = Schema.decodeEffect(Schema.fromJsonString(JsonObject))

/**
 * A new PostgreSQL server with the data of the old schema. The chats migration
 * and every later migration ran over that data.
 */
const migratedDatabase = Layer.effectDiscard(
	Effect.scoped(
		Effect.gen(function* () {
			const migrations = yield* MigrationTest.folder
			const db = yield* Db.make
			yield* migrate(db, {
				migrationsFolder: yield* MigrationTest.migrationsWhere(
					(name) => name < chatsMigration,
				),
			})
			yield* insertOldData
			yield* migrate(db, {
				migrationsFolder: yield* MigrationTest.migrationsWhere(
					(name) => name <= chatsMigration,
				),
			})
			// Later migrations add tables, and the server checks every table
			// of the new schema when it starts.
			yield* migrate(db, { migrationsFolder: migrations })
			yield* DatabasePostgres.check
		}),
	),
).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
	Layer.provide(NodeServices.layer),
)

// The database is a real server, so the tests use real time.
layer(migratedDatabase, { excludeTestServices: true, timeout: "120 seconds" })(
	"Sessions become Chats, and stored values that named Sessions name Chats",
	(it) => {
		it.effect(
			"only channel Sessions and the newest direct Session of each Bot stay",
			() =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						readonly namespace: string
						readonly id: string
						readonly kind: string
						readonly bot: string
						readonly status: string
						readonly turn: string | null
						readonly inbox_size: number
						readonly revision: number
					}>`select namespace, id, kind, bot, status, turn, inbox_size, revision from openbot_chats order by id`
					assert.deepStrictEqual(
						Arr.map(rows, (row) => [
							row.namespace,
							row.id,
							row.kind,
							row.bot,
							row.status,
							row.turn,
							row.inbox_size,
							row.revision,
						]),
						[
							[namespaceB, "ses_b", "direct", "bot_2", "Idle", null, 1, 7],
							[
								namespaceA,
								"ses_chan",
								"channel",
								"bot_1",
								"Interrupted",
								"turn_chan2",
								0,
								7,
							],
							[
								namespaceA,
								"ses_new",
								"direct",
								"bot_1",
								"Interrupted",
								"turn_new2",
								2,
								7,
							],
						],
					)
					const tables = yield* sql<{
						readonly tablename: string
					}>`select tablename from pg_catalog.pg_tables where tablename in ('openbot_session_references', 'openbot_timeline_versions', 'openbot_timeline_contents')`
					assert.deepStrictEqual(tables, [])
				}),
		)

		it.effect(
			"the server reads a forked Chat whose last Turn did not end",
			() =>
				Effect.gen(function* () {
					const store = yield* chatStore(namespaceA)
					const view = yield* store.read(Chat.Id.make("ses_new"))
					const items = yield* store.items(view.chat.id)
					const turns = yield* store.turns(view.chat.id)
					const inherited = yield* store.turn(
						view.chat.id,
						Turn.Id.make("turn_old1"),
					)
					const gone = yield* store.get(Chat.Id.make("ses_old"))
					assert.strictEqual(Option.isNone(gone), true)
					assert.strictEqual(Option.isSome(inherited), true)
					// The Items of the Turn that did not end are gone, so no tool call waits for a result.
					assert.deepStrictEqual<unknown>(
						Arr.map(items, (item) => [
							item.seq,
							item.id,
							item.origin?.chat,
							item.origin?.turn,
						]),
						[
							[1, "itm_old1", "ses_new", "turn_old1"],
							[2, "itm_old2", "ses_new", "turn_old1"],
							[3, "itm_new1", "ses_new", "turn_new1"],
							[4, "itm_new2", "ses_new", "turn_new1"],
						],
					)
					assert.strictEqual(HashMap.size(ChatState.unansweredCalls(items)), 0)
					assert.strictEqual(view.chat.seq, 4)
					// The window of the model loses the same messages.
					assert.strictEqual(view.state.conversation.context._tag, "Prompt")
					assert.deepStrictEqual(
						view.state.conversation.context.prompt,
						ChatState.promptOf(items),
					)
					assert.strictEqual(view.state.conversation.closed, true)
					assert.deepStrictEqual<unknown>(view.state[Todos.storeKey], todos)
					assert.deepStrictEqual(
						Arr.map(turns, (turn) => [turn.id, turn.chat, turn.status._tag]),
						[
							["turn_old1", "ses_new", "Completed"],
							["turn_new1", "ses_new", "Completed"],
							["turn_new2", "ses_new", "Interrupted"],
						],
					)
					assert.deepStrictEqual(view.chat.turn, turns[2])
					assert.deepStrictEqual(view.chat.turn?.items, [])
					// Steer input for the Turn waits for the next Turn. A host action for it goes.
					assert.deepStrictEqual(
						Arr.map(view.chat.inbox, (entry) => [
							entry.id,
							entry.kind,
							entry.turn,
							entry.author,
						]),
						[
							["itm_steer", "message", undefined, undefined],
							["itm_next", "message", undefined, "user_b"],
						],
					)
					const state = ChatHost.hostState(view.chat)
					assert.deepStrictEqual<unknown>(state, {
						bot: "bot_1",
						kind: "direct",
						chain: {
							organizationId: "org_a",
							userId: "user_a",
							bots: ["bot_1"],
							chats: [],
						},
						planApproval: {
							approver: "person",
							timeoutMs: 1000,
							onTimeout: "stay",
						},
					})
					assert.strictEqual(view.chat.createdAt, 300)
				}),
		)

		it.effect(
			"the stored values of a Chat have no Session fields any more",
			() =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const rows = yield* sql<{
						readonly body: string
						readonly state: string
					}>`select body, state from openbot_chats where id = 'ses_new'`
					const body = yield* decodeObject(rows[0]!.body)
					const state = yield* decodeObject(rows[0]!.state)
					for (const key of [
						"head",
						"metadata",
						"pending",
						"turns",
						"inheritedTurns",
						"forkedFrom",
					])
						assert.strictEqual(key in body, false, key)
					const business = yield* Schema.decodeUnknownEffect(JsonObject)(
						body["business"],
					)
					assert.deepStrictEqual(Rec.keys(business), [
						"@openbot-build/openbot/chat-host",
					])
					assert.strictEqual(memoryKey in state, false)
					const turns = yield* sql<{
						readonly value: string
					}>`select value from openbot_chat_turns where chat = 'ses_new' order by position`
					for (const turn of yield* Effect.forEach(turns, (row) =>
						decodeObject(row.value),
					)) {
						for (const key of ["session", "start", "end"])
							assert.strictEqual(key in turn, false, key)
					}
				}),
		)

		it.effect(
			"a channel Chat keeps its title, and its window starts again when it does not fit",
			() =>
				Effect.gen(function* () {
					const store = yield* chatStore(namespaceA)
					const view = yield* store.read(Chat.Id.make("ses_chan"))
					const items = yield* store.items(view.chat.id)
					assert.deepStrictEqual(
						Arr.map(items, (item) => item.id),
						["itm_c1", "itm_c2"],
					)
					assert.strictEqual(HashMap.size(ChatState.unansweredCalls(items)), 0)
					assert.strictEqual(view.chat.turn?.status._tag, "Interrupted")
					// The window was made smaller in the Turn that did not end, so it starts again
					// from the Items that stay.
					assert.strictEqual(view.state.conversation.context._tag, "Prompt")
					assert.deepStrictEqual(
						view.state.conversation.context.prompt,
						ChatState.promptOf(items),
					)
					const state = ChatHost.hostState(view.chat)
					assert.strictEqual(state.kind, "channel")
					assert.strictEqual(state.title, "Team room")
					assert.deepStrictEqual(state.channel, {
						channel: "chn_1",
						conversation: "C1",
						group: true,
					})
				}),
		)

		it.effect("the lists of the server find the Chats", () =>
			Effect.gen(function* () {
				const db = yield* Db.make
				const listA = yield* StoredChats.list(db, namespaceA)
				const listB = yield* StoredChats.list(db, namespaceB)
				const direct = yield* StoredChats.direct(db, namespaceA, "bot_1")
				assert.deepStrictEqual(
					Arr.map(listA, (chat) => chat.id),
					["ses_chan", "ses_new"],
				)
				assert.deepStrictEqual<unknown>(
					Arr.map(listB, (chat) => [
						chat.id,
						chat.seq,
						chat.turn,
						chat.inbox.length,
					]),
					[["ses_b", 0, undefined, 1]],
				)
				assert.deepStrictEqual(direct, Option.some("ses_new"))
			}),
		)

		it.effect("the server adds Items after the Items that stay", () =>
			Effect.gen(function* () {
				const store = yield* chatStore(namespaceA)
				const changed = yield* store.modifyEffect({
					chat: Chat.Id.make("ses_new"),
					update: () =>
						Effect.succeed([
							undefined,
							Option.some({
								append: [
									{
										id: Item.Id.make("itm_after"),
										content: Prompt.make("What next?"),
									},
								],
							}),
						] as const),
				})
				assert.deepStrictEqual(
					Arr.map(changed.items, (item) => [item.id, item.seq]),
					[["itm_after", 5]],
				)
				assert.strictEqual(changed.view.chat.revision, 8)
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly revision: number
				}>`select revision from openbot_chats where id = 'ses_new'`
				assert.deepStrictEqual(rows, [{ revision: 8 }])
			}),
		)

		it.effect("Bot records change to the new forms and still decode", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const rows = yield* sql<{
					readonly kind: string
					readonly id: string
					readonly owner: string
					readonly scope: string
					readonly status: string
					readonly body: string
				}>`select kind, id, owner, scope, status, body from openbot_bot_records order by kind, id`
				const byId = HashMap.fromIterable(
					Arr.map(rows, (row) => [row.kind + ":" + row.id, row] as const),
				)
				const stored = (key: string) =>
					Effect.fromOption(HashMap.get(byId, key))
				assert.deepStrictEqual(
					Arr.map(rows, (row) => row.kind + ":" + row.id),
					[
						"bot:bot_1",
						"bot:bot_s",
						"confession:cnf_keep",
						"grant:grt_keep",
						"grant:grt_life",
						"memory_cursor:bot_1/ses_new",
						"memory_enrichment:ses_new/turn_new1",
						"request:req_done",
						"request:req_wait",
						"rule:rul_1",
					],
				)
				const bots = decodeJson(BotsApi.Bot)
				const lasting = yield* stored("bot:bot_1")
				assert.strictEqual(lasting.status, "active")
				assert.strictEqual("kind" in (yield* decodeObject(lasting.body)), false)
				yield* bots(lasting.body)
				// A Session Bot becomes an archived Bot of the Bot of its Session.
				const sessionBot = yield* stored("bot:bot_s")
				assert.deepStrictEqual(
					[sessionBot.owner, sessionBot.scope, sessionBot.status],
					["user_a", "bot_1", "archived"],
				)
				const archived = yield* bots(sessionBot.body)
				assert.deepStrictEqual<unknown>(archived.owner, {
					_tag: "Bot",
					bot: "bot_1",
					userId: "user_a",
				})
				assert.strictEqual(archived.archived, true)

				const grants = decodeJson(BotsApi.Grant)
				const keptRow = yield* stored("grant:grt_keep")
				const kept = yield* grants(keptRow.body)
				assert.deepStrictEqual([kept.scope, kept.chat], ["chat", "ses_new"])
				assert.strictEqual(
					"session" in (yield* decodeObject(keptRow.body)),
					false,
				)
				const lifetime = yield* grants((yield* stored("grant:grt_life")).body)
				assert.strictEqual(lifetime.scope, "lifetime")

				const requests = decodeJson(StoredRequest)
				const wait = yield* stored("request:req_wait")
				assert.strictEqual(wait.status, "cancelled")
				const cancelled = yield* requests(wait.body)
				assert.strictEqual(cancelled.request.status, "cancelled")
				assert.strictEqual(cancelled.request.chat, "ses_new")
				assert.strictEqual(cancelled.request.revision, 3)
				assert.deepStrictEqual(cancelled.request.decision?.by, {
					_tag: "Person",
					userId: "user_a",
				})
				assert.deepStrictEqual<unknown>(cancelled.request.endorsements, [
					{ bot: "bot_1", scope: "chat" },
				])
				assert.deepStrictEqual<unknown>(cancelled.chain.chats, ["ses_new"])
				const done = yield* requests((yield* stored("request:req_done")).body)
				assert.strictEqual(done.request.status, "allowed")
				assert.strictEqual(done.request.decision?.scope, "chat")

				const confession = yield* decodeJson(BotMemory.Confession)(
					(yield* stored("confession:cnf_keep")).body,
				)
				assert.strictEqual(confession.chat, "ses_new")
				const enrichment = yield* decodeJson(BotMemory.Enrichment)(
					(yield* stored("memory_enrichment:ses_new/turn_new1")).body,
				)
				assert.strictEqual(enrichment.chat, "ses_new")
				// The memory Bot read up to the last Item that stays and that it had read.
				assert.deepStrictEqual(
					yield* decodeObject(
						(yield* stored("memory_cursor:bot_1/ses_new")).body,
					),
					{ after: 3 },
				)
			}),
		)

		it.effect("Bot memory names Chats", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const memories = yield* sql<{
					readonly sources: string
				}>`select sources from openbot_bot_memories`
				assert.deepStrictEqual<unknown>(
					yield* Schema.decodeEffect(
						Schema.fromJsonString(Schema.Array(BotMemory.Source)),
					)(memories[0]!.sources),
					[{ chat: "ses_new", item: "itm_new1" }, { entry: "mem_0" }],
				)
				const tags = yield* sql<{
					readonly tag: string
				}>`select tag from openbot_bot_memory_tags order by tag`
				assert.deepStrictEqual(
					Arr.map(tags, (row) => row.tag),
					["chat:ses_new", "from:user_a"],
				)
			}),
		)

		it.effect("policies use the words of Chats", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				// A later migration changes policies into ability policies. The keys of
				// Chats become paths with `chat`, so the rules about Chats stay.
				const decodePolicy = Schema.decodeEffect(Authorization.PolicySchema)
				for (const table of [
					"openbot_roles",
					"openbot_members",
					"openbot_tokens",
				]) {
					const rows = yield* sql<{
						readonly policy: string
					}>`select policy from ${sql(table)}`
					const policy = yield* decodePolicy(rows[0]!.policy)
					const own = Authorization.Chat.make({
						organizationId: "org_a",
						ownerUserId: "user_a",
						id: "ses_new",
					})
					assert.strictEqual(
						Policy.decideSync(policy, {
							principal: {
								kind: "member",
								userId: "user_a",
								organizationId: "org_a",
							},
							action: "write",
							resource: own,
						})._tag,
						"Allow",
						table,
					)
				}
				const roles = yield* sql<{
					readonly description: string
				}>`select description from openbot_roles`
				assert.strictEqual(roles[0]!.description, "Sessions and Bots.")
				const platform = yield* sql<{
					readonly document: string
				}>`select document from openbot_settings where scope_kind = 'platform'`
				const settings = yield* Schema.decodeEffect(
					Schema.fromJsonString(
						Schema.Struct({ ceiling: Authorization.CeilingSchema }),
					),
				)(platform[0]!.document)
				assert.isTrue(Authorization.onlyDenies(settings.ceiling))
			}),
		)

		it.effect(
			"settings lose the memory switches, and usage keeps its cost",
			() =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const settings = yield* sql<{
						readonly scope_kind: string
						readonly document: string
					}>`select scope_kind, document from openbot_settings where scope_kind <> 'platform' order by scope_kind`
					assert.deepStrictEqual<unknown>(
						yield* Effect.forEach(settings, (row) =>
							Effect.map(decodeObject(row.document), (document) => [
								row.scope_kind,
								document,
							]),
						),
						[
							["member", { defaultBot: "bot_1" }],
							["organization", { botMemory: true }],
						],
					)
					const usage = yield* sql<{
						readonly id: string
						readonly source: string
						readonly chat_id: string
						readonly cost_micros: string
					}>`select id, source, chat_id, cost_micros from openbot_usage_events order by id`
					assert.deepStrictEqual(
						Arr.map(usage, (row) => [
							row.id,
							row.source,
							row.chat_id,
							Number(row.cost_micros),
						]),
						[
							["use_memory", "other", "ses_new", 7],
							["use_turn", "turn", "ses_new", 7],
						],
					)
				}),
		)

		it.effect(
			"sealed records of Sessions go, and deliveries stay only for Chats that stay",
			() =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const deliveries = yield* sql<{
						readonly id: string
						readonly chat: string | null
					}>`select id, chat from openbot_channel_deliveries order by id`
					assert.deepStrictEqual(
						Arr.map(deliveries, (row) => [row.id, row.chat]),
						[
							["dlv_keep", "ses_chan"],
							["dlv_notice", null],
						],
					)
					const conversations = yield* sql<{
						readonly chat: string
					}>`select chat from openbot_channel_conversations`
					assert.deepStrictEqual(conversations, [{ chat: "ses_chan" }])
					const invocations = yield* sql<{
						readonly id: string
					}>`select id from openbot_app_invocations`
					assert.deepStrictEqual(invocations, [])
					const runs = yield* sql<{
						readonly id: string
					}>`select id from openbot_code_runs`
					assert.deepStrictEqual(runs, [])
					const secrets = yield* sql<{
						readonly kind: string
					}>`select kind from openbot_app_secrets`
					assert.deepStrictEqual(secrets, [{ kind: "app-token" }])
				}),
		)
	},
)
