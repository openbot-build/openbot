import { Schema } from "effect"

/** Private stored forms at 2a123ff. These never follow the HTTP contract. */
const id = Schema.NonEmptyString
const time = Schema.Finite
const maybeText = Schema.NullOr(Schema.String)
const maybeTime = Schema.NullOr(time)
const Conversation = Schema.Struct({
	key: Schema.String,
	kind: Schema.Literals(["direct", "group"]),
	title: Schema.optionalKey(Schema.String),
})
const Sender = Schema.Struct({
	externalId: Schema.String,
	displayName: Schema.String,
})
export const Event = Schema.TaggedUnion({
	Message: {
		eventId: Schema.String,
		conversation: Conversation,
		sender: Sender,
		text: Schema.String,
		mentioned: Schema.Boolean,
	},
	Action: {
		eventId: Schema.String,
		conversation: Conversation,
		sender: Sender,
		value: Schema.String,
		receipt: Schema.optionalKey(Schema.String),
	},
})
export const Target = Schema.TaggedUnion({
	Conversation: { conversation: Schema.String },
	Private: { conversation: Schema.String, person: Schema.String },
	Person: { person: Schema.String },
})
export const Message = Schema.Struct({
	markdown: Schema.String,
	buttons: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				label: Schema.String,
				value: Schema.String,
				style: Schema.optionalKey(Schema.Literals(["primary", "danger"])),
			}),
		),
	),
})
export const MessageRef = Schema.Struct({
	conversation: Schema.String,
	id: Schema.String,
})
export const Credentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("slack"),
		botToken: Schema.String,
		signingSecret: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("lark"),
		domain: Schema.Literals(["lark", "feishu"]),
		appId: Schema.String,
		appSecret: Schema.String,
		verificationToken: Schema.String,
		encryptKey: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("telegram"),
		botToken: Schema.String,
		webhookSecret: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("custom"),
		endpoint: Schema.String,
		secret: maybeText,
	}),
])
export const Hints = Schema.Struct({
	hints: Schema.Record(Schema.String, maybeText),
	plain: Schema.Record(Schema.String, Schema.String),
})
export const Channel = Schema.Struct({
	organization_id: id,
	id,
	kind: Schema.Literals(["slack", "lark", "telegram", "custom"]),
	name: Schema.String,
	bot: id,
	actor: Schema.String,
	enabled: Schema.Boolean,
	link_path: maybeText,
	credentials: Schema.String,
	hints: Schema.String,
	version: Schema.Natural,
	created_at: time,
	updated_at: time,
	execution_id: Schema.NullOr(id),
})
export const Inbox = Schema.Struct({
	organization_id: id,
	channel_id: id,
	event_id: Schema.String,
	conversation_key: Schema.String,
	event: Schema.String,
	received_at: time,
	attempts: Schema.Natural,
	next_at: time,
	claim: maybeText,
	lease_until: time,
	done_at: maybeTime,
	execution_id: Schema.NullOr(id),
	position: Schema.Natural,
})
export const Delivery = Schema.Struct({
	id,
	organization_id: id,
	channel_id: id,
	kind: Schema.Literals(["reply", "request", "notice"]),
	target: Schema.String,
	chat: maybeText,
	turn: maybeText,
	request: maybeText,
	body: Schema.String,
	ref: maybeText,
	state: Schema.Literals(["live", "pending", "done", "failed"]),
	attempts: Schema.Natural,
	next_at: time,
	claim: maybeText,
	lease_until: time,
	updated_at: time,
	execution_id: Schema.NullOr(id),
})
export const Trigger = Schema.Struct({
	organization_id: id,
	id,
	owner_user_id: maybeText,
	bot: id,
	prompt: Schema.String,
	schedule_cron: maybeText,
	schedule_time_zone: maybeText,
	next_run_at: maybeTime,
	last_fired_at: maybeTime,
	hook_secret_hash: maybeText,
	actor: Schema.String,
	enabled: Schema.Boolean,
	revision: Schema.Natural,
	created_at: time,
	updated_at: time,
	schedule_execution_id: Schema.NullOr(id),
})
export const ReminderRow = Schema.Struct({
	kind: Schema.Literal("reminder"),
	organization_id: id,
	id,
	owner: Schema.String,
	scope: Schema.String,
	status: Schema.Literals(["waiting", "done", "cancelled"]),
	body: Schema.String,
})
export const SealedReminder = Schema.Struct({ id, sealed: Schema.String })
export const Computer = Schema.Struct({
	organization_id: id,
	id,
	owner_user_id: maybeText,
	name: Schema.String,
	source: Schema.Literals(["provider", "connector"]),
	provider_id: maybeText,
	template: maybeText,
	ref: maybeText,
	machine_id: maybeText,
	token_hash: maybeText,
	state: Schema.Literals([
		"starting",
		"running",
		"paused",
		"offline",
		"failed",
	]),
	features: Schema.String,
	pause_after: Schema.NullOr(Schema.Natural),
	created_by: Schema.String,
	version: Schema.Natural,
	created_at: time,
	updated_at: time,
	last_active_at: maybeTime,
})
export const ComputerFeatures = Schema.Struct({
	pause: Schema.Boolean,
	desktop: Schema.Boolean,
	ports: Schema.Boolean,
})
const Point = Schema.Natural
const Path = Schema.NonEmptyString
const Encoding = Schema.Literals(["utf8", "base64"])
const DesktopAction = Schema.TaggedUnion({
	Click: {
		x: Point,
		y: Point,
		button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
		double: Schema.optionalKey(Schema.Boolean),
	},
	Move: { x: Point, y: Point },
	Drag: { fromX: Point, fromY: Point, toX: Point, toY: Point },
	Scroll: { x: Point, y: Point, deltaX: Schema.Int, deltaY: Schema.Int },
	Type: { text: Schema.String },
	Key: { keys: Schema.Array(Schema.String) },
})
export const ComputerCall = Schema.Struct({
	id: Schema.String,
	operation: Schema.TaggedUnion({
		Read: { path: Path, encoding: Encoding },
		Write: {
			file: Schema.Struct({
				path: Path,
				encoding: Encoding,
				content: Schema.String,
			}),
		},
		List: { path: Path },
		Remove: { path: Path },
		Screenshot: {},
		Desktop: { actions: Schema.Array(DesktopAction) },
	}),
})
export const ComputerReply = Schema.Struct({
	id: Schema.String,
	result: Schema.TaggedUnion({
		Done: { value: Schema.Json },
		Failed: {
			message: Schema.String,
			reason: Schema.Literals(["NotFound", "Failed"]),
		},
	}),
})
export const ComputerCallRow = Schema.Struct({
	id,
	computer_id: id,
	call: Schema.String,
	reply: maybeText,
	created_at: time,
})
