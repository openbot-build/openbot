import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { fileURLToPath } from "node:url"
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
	Effect,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schema,
} from "effect"
import { Prompt } from "effect/ai"
import type { SqlError } from "effect/sql"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as StoredChats from "../src/chats/StoredChats.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as Todos from "../src/plugins/work/Todos.ts"
import { Stored as StoredRequest } from "../src/capabilities/Requests.ts"
import * as PostgresTest from "./PostgresTest.ts"

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))
const chatsMigration = "20261023194809_chats"
const host = "@openbot-build/openbot/session-host"
const memoryKey = "@openbot-build/openbot/memory"
const namespaceA = JSON.stringify(["org_a", "user_a"])
const namespaceB = JSON.stringify(["org_a", "user_b"])

// Old Items and windows keep their messages in the same JSON as the store wrote them.
const encodePrompt = Schema.encodeSync(Item.Entry.fields.content)
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
	items.flatMap((item) => [...Prompt.make(item.input).content])

const contentRow = (namespace: string, item: OldItem) => ({
	namespace,
	id: "cnt_" + item.id,
	message: item.id,
	content: JSON.stringify({
		content: messages(item.input),
		origin: { session: item.session, turn: item.turn, step: 0 },
	}),
})

const versionRow = (input: {
	readonly namespace: string
	readonly id: string
	readonly items: ReadonlyArray<OldItem>
	readonly value: object
}) => ({
	namespace: input.namespace,
	id: input.id,
	schema_version: "timeline/1",
	parents: "[]",
	snapshot_format: 2,
	value: JSON.stringify(input.value),
	history: JSON.stringify(
		input.items.map((item) => ({
			message: item.id,
			content: "cnt_" + item.id,
		})),
	),
})

const promptWindow = (items: ReadonlyArray<OldItem>) => ({
	_tag: "Prompt",
	prompt: messages(allMessages(items)),
})

const oldTurn = (input: {
	readonly id: string
	readonly session: string
	readonly status: object
	readonly startedAt: number
	readonly completedAt?: number
	readonly items: ReadonlyArray<string>
}) => ({
	id: input.id,
	session: input.session,
	settings: { mode: "build" },
	status: input.status,
	steps: 1,
	input: input.items.slice(0, 1),
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

const sessionRow = (input: {
	readonly namespace: string
	readonly id: string
	readonly head: string
	readonly host: object
	readonly title?: string
	readonly turns: ReadonlyArray<ReturnType<typeof oldTurn>>
	readonly inheritedTurns?: ReadonlyArray<ReturnType<typeof oldTurn>>
	readonly pending?: ReadonlyArray<object>
	readonly forkedFrom?: object
}) => {
	const last = input.turns.at(-1)
	return {
		namespace: input.namespace,
		id: input.id,
		body: JSON.stringify({
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
		status:
			last === undefined ? "Idle" : (last.status as { _tag: string })._tag,
		turn: last?.id ?? null,
		response: null,
		response_summary: null,
		revision: 7,
	}
}

const record = (
	kind: string,
	id: string,
	keys: {
		readonly owner: string
		readonly scope: string
		readonly status: string
	},
	body: object,
) => ({
	kind,
	organization_id: "org_a",
	id,
	...keys,
	body: JSON.stringify(body),
})

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
	yield* insert("openbot_timeline_contents", [
		...newItems.map((item) => contentRow(namespaceA, item)),
		...channelItems.map((item) => contentRow(namespaceA, item)),
		...delegatedItems.map((item) => contentRow(namespaceA, item)),
	])
	yield* insert("openbot_timeline_versions", [
		versionRow({
			namespace: namespaceA,
			id: "ver_old",
			items: oldItems,
			value: {
				conversation: { context: promptWindow(oldItems), closed: true },
			},
		}),
		versionRow({
			namespace: namespaceA,
			id: "ver_new",
			items: newItems,
			value: {
				[Todos.storeKey]: todos,
				[memoryKey]: { entries: {}, processed: [] },
				conversation: { context: promptWindow(newItems), closed: false },
			},
		}),
		versionRow({
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
						prompt: messages(said("A short note about the chat.")),
					},
					closed: false,
				},
			},
		}),
		versionRow({
			namespace: namespaceA,
			id: "ver_del",
			items: delegatedItems,
			value: {
				conversation: { context: promptWindow(delegatedItems), closed: true },
			},
		}),
		versionRow({
			namespace: namespaceB,
			id: "ver_b",
			items: [],
			value: { conversation: { context: promptWindow([]), closed: true } },
		}),
	])
	yield* insert("openbot_session_references", [
		sessionRow({
			namespace: namespaceA,
			id: "ses_old",
			head: "ver_old",
			host: { bot: "bot_1", kind: "direct", chain: chain("user_a") },
			title: "Trip",
			turns: [turnOld1],
		}),
		sessionRow({
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
					content: messages(said("Be quick.")),
				},
				{
					id: "itm_action",
					kind: "action",
					turn: "turn_new2",
					action: { name: "open", arguments: {} },
					content: messages(said("Open it.")),
				},
				{
					id: "itm_next",
					kind: "message",
					author: "user_b",
					content: messages(said("And then?")),
				},
			],
		}),
		sessionRow({
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
		sessionRow({
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
		sessionRow({
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
				{ id: "itm_b1", kind: "message", content: messages(said("Hi.")) },
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
		["app-view", "app-ui-state", "app-view-action", "app-token"].map(
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
	yield* insert("openbot_bot_records", [
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
	])
	yield* insert("openbot_bot_memories", [
		{
			organization_id: "org_a",
			home_bot: "bot_1",
			id: "mem_1",
			layer: "fact",
			content: "The person likes Rome.",
			sources: JSON.stringify([
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
		["session:ses_new", "from:user_a"].map((tag) => ({
			organization_id: "org_a",
			home_bot: "bot_1",
			memory_id: "mem_1",
			tag,
		})),
	)
	yield* insert("openbot_roles", [
		{
			organization_id: "org_a",
			id: "role_1",
			name: "Helper",
			description: "Sessions and Bots.",
			policies: JSON.stringify(policies),
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
			policies: JSON.stringify(policies),
			joined_at: 1,
		},
	])
	yield* insert("openbot_tokens", [
		{
			id: "tok_1",
			organization_id: "org_a",
			user_id: "user_a",
			name: "Token",
			prefix: "ob_1",
			hash: "hash_1",
			policies: JSON.stringify(policies),
			created_at: 1,
		},
	])
	const setting = (kind: string, id: string, document: object) => ({
		scope_kind: kind,
		scope_id: id,
		document: JSON.stringify(document),
		version: 1,
		updated_at: 1,
	})
	yield* insert("openbot_settings", [
		setting("platform", "platform", {
			policyCeiling: [{ ...policies[0], effect: "deny" }],
		}),
		setting("organization", "org_a", {
			memory: { use: true, generate: false },
			botMemory: true,
		}),
		setting("member", "org_a/user_a", { defaultBot: "bot_1" }),
	])
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
const decodeJson =
	<A, I>(schema: Schema.Codec<A, I>) =>
	(text: string): A =>
		Schema.decodeUnknownSync(Schema.toCodecJson(schema))(JSON.parse(text))

const makeRuntime = (url: string) =>
	ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)

describe("Sessions become Chats, and stored values that named Sessions name Chats", () => {
	let database: Awaited<ReturnType<typeof PostgresTest.start>> | undefined
	let before: string | undefined
	let through: string | undefined
	let runtime!: ReturnType<typeof makeRuntime>

	beforeAll(async () => {
		database = await PostgresTest.start()
		const beforeFolder = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
		before = beforeFolder
		const throughFolder = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
		through = throughFolder
		runtime = makeRuntime(database.url)
		for (const name of await readdir(migrations)) {
			if (name < chatsMigration)
				await cp(join(migrations, name), join(beforeFolder, name), {
					recursive: true,
				})
			if (name <= chatsMigration)
				await cp(join(migrations, name), join(throughFolder, name), {
					recursive: true,
				})
		}
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				yield* migrate(db, { migrationsFolder: beforeFolder })
				yield* insertOldData
				yield* migrate(db, { migrationsFolder: throughFolder })
				// Later migrations add tables, and the server checks every table
				// of the new schema when it starts.
				yield* migrate(db, { migrationsFolder: migrations })
				yield* DatabasePostgres.check
			}),
		)
	}, 120_000)

	afterAll(async () => {
		await runtime?.dispose()
		if (before !== undefined) await rm(before, { recursive: true, force: true })
		if (through !== undefined)
			await rm(through, { recursive: true, force: true })
		await database?.close()
	})

	const query = <A extends object>(
		run: (
			sql: PgClient.PgClient,
		) => Effect.Effect<ReadonlyArray<A>, SqlError.SqlError>,
	) =>
		runtime.runPromise(
			Effect.gen(function* () {
				return yield* run(yield* PgClient.PgClient)
			}),
		)

	it("only channel Sessions and the newest direct Session of each Bot stay", async () => {
		const rows = await query(
			(sql) =>
				sql<{
					readonly namespace: string
					readonly id: string
					readonly kind: string
					readonly bot: string
					readonly status: string
					readonly turn: string | null
					readonly inbox_size: number
					readonly revision: number
				}>`select namespace, id, kind, bot, status, turn, inbox_size, revision from openbot_chats order by id`,
		)
		assert.deepStrictEqual(
			rows.map((row) => [
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
		const tables = await query(
			(sql) =>
				sql<{
					readonly tablename: string
				}>`select tablename from pg_catalog.pg_tables where tablename in ('openbot_session_references', 'openbot_timeline_versions', 'openbot_timeline_contents')`,
		)
		assert.deepStrictEqual(tables, [])
	})

	it("the server reads a forked Chat whose last Turn did not end", async () => {
		const read = await runtime.runPromise(
			Effect.scoped(
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
					return { view, items, turns, inherited, gone }
				}),
			),
		)
		const { view, items, turns } = read
		assert.strictEqual(Option.isNone(read.gone), true)
		assert.strictEqual(Option.isSome(read.inherited), true)
		// The Items of the Turn that did not end are gone, so no tool call waits for a result.
		assert.deepStrictEqual<unknown>(
			items.map((item) => [
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
			turns.map((turn) => [turn.id, turn.chat, turn.status._tag]),
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
			view.chat.inbox.map((entry) => [
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
	})

	it("the stored values of a Chat have no Session fields any more", async () => {
		const rows = await query(
			(sql) =>
				sql<{
					readonly body: string
					readonly state: string
				}>`select body, state from openbot_chats where id = 'ses_new'`,
		)
		const body = JSON.parse(rows[0]!.body)
		const state = JSON.parse(rows[0]!.state)
		for (const key of [
			"head",
			"metadata",
			"pending",
			"turns",
			"inheritedTurns",
			"forkedFrom",
		])
			assert.strictEqual(key in body, false, key)
		assert.deepStrictEqual(Object.keys(body.business), [
			"@openbot-build/openbot/chat-host",
		])
		assert.strictEqual(memoryKey in state, false)
		const turns = await query(
			(sql) =>
				sql<{
					readonly value: string
				}>`select value from openbot_chat_turns where chat = 'ses_new' order by position`,
		)
		for (const turn of turns.map((row) => JSON.parse(row.value))) {
			for (const key of ["session", "start", "end"])
				assert.strictEqual(key in turn, false, key)
		}
	})

	it("a channel Chat keeps its title, and its window starts again when it does not fit", async () => {
		const read = await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* chatStore(namespaceA)
					const view = yield* store.read(Chat.Id.make("ses_chan"))
					const items = yield* store.items(view.chat.id)
					return { view, items }
				}),
			),
		)
		const { view, items } = read
		assert.deepStrictEqual(
			items.map((item) => item.id),
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
	})

	it("the lists of the server find the Chats", async () => {
		const found = await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				const listA = yield* StoredChats.list(db, namespaceA)
				const listB = yield* StoredChats.list(db, namespaceB)
				const direct = yield* StoredChats.direct(db, namespaceA, "bot_1")
				return { listA, listB, direct }
			}),
		)
		assert.deepStrictEqual(
			found.listA.map((chat) => chat.id),
			["ses_chan", "ses_new"],
		)
		assert.deepStrictEqual<unknown>(
			found.listB.map((chat) => [
				chat.id,
				chat.seq,
				chat.turn,
				chat.inbox.length,
			]),
			[["ses_b", 0, undefined, 1]],
		)
		assert.deepStrictEqual(found.direct, Option.some("ses_new"))
	})

	it("the server adds Items after the Items that stay", async () => {
		const changed = await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* chatStore(namespaceA)
					return yield* store.modifyEffect({
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
				}),
			),
		)
		assert.deepStrictEqual(
			changed.items.map((item) => [item.id, item.seq]),
			[["itm_after", 5]],
		)
		assert.strictEqual(changed.view.chat.revision, 8)
		const rows = await query(
			(sql) =>
				sql<{
					readonly revision: number
				}>`select revision from openbot_chats where id = 'ses_new'`,
		)
		assert.deepStrictEqual(rows, [{ revision: 8 }])
	})

	it("Bot records change to the new forms and still decode", async () => {
		const rows = await query(
			(sql) =>
				sql<{
					readonly kind: string
					readonly id: string
					readonly owner: string
					readonly scope: string
					readonly status: string
					readonly body: string
				}>`select kind, id, owner, scope, status, body from openbot_bot_records order by kind, id`,
		)
		const byId = new Map(rows.map((row) => [row.kind + ":" + row.id, row]))
		assert.deepStrictEqual(
			rows.map((row) => row.kind + ":" + row.id),
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
		const lasting = byId.get("bot:bot_1")!
		assert.strictEqual(lasting.status, "active")
		assert.strictEqual("kind" in JSON.parse(lasting.body), false)
		bots(lasting.body)
		// A Session Bot becomes an archived Bot of the Bot of its Session.
		const sessionBot = byId.get("bot:bot_s")!
		assert.deepStrictEqual(
			[sessionBot.owner, sessionBot.scope, sessionBot.status],
			["user_a", "bot_1", "archived"],
		)
		const archived = bots(sessionBot.body)
		assert.deepStrictEqual<unknown>(archived.owner, {
			_tag: "Bot",
			bot: "bot_1",
			userId: "user_a",
		})
		assert.strictEqual(archived.archived, true)

		const grants = decodeJson(BotsApi.Grant)
		const kept = grants(byId.get("grant:grt_keep")!.body)
		assert.deepStrictEqual([kept.scope, kept.chat], ["chat", "ses_new"])
		assert.strictEqual(
			"session" in JSON.parse(byId.get("grant:grt_keep")!.body),
			false,
		)
		assert.strictEqual(
			grants(byId.get("grant:grt_life")!.body).scope,
			"lifetime",
		)

		const requests = decodeJson(StoredRequest)
		const wait = byId.get("request:req_wait")!
		assert.strictEqual(wait.status, "cancelled")
		const cancelled = requests(wait.body)
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
		const done = requests(byId.get("request:req_done")!.body)
		assert.strictEqual(done.request.status, "allowed")
		assert.strictEqual(done.request.decision?.scope, "chat")

		const confession = decodeJson(BotMemory.Confession)(
			byId.get("confession:cnf_keep")!.body,
		)
		assert.strictEqual(confession.chat, "ses_new")
		const enrichment = decodeJson(BotMemory.Enrichment)(
			byId.get("memory_enrichment:ses_new/turn_new1")!.body,
		)
		assert.strictEqual(enrichment.chat, "ses_new")
		// The memory Bot read up to the last Item that stays and that it had read.
		assert.deepStrictEqual(
			JSON.parse(byId.get("memory_cursor:bot_1/ses_new")!.body),
			{ after: 3 },
		)
	})

	it("Bot memory names Chats", async () => {
		const memories = await query(
			(sql) =>
				sql<{
					readonly sources: string
				}>`select sources from openbot_bot_memories`,
		)
		assert.deepStrictEqual<unknown>(
			Schema.decodeSync(Schema.fromJsonString(Schema.Array(BotMemory.Source)))(
				memories[0]!.sources,
			),
			[{ chat: "ses_new", item: "itm_new1" }, { entry: "mem_0" }],
		)
		const tags = await query(
			(sql) =>
				sql<{
					readonly tag: string
				}>`select tag from openbot_bot_memory_tags order by tag`,
		)
		assert.deepStrictEqual(
			tags.map((row) => row.tag),
			["chat:ses_new", "from:user_a"],
		)
	})

	it("policies use the words of Chats", async () => {
		// A later migration changes policies into ability policies. The keys of
		// Chats become paths with `chat`, so the rules about Chats stay.
		const decodePolicy = decodeJson(Authorization.PolicySchema)
		for (const table of [
			"openbot_roles",
			"openbot_members",
			"openbot_tokens",
		]) {
			const rows = await query(
				(sql) =>
					sql<{
						readonly policy: string
					}>`select policy from ${sql(table)}`,
			)
			const policy = decodePolicy(rows[0]!.policy)
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
		const roles = await query(
			(sql) =>
				sql<{
					readonly description: string
				}>`select description from openbot_roles`,
		)
		assert.strictEqual(roles[0]!.description, "Sessions and Bots.")
		const platform = await query(
			(sql) =>
				sql<{
					readonly document: string
				}>`select document from openbot_settings where scope_kind = 'platform'`,
		)
		assert.isTrue(
			Authorization.onlyDenies(
				Schema.decodeUnknownSync(Authorization.CeilingSchema)(
					JSON.parse(platform[0]!.document).ceiling,
				),
			),
		)
	})

	it("settings lose the memory switches, and usage keeps its cost", async () => {
		const settings = await query(
			(sql) =>
				sql<{
					readonly scope_kind: string
					readonly document: string
				}>`select scope_kind, document from openbot_settings where scope_kind <> 'platform' order by scope_kind`,
		)
		assert.deepStrictEqual(
			settings.map((row) => [row.scope_kind, JSON.parse(row.document)]),
			[
				["member", { defaultBot: "bot_1" }],
				["organization", { botMemory: true }],
			],
		)
		const usage = await query(
			(sql) =>
				sql<{
					readonly id: string
					readonly source: string
					readonly chat_id: string
					readonly cost_micros: string
				}>`select id, source, chat_id, cost_micros from openbot_usage_events order by id`,
		)
		assert.deepStrictEqual(
			usage.map((row) => [
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
	})

	it("sealed records of Sessions go, and deliveries stay only for Chats that stay", async () => {
		const deliveries = await query(
			(sql) =>
				sql<{
					readonly id: string
					readonly chat: string | null
				}>`select id, chat from openbot_channel_deliveries order by id`,
		)
		assert.deepStrictEqual(
			deliveries.map((row) => [row.id, row.chat]),
			[
				["dlv_keep", "ses_chan"],
				["dlv_notice", null],
			],
		)
		const conversations = await query(
			(sql) =>
				sql<{
					readonly chat: string
				}>`select chat from openbot_channel_conversations`,
		)
		assert.deepStrictEqual(conversations, [{ chat: "ses_chan" }])
		const invocations = await query(
			(sql) =>
				sql<{
					readonly id: string
				}>`select id from openbot_app_invocations`,
		)
		assert.deepStrictEqual(invocations, [])
		const runs = await query(
			(sql) => sql<{ readonly id: string }>`select id from openbot_code_runs`,
		)
		assert.deepStrictEqual(runs, [])
		const secrets = await query(
			(sql) =>
				sql<{
					readonly kind: string
				}>`select kind from openbot_app_secrets`,
		)
		assert.deepStrictEqual(secrets, [{ kind: "app-token" }])
	})
})
