import type { Messages } from "./types.ts"

export default {
	description: "A headless, API-first Agent platform.",
	nav: {
		label: "Site",
		docs: "Docs",
		api: "API",
		language: "Language",
	},
	hero: {
		title: ["Agents you can call.", "Results you can check."],
		body: "OpenBot is an open source Agent platform with no user interface. You give work to an Agent over HTTP.",
		quickStart: "Quick start",
		apiReference: "API reference",
		visual: "Start a Turn",
		prompt: "Plan three days in Rome.",
	},
	scenarios: {
		title: "What will you build?",
		label: "Clients",
		script: {
			label: "A script",
			prompt: "Every morning, read the new support tickets and sort them.",
			meaning: "Call one endpoint from a cron job. Read the answer as JSON.",
		},
		service: {
			label: "A service",
			prompt: "Check each new order and flag the ones that look wrong.",
			meaning:
				"Your server starts a Turn. Then it reads a stream or waits with a long poll.",
		},
		bot: {
			label: "A chat bot",
			prompt:
				"Answer questions in our team chat. Ask me before you send email.",
			meaning: "Risky tool calls wait until a person says yes.",
		},
	},
	contract: {
		visual: "One contract",
		title: ["Every feature is an HTTP call.", "One typed contract."],
		body: "The server, the TypeScript client, and the API reference all come from one contract. Use an API key from any program.",
	},
	features: {
		title: ["Bring your own client.", "Keep people in control."],
		items: [
			{
				title: "Sessions and Timelines",
				text: "Work happens in Sessions and Turns. The Timeline keeps versions, so you can go back and try again.",
			},
			{
				title: "Approvals",
				text: "Risky tool calls wait until a person says yes. Every answer keeps its history.",
			},
			{
				title: "Open Apps",
				text: "Agents find and use Apps that publishers put on the open web with the OpenBot App Protocol.",
			},
			{
				title: "Your models",
				text: "Use OpenAI, Anthropic, or any server that speaks Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Start in", "three steps."],
		label: "Steps",
		steps: [
			{
				title: "Start the server",
				text: "Run OpenBot on your computer with Docker and devenv. It comes with a test account and test models.",
			},
			{
				title: "Make an API key",
				text: "Sign in once in a browser, make a key, and call the API from any program.",
			},
			{
				title: "Start a Turn",
				text: "Send work in plain language. Read the answer, the tool calls, and the history.",
			},
		],
	},
	license: {
		label: "License",
		body: "OpenBot is free software under AGPL-3.0-only. You can read the code, change it, and run it on your own servers.",
		link: "Read the code",
	},
} satisfies Messages
