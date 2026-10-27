import { PgClient } from "@effect/sql-pg"
import { Item } from "@openbot-build/core"
import { Authorization } from "@openbot-build/domain"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Schema, String as Str } from "effect"
import { Prompt } from "effect/ai"
import * as Db from "../src/database/Database.ts"
import * as Legacy from "../src/database/conversion/LegacyChats.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as MigrationTest from "./MigrationTest.ts"

/** These values use the stored shapes at 2a123ff, before execution records. */
export const namespace = '["org","person"]'
const owner = namespace
export const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
import * as LegacyApps from "../src/database/conversion/LegacyApps.ts"
const chain = {
	organizationId: "org",
	userId: "person",
	bots: ["bot"],
	chats: [],
}
const host = { bot: "bot", kind: "direct", chain }
export const before = Effect.gen(function* () {
	const db = yield* Db.make
	const folder = yield* MigrationTest.migrationsWhere(
		(name) => name < "20261026084803_execution_records",
	)
	yield* migrate(db, { migrationsFolder: folder })
})
export const turn = (id: string) => ({
	id,
	chat: "chat",
	settings: { mode: "build" },
	status: {
		_tag: "Completed",
		result: { text: "saved answer", finishReason: "stop" },
	},
	steps: 0,
	input: [],
	items: [],
	startedAt: 1,
	completedAt: 2,
})
const saveChat = (
	current: Schema.Json,
	seq = 0,
	inbox: ReadonlyArray<Schema.Json> = [],
) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const value = yield* Schema.decodeUnknownEffect(Legacy.Turn)(current)
		const body = {
			id: "chat",
			revision: 7,
			settings: { mode: "build" },
			inbox,
			turn: current,
			seq,
			business: { [Legacy.hostKey]: host },
			createdAt: 1,
		}
		const prompt = yield* Schema.encodeEffect(Item.Entry.fields.content)(
			Prompt.empty,
		)
		yield* sql`insert into openbot_chats ${sql.insert({ namespace, id: "chat", body: yield* encode(body), state: yield* encode({ conversation: { context: { _tag: "Prompt", prompt }, closed: value.status._tag !== "Running" }, privatePlugin: { note: "private state" } }), bot: "bot", kind: "direct", status: value.status._tag, turn: value.id, revision: 7, inbox_size: inbox.length, created_at: 1, updated_at: 2 })}`
	})
const saveTurn = (value: Schema.Json) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const record = yield* Schema.decodeUnknownEffect(Legacy.Turn)(value)
		yield* sql`insert into openbot_chat_turns ${sql.insert({ namespace, chat: "chat", id: record.id, value: yield* encode(value) })}`
	})
const source = {
	connectionId: "connection",
	connectionName: "Saved App",
	cardUrl: "https://example.test/card",
	appName: "Saved App",
	remoteIndex: 0,
	revision: 1,
	kind: "tool" as const,
	name: "write",
}
const invocation = (id: string): LegacyApps.Invocation => ({
	id,
	chat: "chat",
	turn: "turn",
	callId: "tool-call",
	toolName: "apps.saved.write",
	source,
	arguments: { text: "private input" },
	readOnly: false,
	round: 0,
	status: "Sending",
	result: null,
})
const appRecords = Effect.gen(function* () {
	const secrets = yield* Secrets.Secrets
	const sql = yield* PgClient.PgClient
	const seal = (value: Schema.Json, binding: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			return yield* secrets.seal(yield* encode(value), yield* encode(binding))
		})
	const addInvocation = (value: LegacyApps.Invocation) =>
		Effect.gen(function* () {
			yield* sql`insert into openbot_app_invocations ${sql.insert({ owner, id: value.id, chat: value.chat, status: value.status, body: yield* seal(value, ["app-invocation", owner, value.id]) })}`
		})
	return { seal, addInvocation }
})

export const chats = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const content = yield* Schema.encodeEffect(Item.Entry.fields.content)(
		Prompt.make([
			{
				role: "assistant",
				content: [
					Prompt.toolCallPart({
						id: "outside",
						name: "write",
						params: { value: "private write" },
						providerExecuted: false,
					}),
					Prompt.toolCallPart({
						id: "wait",
						name: "allowed_later",
						params: {},
						providerExecuted: false,
					}),
					Prompt.toolApprovalRequestPart({
						approvalId: "approval",
						toolCallId: "wait",
					}),
				],
			},
		]),
	)
	const current = {
		id: "turn",
		chat: "chat",
		settings: { mode: "build" },
		status: { _tag: "Running" },
		steps: 0,
		input: [],
		items: ["item"],
		startedAt: 1,
	}
	const input = {
		id: "queued",
		content: yield* Schema.encodeEffect(Item.Entry.fields.content)(
			Prompt.make([{ role: "user", content: "private queued input" }]),
		),
		kind: "message",
	}
	yield* saveChat(current, 1, [input])
	yield* saveTurn(current)
	yield* saveTurn(turn("old-turn"))
	const item = {
		id: "item",
		seq: 1,
		content,
		origin: { chat: "chat", turn: "turn", step: 0 },
	}
	yield* sql`insert into openbot_chat_items ${sql.insert({ namespace, chat: "chat", seq: 1, id: "item", turn: "turn", value: yield* encode(item) })}`
	const request = {
		request: {
			id: "approval",
			bot: "bot",
			capability: { action: "tools.call", target: "allowed_later" },
			reason: "Please allow the call.",
			approver: { _tag: "Person", userId: "person" },
			chain: ["bot"],
			chat: "chat",
			turn: "turn",
			toolCallId: "wait",
			endorsements: [],
			status: "pending",
			decision: null,
			revision: 0,
			createdAt: 1,
			expiresAt: 9999999999999,
		},
		chain,
		call: {
			name: "allowed_later",
			params: { value: "private approval" },
		},
	}
	yield* sql`insert into openbot_bot_records ${sql.insert({ kind: "request", organization_id: "org", id: "approval", owner: "person:person", scope: "chat", status: "pending", body: yield* encode(request) })}`
	const delegation = {
		delegation: {
			id: "work",
			parent: { chat: "chat", turn: "turn", toolCallId: "delegated" },
			bot: "bot",
			chat: null,
			status: "running",
			task: "private task",
			result: null,
			createdAt: 1,
			updatedAt: 2,
		},
		userId: "person",
		author: "person",
		chain,
		runningSince: 1,
	}
	yield* sql`insert into openbot_bot_records ${sql.insert({ kind: "delegation", organization_id: "org", id: "work", owner: "person", scope: "chat", status: "running", body: yield* encode(delegation) })}`
	const tool = {
		id: "tool",
		chat: "chat",
		turn: "turn",
		callId: "outside",
		tool: "write",
		kind: "tool",
		status: { _tag: "Running" },
		startedAt: 1,
	}
	yield* sql`insert into openbot_operations ${sql.insert({ namespace, id: "tool", chat: "chat", status: "Running", body: yield* encode(tool), started_at: 1, heartbeat_at: 1 })}`
	const doneTool = {
		...tool,
		id: "done-tool",
		callId: "done-call",
		status: {
			_tag: "Completed",
			result: { value: "private tool result" },
		},
		endedAt: 2,
	}
	yield* sql`insert into openbot_operations ${sql.insert({ namespace, id: doneTool.id, chat: "chat", status: "Completed", body: yield* encode(doneTool), started_at: 1, heartbeat_at: 2 })}`
})

export const channels = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets.Secrets
	const credentials = {
		kind: "custom",
		endpoint: "https://channel.example.test",
		secret: "private channel key",
	}
	yield* sql`insert into openbot_channels ${sql.insert({
		organization_id: "org",
		id: "channel",
		kind: "custom",
		name: "Channel",
		bot: "bot",
		actor: "person",
		enabled: true,
		credentials: yield* secrets.seal(
			yield* encode(credentials),
			"openbot_channels:channel:credentials",
		),
		hints: yield* encode({
			hints: { secret: "key" },
			plain: { endpoint: credentials.endpoint },
		}),
		version: 1,
		created_at: 1,
		updated_at: 2,
	})}`
	const event = (id: string) => ({
		_tag: "Message",
		eventId: id,
		conversation: { key: "room", kind: "group" },
		sender: { externalId: "external-person", displayName: "Person" },
		text: "private input",
		mentioned: true,
	})
	for (let index = 100; index >= 0; index--) {
		const id = Str.padStart(3, "0")(String(index))
		yield* sql`insert into openbot_channel_inbox ${sql.insert({
			organization_id: "org",
			channel_id: "channel",
			event_id: id,
			conversation_key: "room",
			event: index === 100 ? "broken" : yield* encode(event(id)),
			received_at: index + 10,
			next_at: index + 1000,
			claim: index === 0 ? "old-worker" : null,
		})}`
	}
	for (const [id, state, claim, ref] of [
		["pending", "pending", null, null],
		["sending", "pending", "old-worker", null],
		["sent", "done", null, { conversation: "room", id: "external-message" }],
	] as const) {
		yield* sql`insert into openbot_channel_deliveries ${sql.insert({
			id,
			organization_id: "org",
			channel_id: "channel",
			kind: "notice",
			state,
			claim,
			target: yield* encode({
				_tag: "Conversation",
				conversation: "room",
			}),
			body: yield* encode({ markdown: "private message" }),
			ref: ref === null ? null : yield* encode(ref),
			next_at: 9000,
			updated_at: 100,
		})}`
	}
	yield* sql`insert into openbot_triggers ${sql.insert({
		organization_id: "org",
		id: "trigger",
		owner_user_id: "person",
		bot: "bot",
		prompt: "private prompt",
		schedule_cron: "0 * * * *",
		next_run_at: 5000,
		actor: "person",
		enabled: true,
		revision: 2,
		created_at: 1,
		updated_at: 2,
	})}`
	const reminder = {
		id: "reminder",
		userId: "person",
		author: "person",
		chat: "chat",
		turn: "turn",
		toolCallId: "tool",
		note: "private reminder",
		createdAt: 1,
		dueAt: 7000,
		status: "waiting",
	}
	yield* sql`insert into openbot_bot_records ${sql.insert({
		kind: "reminder",
		organization_id: "org",
		id: "reminder",
		owner: "person",
		scope: "chat",
		status: "waiting",
		body: yield* encode(reminder),
	})}`
	yield* sql`insert into openbot_computers ${sql.insert({
		organization_id: "org",
		id: "computer",
		owner_user_id: "person",
		name: "Computer",
		source: "connector",
		state: "running",
		features: yield* encode({
			pause: false,
			desktop: true,
			ports: false,
		}),
		created_by: "person",
		version: 1,
		created_at: 1,
		updated_at: 2,
	})}`
	yield* sql`insert into openbot_computer_calls ${sql.insert({
		id: "call",
		computer_id: "computer",
		call: yield* encode({
			id: "call",
			operation: {
				_tag: "Write",
				file: {
					path: "/private",
					encoding: "utf8",
					content: "private file",
				},
			},
		}),
		created_at: 3,
	})}`
})

export const event = (id: string) => ({
	_tag: "Message",
	eventId: id,
	conversation: { key: "room", kind: "group" },
	sender: { externalId: "external-person", displayName: "Person" },
	text: "private input",
	mentioned: true,
})

export const applications = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets.Secrets
	const saved = yield* appRecords
	yield* saved.addInvocation(invocation("a"))
	yield* saved.addInvocation({ ...invocation("b"), status: "PendingApproval" })
	yield* saved.addInvocation({
		...invocation("c"),
		status: "Completed",
		result: {
			_tag: "Completed",
			operationId: "c",
			source,
			result: { note: "private result" },
		},
	})
	const run = {
		id: "program",
		chat: "chat",
		turn: "turn",
		callId: "tool-call",
		status: "Running",
		code: "await apps.saved.write({ text: 'private input' })",
		reason: "Save the note.",
		calls: [
			{
				index: 0,
				binding: "apps.saved.write",
				source,
				operationId: "a",
				argumentsHash: "saved-hash",
				outcome: { _tag: "Waiting" },
			},
		],
		result: null,
		createdAt: 7,
		updatedAt: 9,
		seed: 42,
		clock: 7,
		organizationId: "org",
		userId: "person",
	} satisfies Schema.Json
	yield* sql`insert into openbot_code_runs ${sql.insert({ owner, id: "program", chat: "chat", call_id: "tool-call", status: "Running", lease_until: 99, body: yield* saved.seal(run, ["code-run", owner, "program"]) })}`
	const binding = {
		owner,
		connectionId: "test",
		resource: "https://example.test/mcp",
		issuer: "https://example.test",
	}
	const credential = {
		binding,
		accessToken: "private-access",
		refreshToken: "private-refresh",
		scopes: ["read"],
	}
	const flow = {
		flowId: "flow",
		binding,
		clientId: "https://host.test/metadata",
		redirectUri: "https://host.test/callback",
		scopes: ["read"],
		verifier: "private-verifier",
		expiresAt: 100,
		metadata: {
			issuer: binding.issuer,
			authorization_endpoint: "https://example.test/auth",
			token_endpoint: "https://example.test/token",
			code_challenge_methods_supported: ["S256"],
			response_types_supported: ["code"],
		},
	}
	const authorization = {
		flowId: "flow",
		status: "Exchanging",
		issuer: binding.issuer,
		resource: binding.resource,
		scopes: ["read"],
		expiresAt: 100,
		authorizationUrl: "https://example.test/auth?state=flow",
	}
	const test = {
		id: "test",
		cardUrl: source.cardUrl,
		candidate: {
			cardUrl: source.cardUrl,
			card: {
				$schema:
					"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
				name: "test/app",
				version: "1",
				description: "Saved App",
				remotes: [
					{
						type: "streamable-http",
						url: "https://example.test/mcp",
						supportedProtocolVersions: ["2026-07-28"],
					},
				],
			},
			endpoints: [],
			sources: [],
		},
		remoteIndex: 0,
		endpoint: binding.resource,
		configurationKeys: [],
		issuers: [binding.issuer],
		requestedScopes: ["read"],
		createdAt: 1,
		expiresAt: 100,
		status: "AwaitingAuthorization",
		checkedAt: 2,
		stages: [],
		cleanup: "Pending",
		cleanupRemote: "Pending",
		cleanupLocal: "Pending",
		authorization,
		reason: null,
	}
	const privateState = {
		connection: {
			owner,
			connectionId: "test",
			cardUrl: source.cardUrl,
			endpoint: binding.resource,
			remoteIndex: 0,
			configuration: { key: "private-config" },
			headers: {},
			state: "Enabled",
			authorization: {
				_tag: "Authorized",
				binding,
				credentialRef: "credential",
				scopes: ["read"],
			},
		},
		credentials: [{ reference: "credential", credential }],
	}
	const privateBody = yield* saved.seal(privateState, [
		"developer-test",
		owner,
		"test",
	])
	yield* sql`insert into openbot_developer_tests ${sql.insert({ namespace: "public", id: "test", owner, card_url: source.cardUrl, status: test.status, cleanup: test.cleanup, expires_at: 100, value: yield* encode(test), private_state: privateBody })}`
	const flowBody = yield* secrets.seal(
		yield* encode(flow),
		(yield* encode(["developer-test", owner, "test"])) + ":flow:flow",
	)
	const callback = yield* secrets.seal(
		"https://host.test/callback?state=flow&code=private-code",
		yield* encode(["developer-callback", owner, "test", "flow"]),
	)
	yield* sql`insert into openbot_developer_test_flows ${sql.insert({ namespace: "public", flow_id: "flow", test_id: "test", owner, status: authorization.status, expires_at: 100, value: yield* encode(authorization), body: flowBody, callback, consumed: true })}`
	const appFlow = {
		...flow,
		flowId: "app-flow",
		binding: { ...binding, connectionId: "connection" },
	}
	const appBody = yield* saved.seal(appFlow, ["flow", owner, "app-flow"])
	yield* sql`insert into openbot_app_secrets ${sql.insert({ owner, kind: "flow", id: "app-flow", connection_id: "connection", body: appBody, consumed: true })}`
	yield* sql`insert into openbot_app_authorizations ${sql.insert({ id: "app-flow", owner, connection_id: "connection", revision: 1, expires_at: 100, return_to: "/", status: "Processing", callback: null, reason: null, issuer: binding.issuer, resource: binding.resource, scopes: '["read"]' })}`
})

export const resources = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets.Secrets
	const policy = yield* Schema.encodeEffect(Authorization.PolicySchema)(
		Authorization.emptyPolicy,
	)
	yield* sql`insert into openbot_organizations ${sql.insert({ id: "org", name: "Saved organization", status: "active", created_at: 1 })}`
	yield* sql`insert into openbot_auth_user ${sql.insert({ id: "person", name: "Person", email: "person@example.test", email_verified: true })}`
	yield* sql`insert into openbot_members ${sql.insert({ organization_id: "org", user_id: "person", name: "Person", email: "person@example.test", status: "active", roles: '["super_administrator"]', policy, joined_at: 1 })}`
	yield* sql`insert into openbot_auth_account ${sql.insert({ id: "account", account_id: "person", provider_id: "credential", user_id: "person", password: "private password hash", updated_at: "2026-01-01" })}`
	yield* sql`insert into openbot_auth_session ${sql.insert({ id: "session", user_id: "person", token: "private session token", expires_at: "2030-01-01", updated_at: "2026-01-01" })}`
	yield* sql`insert into openbot_tokens ${sql.insert({ id: "token", organization_id: "org", user_id: "person", name: "Saved token", prefix: "obut_saved", hash: "saved-token-hash", policy, created_at: 1 })}`
	yield* sql`insert into openbot_roles ${sql.insert({ organization_id: "org", id: "role_00000000000000000000000000000000", name: "Saved role", description: "Saved role", policy, created_at: 1, updated_at: 2 })}`
	const bot = {
		id: "bot",
		owner: { _tag: "Member", userId: "person" },
		name: "Saved Bot",
		role: "Help the person",
		instructions: "Keep saved work.",
		archived: false,
		revision: 1,
		createdAt: 1,
		updatedAt: 2,
	}
	yield* sql`insert into openbot_bot_records ${sql.insert({ kind: "bot", organization_id: "org", id: "bot", owner: "person", scope: "", status: "active", body: yield* encode(bot) })}`
	for (const [kind, id, body] of [
		[
			"confession",
			"confession",
			{
				id: "confession",
				chat: "chat",
				turn: "turn",
				text: "private note",
				reply: "private answer",
				at: 1,
			},
		],
		[
			"memory_enrichment",
			"enrichment",
			{
				chat: "chat",
				turn: "turn",
				text: "private context",
				entries: ["memory"],
				at: 1,
			},
		],
		[
			"memory_log",
			"memory-log",
			{
				bot: "bot",
				entry: { version: 1, at: 1, by: "person", ids: ["memory"] },
			},
		],
	] as const)
		yield* sql`insert into openbot_bot_records ${sql.insert({ kind, organization_id: "org", id, owner: "person", scope: "chat", status: "done", body: yield* encode(body) })}`
	yield* sql`insert into openbot_bot_memories ${sql.insert({ organization_id: "org", home_bot: "bot", id: "memory", layer: "semantic", content: "private memory", sources: '[{"chat":"chat","item":"item"}]', confidence: 1, status: "active", created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_bot_memory_tags ${sql.insert({ organization_id: "org", home_bot: "bot", memory_id: "memory", tag: "saved" })}`
	yield* sql`insert into openbot_sso_connections ${sql.insert({ id: "sso", organization_id: "org", name: "Saved SSO", issuer: "https://login.example.test", client_id: "client", client_secret: yield* secrets.seal("private SSO key", "openbot_sso_connections:sso:client_secret"), domains: '["example.test"]', enforce: false, version: 1, created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_model_providers ${sql.insert({ id: "provider", owner_kind: "organization", owner_id: "org", kind: "openai", name: "Saved provider", api_key: yield* secrets.seal("private model key", "openbot_model_providers:provider:api_key"), version: 1, created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_models ${sql.insert({ owner_kind: "organization", owner_id: "org", id: "saved-model", name: "Saved model", type: "language", reasoning_efforts: "[]", service_tiers: "[]", version: 1, created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_usage_events ${sql.insert({ id: "usage", organization_id: "org", occurred_at: 2, source: "chat", chat_id: "chat", turn_id: "old-turn", bot_id: "bot", user_id: "person", token_id: "token", provider_id: "provider", provider_owner: "organization", model_id: "saved-model", input_uncached: 10, input_cache_read: 2, input_cache_write: 0, output_text: 7, output_reasoning: 1, cost_micros: 42, charged: true })}`
	for (const [id, status] of [
		["file", "ready"],
		["removed-file", "deleting"],
	] as const) {
		yield* sql`insert into openbot_files ${sql.insert({ id, organization_id: "org", user_id: "person", filename: "note.txt", media_type: "text/plain", bytes: 7, status, object_key: "objects/" + id, created_at: 1, updated_at: 2 })}`
		yield* sql`insert into openbot_file_refs ${sql.insert({ file: id, namespace, chat: "chat" })}`
	}
	yield* sql`insert into openbot_secret_providers ${sql.insert({ organization_id: "org", id: "secret-provider", owner_user_id: "person", kind: "hashicorp", name: "Saved secrets", credentials: yield* secrets.seal(yield* encode({ kind: "hashicorp", url: "https://vault.example.test", token: "private Vault key" }), "openbot_secret_providers:secret-provider:credentials"), hints: "{}", version: 1, created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_vaults ${sql.insert({ organization_id: "org", id: "vault", owner_user_id: "person", name: "Saved Vault", version: 1, created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_vault_items ${sql.insert({ organization_id: "org", id: "vault-item", vault_id: "vault", name: "Saved key", description: "Saved key", source: '{"_tag":"Builtin"}', fields: '["key"]', exits: "[]", values: yield* secrets.seal('{"key":"private Vault value"}', "openbot_vault_items:vault-item:values"), version: 1, created_at: 1, updated_at: 2 })}`
	yield* sql`insert into openbot_computer_providers ${sql.insert({ organization_id: "org", id: "computer-provider", owner_user_id: "person", kind: "e2b", name: "Saved Computer", credentials: yield* secrets.seal('{"kind":"e2b","apiKey":"private Computer key"}', "openbot_computer_providers:computer-provider:credentials"), hints: "{}", version: 1, created_at: 1, updated_at: 2 })}`
})

export const connections = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets.Secrets
	const card = {
		$schema:
			"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
		name: "test/app",
		version: "1",
		description: "Saved App",
		remotes: [
			{
				type: "streamable-http",
				url: "https://example.test/mcp",
				supportedProtocolVersions: ["2026-07-28"],
			},
		],
	}
	const binding = {
		owner,
		connectionId: "connection",
		resource: "https://example.test/mcp",
		issuer: "https://example.test",
	}
	const connection = {
		owner,
		connectionId: "connection",
		cardUrl: source.cardUrl,
		endpoint: binding.resource,
		remoteIndex: 0,
		configuration: { key: "private App key" },
		headers: {},
		state: "Enabled",
		authorization: {
			_tag: "Authorized",
			binding,
			credentialRef: "credential",
			scopes: ["read"],
		},
	}
	yield* sql`insert into openbot_app_connections ${sql.insert({ owner, id: "connection", name: "Saved App", revision: 1, body: yield* secrets.seal(yield* encode({ connection, name: "Saved App", revision: 1, verification: null }), yield* encode(["connection", owner, "connection"])) })}`
	yield* sql`insert into openbot_app_records ${sql.insert({ owner, card_url: source.cardUrl, body: yield* encode({ cardUrl: source.cardUrl, card, sources: [{ role: "card", url: source.cardUrl }] }) })}`
	yield* sql`insert into openbot_app_secrets ${sql.insert({ owner, kind: "credential", id: "credential", connection_id: "connection", body: yield* secrets.seal(yield* encode({ binding, accessToken: "private App access", refreshToken: "private App refresh", scopes: ["read"] }), yield* encode(["credential", owner, "credential"])) })}`
	yield* sql`insert into openbot_app_index_entries ${sql.insert({ namespace: "public", card_url: source.cardUrl, body: yield* encode({ cardUrl: source.cardUrl, card, evidence: [{ publisherUrl: "https://example.test", catalogUrl: "https://example.test/catalog", cardUrl: source.cardUrl, association: "CardOrigin" }], checkedAt: 1, validators: { etag: "saved" } }) })}`
	const check = { _tag: "Indexed", attemptedAt: 1 }
	const scope = { _tag: "AppCard", cardUrl: source.cardUrl }
	const candidate = {
		cardUrl: source.cardUrl,
		card,
		endpoints: [],
		sources: [{ role: "card", url: source.cardUrl }],
	}
	yield* sql`insert into openbot_developer_claims ${sql.insert({ namespace: "public", id: "proof", owner, scope_key: "card:" + source.cardUrl, scope: yield* encode(scope), token: "saved-proof-token", status: "Confirmed", created_at: 1, expires_at: 9999999999999 })}`
	yield* sql`insert into openbot_developer_proofs ${sql.insert({ namespace: "public", id: "proof", owner, scope_key: "card:" + source.cardUrl, scope: yield* encode(scope), token: "saved-proof-token", transition: 2, status: "Confirmed", confirmed_at: 2, valid_until: 9999999999999, next_verification_at: 100, reason: null })}`
	yield* sql`insert into openbot_developer_members ${sql.insert({ namespace: "public", id: "developer-member", proof_id: "proof", owner, role: "maintainer" })}`
	yield* sql`insert into openbot_developer_invitations ${sql.insert({ namespace: "public", id: "developer-invitation", proof_id: "proof", owner, role: "viewer", expires_at: 9999999999999, status: "Pending" })}`
	yield* sql`insert into openbot_developer_apps ${sql.insert({ namespace: "public", card_url: source.cardUrl, candidate: yield* encode(candidate), next_check_at: 200, lease_until: 9999999999999, monitor_token: "old-monitor", monitor_revision: 3, monitor_issues: "[]" })}`
	yield* sql`insert into openbot_developer_reports ${sql.insert({ namespace: "public", id: "report", owner, card_url: source.cardUrl, checked_at: 3, report: yield* encode({ input: source.cardUrl, checkedAt: 3, apps: [], stages: [], issues: [] }) })}`
	yield* sql`insert into openbot_developer_subscriptions ${sql.insert({ namespace: "public", owner, card_url: source.cardUrl, enabled: true })}`
	yield* sql`insert into openbot_developer_notices ${sql.insert({ namespace: "public", id: "notice", owner, card_url: source.cardUrl, kind: "AccessChanged", reason: "Saved proof", report_id: "report", created_at: 3 })}`
	for (const [id, generation] of [
		["old-index-request", "old-check"],
		["pending-index-request", "new-check"],
	] as const)
		yield* sql`insert into openbot_developer_index_requests ${sql.insert({ namespace: "public", id, owner, card_url: source.cardUrl, generation, accepted_at: id === "old-index-request" ? 1 : 2 })}`
	yield* sql`insert into openbot_app_index_jobs ${sql.insert({ namespace: "public", card_url: source.cardUrl, next_check_at: 0, lease_until: 9999999999999, claim: "old-worker", check: yield* encode(check), generation: "new-check", completed_generation: "old-check", sources: yield* encode([{ role: "card", url: source.cardUrl }]), requested_at: 2, started_at: 3 })}`
	yield* sql`insert into openbot_app_index_results ${sql.insert({ namespace: "public", card_url: source.cardUrl, generation: "old-check", check: yield* encode(check), finished_at: 1 })}`
	const prompt = yield* Schema.encodeEffect(Item.Entry.fields.content)(
		Prompt.empty,
	)
	yield* sql`insert into openbot_chats ${sql.insert({ namespace, id: "live", body: yield* encode({ id: "live", revision: 0, settings: { mode: "build" }, inbox: [], seq: 0, business: { [Legacy.hostKey]: { ...host, kind: "live" } }, createdAt: 1 }), state: yield* encode({ conversation: { context: { _tag: "Prompt", prompt }, closed: true } }), bot: "bot", kind: "live", status: "Idle", revision: 0, inbox_size: 0, created_at: 1, updated_at: 2 })}`
})
