import type { Messages } from "./types.ts"

export default {
	description: "Interfeyssiz, API asosidagi Agent platformasi.",
	nav: {
		label: "Sayt",
		docs: "Hujjatlar",
		api: "API",
		language: "Til",
	},
	hero: {
		title: ["Chaqira oladigan Agentlar.", "Tekshira oladigan natijalar."],
		body: "OpenBot – foydalanuvchi interfeysi yo‘q ochiq kodli Agent platformasi. Siz Agentga HTTP orqali ish berasiz.",
		quickStart: "Tez boshlash",
		apiReference: "API ma’lumotnomasi",
		visual: "Turn boshlash",
		prompt: "Rimda uch kunlik sayohatni rejalashtir.",
	},
	scenarios: {
		title: "Siz nima yaratasiz?",
		label: "Mijozlar",
		script: {
			label: "Skript",
			prompt: "Har tongda yangi yordam so‘rovlarini o‘qib, ularni sarala.",
			meaning:
				"Cron vazifasidan (jadval bo‘yicha ishlaydigan vazifa) bitta endpointni chaqiring. Javobni JSON sifatida o‘qing.",
		},
		service: {
			label: "Xizmat",
			prompt:
				"Har bir yangi buyurtmani tekshirib, noto‘g‘ri ko‘ringanlarini belgila.",
			meaning:
				"Serveringiz Turn boshlaydi. Keyin u oqimni o‘qiydi yoki long poll bilan kutadi.",
		},
		bot: {
			label: "Chat bot",
			prompt:
				"Jamoa chatimizdagi savollarga javob ber. Email yuborishdan oldin mendan so‘ra.",
			meaning: "Xavfli vosita chaqiruvlari inson “ha” demaguncha kutadi.",
		},
	},
	contract: {
		visual: "Bitta kontrakt",
		title: [
			"Har bir funksiya – bitta HTTP chaqiruv.",
			"Bitta turlangan kontrakt.",
		],
		body: "Server, TypeScript mijozi va API ma’lumotnomasi bitta kontraktdan yaratiladi. Istalgan dasturdan API kalitidan foydalaning.",
	},
	features: {
		title: ["O‘z mijozingizni olib keling.", "Nazorat odamlar qo‘lida."],
		items: [
			{
				title: "Sessionlar va Timelinelar",
				text: "Ish Sessionlar va Turnlarda bo‘ladi. Timeline versiyalarni saqlaydi, shuning uchun orqaga qaytib, qayta urinib ko‘rishingiz mumkin.",
			},
			{
				title: "Tasdiqlar",
				text: "Xavfli vosita chaqiruvlari inson “ha” demaguncha kutadi. Har bir javob o‘z tarixini saqlaydi.",
			},
			{
				title: "Ochiq Applar",
				text: "Agentlar nashriyotchilar OpenBot App Protocol orqali ochiq vebga qo‘ygan Applarni topadi va ishlatadi.",
			},
			{
				title: "Sizning modellaringiz",
				text: "OpenAI, Anthropic yoki Chat Completions bilan ishlaydigan istalgan serverdan foydalaning.",
			},
		],
	},
	closing: {
		title: ["Uch qadamda", "boshlang."],
		label: "Qadamlar",
		steps: [
			{
				title: "Serverni ishga tushiring",
				text: "OpenBot’ni kompyuteringizda Docker va devenv bilan ishga tushiring. U test akkaunti va test modellari bilan keladi.",
			},
			{
				title: "API kalitini yarating",
				text: "Brauzerda bir marta kiring, kalit yarating va istalgan dasturdan API’ni chaqiring.",
			},
			{
				title: "Turn boshlang",
				text: "Ishni oddiy tilda yuboring. Javobni, vosita chaqiruvlarini va tarixni o‘qing.",
			},
		],
	},
	license: {
		label: "Litsenziya",
		body: "OpenBot – AGPL-3.0-only litsenziyasi ostidagi erkin dastur. Siz kodni o‘qishingiz, o‘zgartirishingiz va o‘z serverlaringizda ishga tushirishingiz mumkin.",
		link: "Kodni o‘qish",
	},
} satisfies Messages
