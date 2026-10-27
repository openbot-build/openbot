import { Schema, String as Str } from "effect"

/** A same-origin path outside the server routes. */
export const ReturnTo = Schema.String.check(
	Schema.isMaxLength(4096),
	Schema.makeFilter(
		(value) => {
			if (
				!Str.startsWith("/")(value) ||
				Str.startsWith("//")(value) ||
				/[\\\r\n]/.test(value)
			)
				return false
			const url = URL.parse(value, "https://return.invalid")
			return (
				url !== null &&
				url.origin === "https://return.invalid" &&
				!/^\/(?:auth|v1|development)(?:\/|$)/.test(url.pathname)
			)
		},
		{
			message:
				"Expected a path on this origin that starts with one /, has no \\ or line break, and is not under /auth, /v1 or /development",
		},
	),
)
