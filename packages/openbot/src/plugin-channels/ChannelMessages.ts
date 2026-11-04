import { Requests as RequestDomain } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	Schema,
	SchemaTransformation,
	String as Str,
} from "effect"
import type { OutboundMessage } from "./Channel.ts"
/** The text of a finished answer, or a short note when there is none. */
export const answerOf = (response: {
	readonly status: string
	readonly output: ReadonlyArray<{
		readonly content: ReadonlyArray<{ readonly text: string }>
	}>
	readonly error: { readonly message: string } | null
}) => {
	const text = pipe(
		response.output,
		Arr.flatMap((message) => Arr.map(message.content, (part) => part.text)),
		Arr.join("\n\n"),
		Str.trim,
	)
	if (response.status === "failed")
		return (
			(text.length > 0 ? text + "\n\n" : "") +
			`The Bot could not finish: ${response.error?.message ?? "unknown error"}`
		)
	if (response.status === "cancelled")
		return (text.length > 0 ? text + "\n\n" : "") + "The Bot stopped."
	return text.length > 0 ? text : "The Bot did not write an answer."
}

export const decisions = {
	once: { decision: "allow", scope: "once" },
	chat: { decision: "allow", scope: "chat" },
	deny: { decision: "deny" },
} as const
const Choice = Schema.Literals(["once", "chat", "deny"])
type Choice = typeof Choice.Type

/** The value of an approval button: the request, the choice and the revision it saw. */
const Button = Schema.TemplateLiteralParser([
	RequestDomain.CapabilityRequestId,
	" ",
	Choice,
	" ",
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
]).pipe(
	Schema.decodeTo(
		Schema.toType(
			Schema.Struct({
				request: RequestDomain.CapabilityRequestId,
				choice: Choice,
				revision: Schema.Int,
			}),
		),
		SchemaTransformation.transform({
			decode: ([request, , choice, , revision]) => ({
				request,
				choice,
				revision,
			}),
			encode: ({ request, choice, revision }) =>
				[request, " ", choice, " ", revision] as const,
		}),
	),
)

const buttonValue = (
	request: RequestDomain.CapabilityRequestId,
	choice: Choice,
	revision: number,
) =>
	Schema.encodeEffect(Button)({ request, choice, revision }).pipe(
		// A stored request always has an ID and a revision of 0 or more, so a failure here is a defect.
		Effect.orDie,
	)

export const readButton = Schema.decodeUnknownOption(Button)

const describe = (request: RequestDomain.CapabilityRequest) => {
	const { action, target } = request.capability
	switch (action) {
		case "plans.run":
			return "carry out its plan"
		case "tools.call":
			return `use the tool \`${target}\``
		case "apps.call":
			return `call the App \`${target}\``
		case "channels.send":
			return "post to another chat of this Channel"
		case "delegations.continue":
			return `go on with its work \`${target}\` after it reached a limit`
		default:
			return `do \`${action}\` on \`${target}\``
	}
}

const outcome = (request: RequestDomain.CapabilityRequest) => {
	switch (request.status) {
		case "pending":
			return "Waiting for a decision."
		case "allowed":
			return request.decision?.scope === "chat"
				? "Allowed in this chat."
				: request.decision?.scope === "lifetime"
					? "Allowed."
					: "Allowed once."
		case "denied":
			return "Denied."
		case "expired":
			return "Nobody decided in time, so it is denied."
		case "cancelled":
			return "The request ended."
	}
}

/** The card of a request. It has buttons only while the request waits. */
export const requestCard = (
	request: RequestDomain.CapabilityRequest,
	botName: string,
	approverName: Option.Option<string>,
): Effect.Effect<OutboundMessage> =>
	Effect.gen(function* () {
		const markdown = pipe(
			[
				`**${botName}** wants to ${describe(request)}.`,
				request.reason.length > 0 ? `Reason: ${request.reason}` : "",
				Option.match(approverName, {
					onNone: () => "",
					onSome: (name) => `This needs a decision from ${name}.`,
				}),
				outcome(request),
			],
			Arr.filter((line) => line.length > 0),
			Arr.join("\n\n"),
		)
		if (request.status !== "pending") return { markdown }
		const value = (choice: Choice) =>
			buttonValue(request.id, choice, request.revision)
		return {
			markdown,
			buttons: [
				{
					label: "Allow once",
					value: yield* value("once"),
					style: "primary" as const,
				},
				{ label: "Allow in this chat", value: yield* value("chat") },
				{
					label: "Deny",
					value: yield* value("deny"),
					style: "danger" as const,
				},
			],
		}
	})
