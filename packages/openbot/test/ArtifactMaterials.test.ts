import { String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { documentText, normalizeText } from "../src/artifacts/Materials.ts"

describe("source text", () => {
	it("keeps page text and its title without script or style content", () => {
		const result = documentText(
			"<html><head><title>A &amp; B</title><style>hidden style</style></head><body><h1>Work</h1><p>Read &amp; keep <strong>this</strong>.</p><script>hidden script</script><template>hidden template</template></body></html>",
			"text/html",
		)
		expect(result).toEqual({
			title: "A & B",
			text: "Work\n\nRead & keep this.",
		})
	})

	it("keeps a line between separate blocks", () => {
		expect(
			documentText("<p>First</p><p>Second<br>Third</p>", "text/html").text,
		).toBe("First\n\nSecond\nThird")
	})

	it("uses the same space rules for a source and a quote", () => {
		const source = documentText(
			"A\r\n\t useful\u00a0source.\r\n\r\n\r\nEnd.",
			"text/plain",
		)
		expect(source.text).toBe("A\nuseful source.\n\nEnd.")
		expect(
			Str.includes(normalizeText(" useful\u00a0source. "))(source.text),
		).toBe(true)
	})

	it("does not read Markdown or JSON as HTML", () => {
		expect(documentText("# Note\n\nKeep <value>.", "text/markdown").text).toBe(
			"# Note\n\nKeep <value>.",
		)
		expect(documentText('{"text":"<value>"}', "application/json").text).toBe(
			'{"text":"<value>"}',
		)
	})
})
