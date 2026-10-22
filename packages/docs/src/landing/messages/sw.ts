import type { Messages } from "./types.ts"

export default {
	description: "Jukwaa la Agent lisilo na kiolesura, linaloanza na API.",
	nav: {
		label: "Tovuti",
		docs: "Nyaraka",
		api: "API",
		language: "Lugha",
	},
	hero: {
		title: ["Agent unaoweza kuwaita.", "Matokeo unayoweza kukagua."],
		body: "OpenBot ni jukwaa huria la Agent lisilo na kiolesura cha mtumiaji. Unampa Agent kazi kupitia HTTP.",
		quickStart: "Anza haraka",
		apiReference: "Marejeo ya API",
		visual: "Anza Turn",
		prompt: "Panga safari ya siku tatu Roma.",
	},
	scenarios: {
		title: "Utajenga nini?",
		label: "Wateja",
		script: {
			label: "Skripti",
			prompt: "Kila asubuhi, soma tiketi mpya za msaada na uzipange.",
			meaning:
				"Ita endpoint moja kutoka kwa kazi ya cron (kazi inayoendeshwa kwa ratiba). Soma jibu kama JSON.",
		},
		service: {
			label: "Huduma",
			prompt:
				"Kagua kila oda mpya na uweke alama kwa zile zinazoonekana kuwa na kosa.",
			meaning:
				"Seva yako inaanza Turn. Kisha inasoma mtiririko au inasubiri kwa long poll.",
		},
		bot: {
			label: "Bot ya gumzo",
			prompt:
				"Jibu maswali kwenye gumzo la timu yetu. Niulize kabla ya kutuma barua pepe.",
			meaning: "Miito hatari ya zana inasubiri hadi mtu aseme ndiyo.",
		},
	},
	contract: {
		visual: "Mkataba mmoja",
		title: ["Kila kipengele ni mwito wa HTTP.", "Mkataba mmoja wenye aina."],
		body: "Seva, mteja wa TypeScript, na marejeo ya API vyote vinatoka kwenye mkataba mmoja. Tumia ufunguo wa API kutoka programu yoyote.",
	},
	features: {
		title: ["Leta mteja wako mwenyewe.", "Watu wanabaki na udhibiti."],
		items: [
			{
				title: "Session na Timeline",
				text: "Kazi hufanyika ndani ya Session na Turn. Timeline huhifadhi matoleo, kwa hiyo unaweza kurudi nyuma na kujaribu tena.",
			},
			{
				title: "Idhini",
				text: "Miito hatari ya zana inasubiri hadi mtu aseme ndiyo. Kila jibu linahifadhi historia yake.",
			},
			{
				title: "App huria",
				text: "Agent hupata na kutumia App ambazo wachapishaji huweka kwenye wavuti huria kwa OpenBot App Protocol.",
			},
			{
				title: "Modeli zako",
				text: "Tumia OpenAI, Anthropic, au seva yoyote inayozungumza Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Anza kwa", "hatua tatu."],
		label: "Hatua",
		steps: [
			{
				title: "Washa seva",
				text: "Endesha OpenBot kwenye kompyuta yako kwa Docker na devenv. Inakuja na akaunti ya majaribio na modeli za majaribio.",
			},
			{
				title: "Tengeneza ufunguo wa API",
				text: "Ingia mara moja kwenye kivinjari, tengeneza ufunguo, na uite API kutoka programu yoyote.",
			},
			{
				title: "Anza Turn",
				text: "Tuma kazi kwa lugha rahisi. Soma jibu, miito ya zana, na historia.",
			},
		],
	},
	license: {
		label: "Leseni",
		body: "OpenBot ni programu huru chini ya AGPL-3.0-only. Unaweza kusoma msimbo, kuubadilisha, na kuuendesha kwenye seva zako.",
		link: "Soma msimbo",
	},
} satisfies Messages
