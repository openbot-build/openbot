import { assert, it } from "@effect/vitest"
import { chunk, slackMrkdwn, telegramHtml } from "../src/channels/Text.ts"

it("Markdown turns into the format of each platform, and long text splits at words", () => {
	assert.strictEqual(
		slackMrkdwn("**bold** and [site](https://a.example)"),
		"*bold* and <https://a.example|site>",
	)
	assert.strictEqual(slackMrkdwn("a < b"), "a &lt; b")
	assert.strictEqual(
		telegramHtml("# Title\n**bold** `x<y`\n```\nif (a < b) {}\n```"),
		"<b>Title</b>\n<b>bold</b> <code>x&lt;y</code>\n<pre>if (a &lt; b) {}\n</pre>",
	)
	assert.deepStrictEqual(chunk("one two three four", 9), [
		"one two",
		"three",
		"four",
	])
	assert.deepStrictEqual(chunk("short", 10), ["short"])
})
