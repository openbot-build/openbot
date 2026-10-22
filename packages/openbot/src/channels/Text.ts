// These are plain text and crypto helpers. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import { createHash, createHmac, timingSafeEqual } from "node:crypto"

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
 * when it can, so words stay whole.
 */
export const chunk = (text: string, max: number): ReadonlyArray<string> => {
	if (text.length <= max) return [text]
	const parts: Array<string> = []
	let rest = text
	while (rest.length > max) {
		const window = rest.slice(0, max)
		const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "))
		const end = cut > max / 2 ? cut : max
		parts.push(rest.slice(0, end))
		rest = rest.slice(end).replace(/^[\n ]/, "")
	}
	if (rest.length > 0) parts.push(rest)
	return parts
}

const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** Splits Markdown into code blocks and other text, so code stays as it is. */
const segments = (markdown: string) =>
	markdown
		.split(/(```[\s\S]*?```)/g)
		.map((part) =>
			part.startsWith("```") && part.endsWith("```") && part.length >= 6
				? { code: true, text: part.slice(3, -3).replace(/^[^\n]*\n/, "") }
				: { code: false, text: part },
		)

/** Turns Markdown into the HTML subset that Telegram takes. */
export const telegramHtml = (markdown: string) =>
	segments(markdown)
		.map(({ code, text }) =>
			code
				? `<pre>${escapeHtml(text)}</pre>`
				: escapeHtml(text)
						.replace(/`([^`\n]+)`/g, "<code>$1</code>")
						.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
						.replace(/^#{1,6} +(.+)$/gm, "<b>$1</b>")
						.replace(
							/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
							(_, label: string, url: string) =>
								`<a href="${url.replaceAll('"', "&quot;")}">${label}</a>`,
						),
		)
		.join("")

/** Turns Markdown into Slack mrkdwn. */
export const slackMrkdwn = (markdown: string) =>
	segments(markdown)
		.map(({ code, text }) =>
			code
				? "```" + escapeHtml(text) + "```"
				: escapeHtml(text)
						.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
						.replace(/^#{1,6} +(.+)$/gm, "*$1*")
						.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>"),
		)
		.join("")
