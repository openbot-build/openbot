import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Templates from "../src/mail/Templates.ts"

const invitation: Templates.InvitationProps = {
	organizationName: "North Team",
	email: "person@example.com",
	url: "https://openbot.example.com/",
	expiresAt: "5 November 2026 at 09:00 UTC",
}

it.effect("an invitation gives the same steps in HTML and plain text", () =>
	Effect.gen(function* () {
		const message = yield* Templates.renderInvitation(invitation)
		assert.strictEqual(
			message.subject,
			"You are invited to North Team on OpenBot",
		)
		assert.include(message.html, "North Team")
		assert.include(message.html, "person@example.com")
		assert.include(message.html, invitation.expiresAt)
		assert.include(message.text, "North Team")
		assert.include(message.text, "person@example.com")
		assert.include(message.text, invitation.expiresAt)
		assert.include(message.text, invitation.url)
		assert.include(message.text, "Open OpenBot")
		assert.include(message.text, "review your invitation")
		assert.notInclude(message.text, "<table")
	}),
)

it.effect("a Bot invitation names the Bot and its organization", () =>
	Effect.gen(function* () {
		const message = yield* Templates.renderInvitation({
			...invitation,
			botName: "Helper",
		})
		assert.strictEqual(message.subject, "You are invited to Helper on OpenBot")
		assert.include(message.text, "use Helper in North Team")
		assert.include(message.html, "<strong>Helper</strong>")
	}),
)

it.effect("names cannot add HTML or new email headers", () =>
	Effect.gen(function* () {
		const message = yield* Templates.renderInvitation({
			...invitation,
			organizationName:
				'<script>alert("name")</script>\r\nBcc: hidden@example.com',
		})
		assert.notInclude(message.subject, "\r")
		assert.notInclude(message.subject, "\n")
		assert.notInclude(message.html, "<script>")
		assert.include(message.html, "&lt;script&gt;")
		assert.include(message.text, '<script>alert("name")</script>')
	}),
)

it.effect("test email uses the shared style and gives a plain text link", () =>
	Effect.gen(function* () {
		const message = yield* Templates.renderTest({ url: invitation.url })
		assert.strictEqual(message.subject, "Your OpenBot test email")
		assert.include(message.text, "A platform admin sent it")
		assert.include(message.text, invitation.url)
		assert.include(message.html, "DM Sans")
		assert.include(message.html, "DM Mono")
		assert.include(message.html, "border-radius:55px")
		assert.include(message.html, "border-radius:9999px")
		assert.notMatch(message.html, /box-shadow|display:(?:flex|grid)/)
	}),
)
