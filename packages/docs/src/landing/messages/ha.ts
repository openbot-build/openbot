import type { Messages } from "./types.ts"

export default {
	description: "Dandalin Bot marar fuska, wanda ke aiki ta API.",
	nav: {
		label: "Shafi",
		docs: "Takardu",
		api: "API",
		language: "Harshe",
	},
	hero: {
		title: ["Bot da za ka iya kira.", "Sakamako da za ka iya dubawa."],
		body: "OpenBot dandalin Bot ne na buɗaɗɗen tushe, ba shi da fuskar mai amfani. Kana ba Bot aiki ta HTTP.",
		quickStart: "Fara da sauri",
		apiReference: "Bayanin API",
		visual: "Fara Turn",
		prompt: "Shirya tafiyar kwana uku a Rome.",
	},
	scenarios: {
		title: "Me za ka gina?",
		label: "Abokan hulɗa",
		script: {
			label: "Rubutun umarni",
			prompt:
				"Kowace safiya, karanta sababbin tikitin taimako kuma ka tsara su.",
			meaning:
				"Kira endpoint ɗaya daga aikin cron (aikin da ke gudana a lokaci). Karanta amsar a matsayin JSON.",
		},
		service: {
			label: "Sabis",
			prompt:
				"Duba kowane sabon oda kuma ka yi alama ga waɗanda suke kama da kuskure.",
			meaning:
				"Sabar ka tana fara Turn. Sannan tana karanta rafi ko tana jira da long poll.",
		},
		bot: {
			label: "Bot na hira",
			prompt:
				"Amsa tambayoyi a hirar ƙungiyarmu. Tambaye ni kafin ka aika imel.",
			meaning: "Kiran kayan aiki masu haɗari suna jira har sai mutum ya ce eh.",
		},
	},
	contract: {
		visual: "Yarjejeniya ɗaya",
		title: ["Kowane fasali kiran HTTP ne.", "Yarjejeniya ɗaya mai nau'i."],
		body: "Sabar, abokin hulɗa na TypeScript, da bayanin API duk sun fito daga yarjejeniya ɗaya. Yi amfani da maɓallin API daga kowace manhaja.",
	},
	features: {
		title: ["Kawo abokin hulɗarka.", "Mutane suna da iko."],
		items: [
			{
				title: "Hira ɗaya da kowane Bot",
				text: "Kana da hira ɗaya da kowane Bot. Bot yana amsawa nan take koyaushe, kuma dogon aiki yana tafiya a lokaci guda.",
			},
			{
				title: "Amincewa",
				text: "Kiran kayan aiki masu haɗari suna jira har sai mutum ya ce eh. Kowace amsa tana adana tarihinta.",
			},
			{
				title: "Buɗaɗɗun App",
				text: "Bot suna samo kuma suna amfani da App da masu wallafa suka sa a buɗaɗɗen yanar gizo tare da OpenBot App Protocol.",
			},
			{
				title: "Samfuranka",
				text: "Yi amfani da OpenAI, Anthropic, ko kowace sabar da ke magana da Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Fara cikin", "matakai uku."],
		label: "Matakai",
		steps: [
			{
				title: "Fara sabar",
				text: "Gudanar da OpenBot a kwamfutarka da Docker da devenv. Yana zuwa da asusun gwaji da samfuran gwaji.",
			},
			{
				title: "Yi maɓallin API",
				text: "Shiga sau ɗaya a burauza, yi maɓalli, sannan ka kira API daga kowace manhaja.",
			},
			{
				title: "Fara Turn",
				text: "Aika aiki da harshe mai sauƙi. Karanta amsar, kiran kayan aiki, da tarihin.",
			},
		],
	},
	license: {
		label: "Lasisi",
		body: "OpenBot manhaja ce ta 'yanci ƙarƙashin AGPL-3.0-only. Za ka iya karanta lambar, canza ta, kuma ka gudanar da ita a sabobinka.",
		link: "Karanta lambar",
	},
} satisfies Messages
