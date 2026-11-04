import { Schema } from "effect"

/** The saved Chat forms at 2a123ff. Keep these apart from new public models. */
const id = Schema.NonEmptyString
const text = Schema.String
const optionalText = Schema.optionalKey(text)
const json = Schema.Json
export const hostKey = "@openbot-build/openbot/chat-host"
const Selection = Schema.TaggedStruct("Config.Selection", {
	provider: text,
	model: text,
	reasoningEffort: optionalText,
	serviceTier: optionalText,
})
const Settings = Schema.Struct({
	mode: Schema.Literals(["build", "plan"]),
	model: Schema.optionalKey(Selection),
})
const Action = Schema.Struct({
	name: id,
	arguments: Schema.JsonObject,
	source: Schema.optionalKey(Schema.JsonObject),
})
const Notice = Schema.Struct({ kind: id, ref: optionalText })
/** Plugin and provider fields remain JSON. The converter also checks the Prompt codec. */
export const Prompt = Schema.Struct({
	content: Schema.Array(Schema.JsonObject),
})
export const Turn = Schema.Struct({
	id,
	chat: id,
	settings: Settings,
	action: Schema.optionalKey(Action),
	author: optionalText,
	activeAction: Schema.optionalKey(Schema.Struct({ item: id, action: Action })),
	status: Schema.TaggedUnion({
		Running: {},
		Completed: {
			result: Schema.Struct({
				text,
				finishReason: Schema.Literals([
					"stop",
					"length",
					"content-filter",
					"tool-calls",
					"error",
					"pause",
					"other",
					"unknown",
				]),
			}),
		},
		Failed: {
			message: text,
			code: Schema.Literals(["model_error", "internal_error"]),
		},
		Interrupted: {},
	}),
	steps: Schema.Natural,
	usage: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				inputTokens: Schema.Struct({
					uncached: Schema.optionalKey(Schema.Int),
					total: Schema.optionalKey(Schema.Int),
					cacheRead: Schema.optionalKey(Schema.Int),
					cacheWrite: Schema.optionalKey(Schema.Int),
				}),
				outputTokens: Schema.Struct({
					total: Schema.optionalKey(Schema.Int),
					text: Schema.optionalKey(Schema.Int),
					reasoning: Schema.optionalKey(Schema.Int),
				}),
			}),
		),
	),
	input: Schema.Array(id),
	items: Schema.Array(id),
	startedAt: Schema.Finite,
	completedAt: Schema.optionalKey(Schema.Finite),
})
export const Inbox = Schema.Struct({
	id,
	content: Prompt,
	kind: Schema.Literals(["message", "steer", "action"]),
	turn: Schema.optionalKey(id),
	action: Schema.optionalKey(Action),
	author: optionalText,
	notice: Schema.optionalKey(Notice),
	approved: Schema.optionalKey(Schema.Struct({ id, name: id, params: json })),
})
export const Chain = Schema.Struct({
	organizationId: text,
	userId: text,
	tokenId: optionalText,
	owner: optionalText,
	bots: Schema.Array(id),
	chats: Schema.Array(id),
})
export const Host = Schema.Struct({
	bot: id,
	kind: Schema.Literals(["direct", "channel", "task", "review", "live"]),
	parent: Schema.optionalKey(Schema.Struct({ chat: id, delegation: id })),
	chain: Chain,
	review: optionalText,
	closed: Schema.optionalKey(Schema.Boolean),
	trigger: optionalText,
	channel: Schema.optionalKey(
		Schema.Struct({
			channel: text,
			conversation: text,
			group: Schema.optionalKey(Schema.Boolean),
		}),
	),
	title: optionalText,
	planApproval: Schema.optionalKey(
		Schema.Struct({
			approver: Schema.Literals(["chain", "person"]),
			timeoutMs: Schema.Finite,
			onTimeout: Schema.Literals(["run", "stay"]),
		}),
	),
})
export const Chat = Schema.Struct({
	id,
	revision: Schema.Natural,
	settings: Settings,
	inbox: Schema.Array(Inbox),
	turn: Schema.optionalKey(Turn),
	seq: Schema.Natural,
	business: Schema.Record(text, json),
	createdAt: Schema.Finite,
})
export const State = Schema.StructWithRest(
	Schema.Struct({
		conversation: Schema.Struct({
			context: Schema.TaggedUnion({
				Prompt: { prompt: Prompt },
				Native: {
					provider: text,
					model: text,
					items: Schema.Array(json),
					prompt: Prompt,
				},
			}),
			closed: Schema.Boolean,
		}),
	}),
	[Schema.Record(text, json)],
)
export const Item = Schema.Struct({
	id,
	seq: Schema.Natural,
	content: Prompt,
	origin: Schema.optionalKey(
		Schema.Struct({
			chat: id,
			turn: id,
			step: Schema.Natural,
			notice: Schema.optionalKey(Notice),
		}),
	),
})
export const Operation = Schema.Struct({
	id,
	chat: id,
	turn: id,
	callId: text,
	tool: text,
	kind: Schema.Literals(["tool", "session"]),
	status: Schema.TaggedUnion({
		Running: {},
		Completed: { result: json },
		Failed: { message: text, result: Schema.optionalKey(json) },
		Cancelled: {},
		Interrupted: {},
	}),
	startedAt: Schema.Finite,
	endedAt: Schema.optionalKey(Schema.Finite),
})
const Usage = Schema.Struct({
	timeMs: Schema.Finite,
	steps: Schema.Int,
	costMicros: Schema.Finite,
})
const Limit = Schema.Literals(["time", "steps", "budget"])
export const Delegation = Schema.Struct({
	delegation: Schema.Struct({
		id,
		parent: Schema.Struct({
			chat: id,
			turn: Schema.optionalKey(id),
			toolCallId: optionalText,
		}),
		trigger: optionalText,
		bot: id,
		chat: Schema.NullOr(id),
		status: Schema.Literals([
			"authorizing",
			"queued",
			"running",
			"paused",
			"completed",
			"failed",
			"cancelled",
		]),
		task: text,
		reason: optionalText,
		result: Schema.NullOr(text),
		limits: Schema.optionalKey(
			Schema.Struct({
				timeMs: Schema.Finite,
				steps: Schema.optionalKey(Schema.Int),
				budgetMicros: Schema.optionalKey(Schema.Int),
			}),
		),
		usage: Schema.optionalKey(Usage),
		pause: Schema.optionalKey(
			Schema.Struct({
				limit: Limit,
				request: Schema.NullOr(id),
				delegation: Schema.optionalKey(id),
				at: Schema.Finite,
			}),
		),
		createdAt: Schema.Finite,
		updatedAt: Schema.Finite,
	}),
	userId: text,
	author: id,
	chain: Chain,
	request: optionalText,
	window: Schema.optionalKey(Usage),
	runningSince: Schema.optionalKey(Schema.Finite),
})
const Scope = Schema.Literals(["once", "chat", "lifetime"])
const Decider = Schema.TaggedUnion({
	Person: { userId: text },
	Bot: { bot: id },
	Rule: { rule: id },
})
const Source = Schema.Struct({
	connectionId: id,
	connectionName: text,
	cardUrl: text,
	appName: text,
	remoteIndex: Schema.Natural,
	revision: Schema.Natural,
	kind: Schema.Literals(["tool", "resource", "template", "prompt"]),
	name: text,
	definition: Schema.optionalKey(json),
})
const Result = Schema.TaggedUnion({
	Completed: { source: Source, result: json, operationId: optionalText },
	InputRequired: { source: Source, request: json, operationId: optionalText },
	Failed: {
		source: Source,
		reason: text,
		cause: optionalText,
		message: text,
		result: Schema.optionalKey(json),
		operationId: optionalText,
	},
})
export const Request = Schema.Struct({
	request: Schema.Struct({
		id,
		bot: id,
		capability: Schema.Struct({
			action: Schema.Literals([
				"tools.call",
				"apps.call",
				"bots.create",
				"bots.delegate",
				"plans.run",
				"channels.send",
				"delegations.continue",
				"computers.acquire",
				"computers.create",
				"computers.delete",
				"computers.expose",
			]),
			target: text,
			arguments: Schema.optionalKey(Schema.JsonObject),
		}),
		reason: text,
		approver: Schema.TaggedUnion({
			Person: { userId: text },
			Bot: { bot: id },
		}),
		chain: Schema.Array(id),
		chat: id,
		turn: id,
		toolCallId: text,
		app: Schema.optionalKey(
			Schema.Struct({
				id,
				chat: id,
				turn: id,
				callId: text,
				toolName: text,
				source: Source,
				arguments: Schema.JsonObject,
				readOnly: Schema.Boolean,
				round: Schema.Natural,
				status: Schema.Literals([
					"PendingApproval",
					"Approved",
					"Rejected",
					"Sending",
					"InputRequired",
					"Completed",
					"Failed",
					"OutcomeUnknown",
				]),
				result: Schema.NullOr(Result),
			}),
		),
		code: Schema.optionalKey(
			Schema.Struct({ run: id, index: Schema.Natural, code: text }),
		),
		endorsements: Schema.Array(
			Schema.Struct({ bot: id, scope: Scope, reason: optionalText }),
		),
		status: Schema.Literals([
			"pending",
			"allowed",
			"denied",
			"expired",
			"cancelled",
		]),
		decision: Schema.NullOr(
			Schema.Struct({
				by: Decider,
				scope: Schema.optionalKey(Scope),
				reason: optionalText,
				question: optionalText,
				at: Schema.Finite,
			}),
		),
		revision: Schema.Natural,
		createdAt: Schema.Finite,
		expiresAt: Schema.Finite,
		onExpire: Schema.optionalKey(Schema.Literals(["allow", "deny"])),
	}),
	chain: Chain,
	call: Schema.optionalKey(
		Schema.Struct({
			name: text,
			params: json,
			source: Schema.optionalKey(Schema.JsonObject),
		}),
	),
})
