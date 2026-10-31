import { Execution } from "@openbot-build/domain"
import { Array as Arr, HashSet, Option, Result, Schema } from "effect"

/** The saved request used by foreground Chat tools. Ignore every other field. */
const Request = Schema.Struct({
	chat: Schema.NonEmptyString,
	turn: Schema.NonEmptyString,
	item: Schema.NonEmptyString,
	call: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	params: Schema.optionalKey(Schema.Unknown),
})
const decode = Schema.decodeUnknownOption(Request)
const Computer = Schema.Struct({ computer: Schema.NonEmptyString })
const computer = Schema.decodeUnknownOption(Computer)
const computerTools = HashSet.fromIterable([
	"openbot_computers_pause",
	"openbot_computers_resume",
	"openbot_computer_exec",
	"openbot_computer_write_stdin",
	"openbot_computer_read_file",
	"openbot_computer_export_file",
	"openbot_computer_write_file",
	"openbot_computer_list_files",
	"openbot_computer_remove_file",
	"openbot_computer_open_port",
	"openbot_computer_screenshot",
	"openbot_computer_desktop",
])

/** Only the foreground tool step format can publish this metadata. */
export const of = (
	call: Pick<Execution.Call, "step" | "input">,
): Option.Option<Execution.ToolActivity> => {
	const request = decode(call.input)
	if (Option.isNone(request)) return Option.none()
	const value = request.value
	if (call.step !== `tool:${value.item.length}:${value.item}${value.call}`)
		return Option.none()
	const target = HashSet.has(computerTools, value.name)
		? computer(value.params)
		: Option.none()
	return Option.some({
		chatId: value.chat,
		turnId: value.turn,
		itemId: value.item,
		callId: value.call,
		name: value.name,
		...(Option.isNone(target) ? {} : { computerId: target.value.computer }),
	})
}

/** Retries keep the same safe identity without adding fields to private call input. */
export const started = (
	call: Execution.Call,
	scope: {
		readonly resourceKind: string
		readonly resourceId: string
		readonly contextKind: string | null
		readonly contextId: string | null
	},
): Execution.EventBody => {
	const tool = of(call)
	return {
		_tag: "StepStarted",
		step: call.step,
		attempt: call.attempt,
		...(Option.isNone(tool) ||
		scope.resourceKind !== "Turn" ||
		scope.contextKind !== "Chat" ||
		scope.resourceId !== tool.value.turnId ||
		scope.contextId !== tool.value.chatId
			? {}
			: { tool: tool.value }),
	}
}

export const active = (
	record: Execution.Record,
	calls: ReadonlyArray<Execution.Call>,
	chatId: string,
	turnId: string,
): ReadonlyArray<Execution.ActiveTool> => {
	if (
		Execution.isTerminal(record.status) ||
		record.resource.kind !== "Turn" ||
		record.resource.id !== turnId
	)
		return []
	return Arr.filterMap(calls, (call) => {
		if (
			call.executionId !== record.id ||
			call.status === "completed" ||
			Arr.some(
				calls,
				(next) => next.step === call.step && next.attempt > call.attempt,
			)
		)
			return Result.failVoid
		const tool = of(call)
		if (
			Option.isNone(tool) ||
			tool.value.chatId !== chatId ||
			tool.value.turnId !== turnId
		)
			return Result.failVoid
		const status =
			call.status === "outcome_unknown"
				? "outcome_unknown"
				: record.status === "waiting" ||
					  record.status === "cancelling" ||
					  record.status === "outcome_unknown"
					? record.status
					: call.status === "sending" && record.status === "running"
						? "running"
						: "queued"
		return Result.succeed({
			executionId: record.id,
			step: call.step,
			attempt: call.attempt,
			tool: tool.value,
			status,
		})
	})
}
