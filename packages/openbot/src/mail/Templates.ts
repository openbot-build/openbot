import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Html,
	Link,
	Preview,
	Section,
	Text,
} from "react-email"
import { render, toPlainText } from "@react-email/render"
import { Effect, Schema, String as Str } from "effect"
import {
	createElement as h,
	Fragment,
	type CSSProperties,
	type ReactElement,
	type ReactNode,
} from "react"

/** Email clients use inline colors and round corners in place of web CSS. */
const theme = {
	background: "#ffffff",
	card: "#f5f5f5",
	foreground: "#0a0a0a",
	muted: "#737373",
	primary: "#171717",
	font: '"DM Sans", Arial, sans-serif',
	mono: '"DM Mono", "Courier New", monospace',
	corner: 55,
	inset: 37,
} as const

const textStyle: CSSProperties = {
	color: theme.foreground,
	fontFamily: theme.font,
	fontSize: "16px",
	lineHeight: "26px",
	margin: "0 0 20px",
	overflowWrap: "anywhere",
}

/**
 * The same small set of styles is shared by every system email.
 * Plain React calls let Node load the source without a JSX loader.
 */
const Layout = (props: {
	readonly preview: string
	readonly title: string
	readonly url: string
	readonly children?: ReactNode
}) =>
	h(
		Html,
		{ lang: "en" },
		h(
			Head,
			null,
			h("meta", { name: "color-scheme", content: "light" }),
			h("meta", { name: "supported-color-schemes", content: "light" }),
		),
		h(Preview, null, props.preview),
		h(
			Body,
			{
				style: {
					backgroundColor: theme.background,
					color: theme.foreground,
					fontFamily: theme.font,
					margin: "0",
					padding: "0",
				},
			},
			h(
				Container,
				{
					style: {
						maxWidth: "600px",
						width: "100%",
						margin: "0 auto",
						padding: "32px 12px",
					},
				},
				h(
					Text,
					{
						style: {
							...textStyle,
							fontSize: "18px",
							fontWeight: 700,
							margin: `0 ${theme.inset}px 24px`,
						},
					},
					"OpenBot",
				),
				h(
					Section,
					{
						style: {
							backgroundColor: theme.card,
							borderRadius: `${theme.corner}px`,
							padding: `${theme.inset}px`,
						},
					},
					h(
						Heading,
						{
							as: "h1",
							style: {
								fontFamily: theme.font,
								fontSize: "32px",
								lineHeight: "38px",
								fontWeight: 600,
								letterSpacing: "-1px",
								margin: "0 0 24px",
								overflowWrap: "anywhere",
							},
						},
						props.title,
					),
					props.children,
					h(
						Button,
						{
							href: props.url,
							style: {
								backgroundColor: theme.primary,
								color: theme.background,
								borderRadius: "9999px",
								fontFamily: theme.font,
								fontSize: "14px",
								fontWeight: 600,
								lineHeight: "20px",
								padding: "12px 24px",
								textDecoration: "none",
							},
						},
						"Open OpenBot",
					),
				),
				h(
					Section,
					{ style: { padding: `24px ${theme.inset}px 0` } },
					h(
						Text,
						{
							style: {
								...textStyle,
								fontSize: "12px",
								lineHeight: "20px",
								color: theme.muted,
								margin: "0 0 8px",
							},
						},
						"You can also open this address in your browser:",
					),
					h(
						Link,
						{
							href: props.url,
							style: {
								fontFamily: theme.mono,
								fontSize: "12px",
								lineHeight: "20px",
								color: theme.muted,
								textDecoration: "underline",
								wordBreak: "break-all",
							},
						},
						props.url,
					),
				),
			),
		),
	)

export interface InvitationProps {
	readonly organizationName: string
	readonly botName?: string
	readonly email: string
	readonly url: string
	/** A date that names its time zone. */
	readonly expiresAt: string
}

export const Invitation = (props: InvitationProps) =>
	h(
		Layout,
		{
			preview: `You have an invitation from ${props.organizationName}.`,
			title: "You are invited.",
			url: props.url,
		},
		h(
			Text,
			{ style: textStyle },
			props.botName === undefined
				? h(
						Fragment,
						null,
						"You have been invited to join ",
						h("strong", null, props.organizationName),
						" on OpenBot.",
					)
				: h(
						Fragment,
						null,
						"You have been invited to use ",
						h("strong", null, props.botName),
						" in ",
						h("strong", null, props.organizationName),
						" on OpenBot.",
					),
		),
		h(
			Text,
			{ style: textStyle },
			"Sign in with ",
			h("strong", null, props.email),
			" to review your invitation and accept it.",
		),
		h(
			Text,
			{ style: { ...textStyle, color: theme.muted, fontSize: "14px" } },
			"This invitation ends on ",
			props.expiresAt,
			". If you do not wish to join, you can ignore this email.",
		),
	)

export const Test = (props: { readonly url: string }) =>
	h(
		Layout,
		{
			preview: "Your OpenBot test email has arrived.",
			title: "Your test email.",
			url: props.url,
		},
		h(
			Text,
			{ style: textStyle },
			"This is a test email from OpenBot. A platform admin sent it to check the email settings.",
		),
		h(
			Text,
			{ style: { ...textStyle, color: theme.muted } },
			"You do not need to take any action.",
		),
	)

export class RenderError extends Schema.TaggedError<
	RenderError,
	{ readonly brand: unique symbol }
>()("MailRenderError", { cause: Schema.Defect() }) {}

export interface Message {
	readonly subject: string
	readonly html: string
	readonly text: string
}

const renderMessage = Effect.fn("Mail.render")(function* (
	subject: string,
	element: ReactElement,
): Effect.fn.Return<Message, RenderError> {
	const html = yield* Effect.tryPromise({
		try: () => render(element),
		catch: (cause) => RenderError.make({ cause }),
	})
	const text = yield* Effect.try({
		try: () => toPlainText(html),
		catch: (cause) => RenderError.make({ cause }),
	})
	return { subject, html, text }
})

/** Names are text in the body and a single line in the subject. */
export const renderInvitation = (props: InvitationProps) =>
	renderMessage(
		Str.replace(
			/[\u0000-\u001f\u007f]+/g,
			" ",
		)(
			`You are invited to ${props.botName ?? props.organizationName} on OpenBot`,
		),
		h(Invitation, props),
	)

export const renderTest = (props: { readonly url: string }) =>
	renderMessage("Your OpenBot test email", h(Test, props))

/** The code stays out of the subject and the email preview. */
export const renderSignInCode = (props: {
	readonly url: string
	readonly code: string
}) =>
	renderMessage(
		"Your OpenBot sign-in code",
		h(
			Layout,
			{
				title: "Your sign-in code",
				preview: "Use this code to sign in to OpenBot.",
				url: props.url,
			},
			h(
				Text,
				{ style: { ...textStyle, fontFamily: theme.mono, fontSize: "28px" } },
				props.code,
			),
			h(
				Text,
				{ style: textStyle },
				"This code works once and ends in 5 minutes. Enter it only in the OpenBot page where you asked to sign in. If you did not ask for this code, ignore this email.",
			),
		),
	)
