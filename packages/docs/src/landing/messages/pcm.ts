import type { Messages } from "./types.ts"

export default {
	description: "Bot platform wey no get screen, wey put API first.",
	nav: {
		label: "Site",
		docs: "Docs",
		api: "API",
		language: "Language",
	},
	hero: {
		title: ["Bots wey you fit call.", "Results wey you fit check."],
		body: "OpenBot na open source Bot platform wey no get user interface. You go give Bot work through HTTP.",
		quickStart: "Start sharp sharp",
		apiReference: "API reference",
		visual: "Start one Turn",
		prompt: "Plan three days for Rome.",
	},
	scenarios: {
		title: "Wetin you wan build?",
		label: "Clients",
		script: {
			label: "One script",
			prompt: "Every morning, read the new support tickets come arrange dem.",
			meaning:
				"Call one endpoint from cron job (work wey dey run for set time). Read the answer as JSON.",
		},
		service: {
			label: "One service",
			prompt: "Check every new order, mark the ones wey no look correct.",
			meaning:
				"Your server go start one Turn. Then e go read stream or wait with long poll.",
		},
		bot: {
			label: "One chat bot",
			prompt:
				"Answer questions for our team chat. Ask me first before you send email.",
			meaning: "Tool calls wey get risk go wait until person talk yes.",
		},
	},
	contract: {
		visual: "One contract",
		title: ["Every feature na HTTP call.", "One typed contract."],
		body: "The server, the TypeScript client, and the API reference all come from one contract. Use API key from any program.",
	},
	features: {
		title: ["Bring your own client.", "Make people still dey control."],
		items: [
			{
				title: "One chat with each Bot",
				text: "You get one chat with each Bot. The Bot dey answer you sharp sharp every time, and long work dey run at the same time.",
			},
			{
				title: "Approvals",
				text: "Tool calls wey get risk go wait until person talk yes. Every answer dey keep im history.",
			},
			{
				title: "Open Apps",
				text: "Bots dey find and use Apps wey publishers put for open web with OpenBot App Protocol.",
			},
			{
				title: "Your own models",
				text: "Use OpenAI, Anthropic, or any server wey sabi talk Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Start am for", "three steps."],
		label: "Steps",
		steps: [
			{
				title: "Start the server",
				text: "Run OpenBot for your computer with Docker and devenv. E come with test account and test models.",
			},
			{
				title: "Make API key",
				text: "Sign in one time for browser, make key, then call the API from any program.",
			},
			{
				title: "Start one Turn",
				text: "Send work for simple language. Read the answer, the tool calls, and the history.",
			},
		],
	},
	license: {
		label: "License",
		body: "OpenBot na free software under AGPL-3.0-only. You fit read the code, change am, and run am for your own servers.",
		link: "Read the code",
	},
} satisfies Messages
