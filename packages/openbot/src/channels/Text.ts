// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no API for HMAC or for timingSafeEqual.
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { Array as Arr, Option, Order, pipe, String as Str } from "effect"

/** Compares two secrets in constant time. Values of different lengths are never equal. */
export const sameSecret = (left: string, right: string) => {
	const a = createHash("sha256").update(left).digest()
	const b = createHash("sha256").update(right).digest()
	return timingSafeEqual(a, b) && left.length === right.length
}

export const hmacHex = (secret: string, data: string) =>
	createHmac("sha256", secret).update(data).digest("hex")

/** A request older or newer than this is a replay or has a wrong clock. */
export const maxClockSkewMs = 5 * 60 * 1000

/** Reads a time in seconds, as platforms send it, and checks that it is recent. */
export const recentSeconds = (value: string | undefined, now: number) => {
	if (value === undefined || !/^\d{1,12}$/.test(value)) return false
	return Math.abs(now - Number(value) * 1000) <= maxClockSkewMs
}

/**
 * Splits a long text into parts that a platform takes. It cuts at a line break or a space
 * when it can, so words stay whole. There is always at least one part.
 */
export const chunk = (
	text: string,
	max: number,
): Arr.NonEmptyReadonlyArray<string> =>
	text.length <= max
		? Arr.of(text)
		: pipe(
				Arr.unfold(text, (rest) => {
					if (rest.length === 0) return Option.none()
					if (rest.length <= max) return Option.some([rest, ""] as const)
					const window = Str.slice(0, max)(rest)
					const end = pipe(
						Arr.getSomes([
							Str.lastIndexOf("\n")(window),
							Str.lastIndexOf(" ")(window),
						]),
						Arr.filter((cut) => cut > max / 2),
						Arr.match({
							onEmpty: () => max,
							onNonEmpty: Arr.max(Order.Number),
						}),
					)
					return Option.some([
						Str.slice(0, end)(rest),
						pipe(rest, Str.slice(end), Str.replace(/^[\n ]/, "")),
					] as const)
				}),
				// A text longer than `max` always gives a part, so the empty case does not come.
				Arr.match({
					onEmpty: () => Arr.of(text),
					onNonEmpty: (parts) => parts,
				}),
			)

const escapeHtml = (text: string) =>
	pipe(
		text,
		Str.replaceAll("&", "&amp;"),
		Str.replaceAll("<", "&lt;"),
		Str.replaceAll(">", "&gt;"),
	)

/** Splits Markdown into code blocks and other text, so code stays as it is. */
const segments = (markdown: string) =>
	pipe(
		markdown,
		Str.split(/(```[\s\S]*?```)/g),
		Arr.map((part) =>
			Str.startsWith("```")(part) &&
			Str.endsWith("```")(part) &&
			part.length >= 6
				? {
						code: true,
						text: pipe(part, Str.slice(3, -3), Str.replace(/^[^\n]*\n/, "")),
					}
				: { code: false, text: part },
		),
	)

/** Turns Markdown into the HTML subset that Telegram takes. */
export const telegramHtml = (markdown: string) =>
	pipe(
		segments(markdown),
		Arr.map(({ code, text }) =>
			code
				? `<pre>${escapeHtml(text)}</pre>`
				: pipe(
						escapeHtml(text),
						Str.replace(/`([^`\n]+)`/g, "<code>$1</code>"),
						Str.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>"),
						Str.replace(/^#{1,6} +(.+)$/gm, "<b>$1</b>"),
						(html) =>
							// @effect-diagnostics-next-line preferEffectString:off -- Effect String has no replace that takes a function, and each link needs its own escaped address.
							html.replace(
								/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
								(_, label: string, url: string) =>
									`<a href="${Str.replaceAll('"', "&quot;")(url)}">${label}</a>`,
							),
					),
		),
		Arr.join(""),
	)

/** Turns Markdown into Slack mrkdwn. */
export const slackMrkdwn = (markdown: string) =>
	pipe(
		segments(markdown),
		Arr.map(({ code, text }) =>
			code
				? "```" + escapeHtml(text) + "```"
				: pipe(
						escapeHtml(text),
						Str.replace(/\*\*([^*\n]+)\*\*/g, "*$1*"),
						Str.replace(/^#{1,6} +(.+)$/gm, "*$1*"),
						Str.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>"),
					),
		),
		Arr.join(""),
	)
