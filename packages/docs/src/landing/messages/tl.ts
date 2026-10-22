import type { Messages } from "./types.ts"

export default {
	description: "Isang Agent platform na walang interface at API ang inuuna.",
	nav: {
		label: "Site",
		docs: "Docs",
		api: "API",
		language: "Wika",
	},
	hero: {
		title: [
			"Mga Agent na puwede mong tawagin.",
			"Mga resulta na puwede mong suriin.",
		],
		body: "Ang OpenBot ay isang open source na Agent platform na walang user interface. Binibigyan mo ng trabaho ang Agent gamit ang HTTP.",
		quickStart: "Mabilis na simula",
		apiReference: "API reference",
		visual: "Magsimula ng Turn",
		prompt: "Gumawa ng plano para sa tatlong araw sa Rome.",
	},
	scenarios: {
		title: "Ano ang gagawin mo?",
		label: "Mga client",
		script: {
			label: "Isang script",
			prompt:
				"Tuwing umaga, basahin ang mga bagong support ticket at ayusin ang mga ito.",
			meaning:
				"Tumawag ng isang endpoint mula sa isang cron job. Basahin ang sagot bilang JSON.",
		},
		service: {
			label: "Isang service",
			prompt: "Suriin ang bawat bagong order at markahan ang mga mukhang mali.",
			meaning:
				"Nagsisimula ng Turn ang server mo. Pagkatapos, nagbabasa ito ng stream o naghihintay gamit ang long poll.",
		},
		bot: {
			label: "Isang chat bot",
			prompt:
				"Sagutin ang mga tanong sa team chat namin. Magtanong muna sa akin bago magpadala ng email.",
			meaning:
				"Naghihintay ang mga delikadong tool call hanggang may taong pumayag.",
		},
	},
	contract: {
		visual: "Isang kontrata",
		title: ["Bawat feature ay isang HTTP call.", "Isang typed na kontrata."],
		body: "Galing sa iisang kontrata ang server, ang TypeScript client, at ang API reference. Gumamit ng API key mula sa kahit anong program.",
	},
	features: {
		title: ["Gamitin ang sarili mong client.", "Tao pa rin ang may kontrol."],
		items: [
			{
				title: "Mga Session at Timeline",
				text: "Nangyayari ang trabaho sa mga Session at Turn. Itinatago ng Timeline ang mga bersyon, kaya puwede kang bumalik at sumubok ulit.",
			},
			{
				title: "Mga pag-apruba",
				text: "Naghihintay ang mga delikadong tool call hanggang may taong pumayag. Bawat sagot ay may sariling history.",
			},
			{
				title: "Mga bukas na App",
				text: "Hinahanap at ginagamit ng mga Agent ang mga App na inilagay ng mga publisher sa bukas na web gamit ang OpenBot App Protocol.",
			},
			{
				title: "Ang sarili mong mga model",
				text: "Gamitin ang OpenAI, Anthropic, o kahit anong server na marunong ng Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Magsimula sa", "tatlong hakbang."],
		label: "Mga hakbang",
		steps: [
			{
				title: "Simulan ang server",
				text: "Patakbuhin ang OpenBot sa computer mo gamit ang Docker at devenv. May kasama na itong test account at mga test model.",
			},
			{
				title: "Gumawa ng API key",
				text: "Mag-sign in nang isang beses sa browser, gumawa ng key, at tawagin ang API mula sa kahit anong program.",
			},
			{
				title: "Magsimula ng Turn",
				text: "Ipadala ang trabaho sa simpleng salita. Basahin ang sagot, ang mga tool call, at ang history.",
			},
		],
	},
	license: {
		label: "Lisensya",
		body: "Ang OpenBot ay libreng software sa ilalim ng AGPL-3.0-only. Puwede mong basahin ang code, baguhin ito, at patakbuhin ito sa sarili mong mga server.",
		link: "Basahin ang code",
	},
} satisfies Messages
