import type { Messages } from "./types.ts"

export default {
	description: "Arayüzü olmayan, API öncelikli bir Agent platformu.",
	nav: {
		label: "Site",
		docs: "Belgeler",
		api: "API",
		language: "Dil",
	},
	hero: {
		title: ["Çağırabileceğin Agent'lar.", "Kontrol edebileceğin sonuçlar."],
		body: "OpenBot, kullanıcı arayüzü olmayan açık kaynak bir Agent platformudur. Agent'a işi HTTP ile verirsin.",
		quickStart: "Hızlı başlangıç",
		apiReference: "API başvurusu",
		visual: "Bir Turn başlat",
		prompt: "Roma'da üç günlük bir gezi planla.",
	},
	scenarios: {
		title: "Ne yapacaksın?",
		label: "İstemciler",
		script: {
			label: "Bir betik",
			prompt: "Her sabah yeni destek taleplerini oku ve sırala.",
			meaning:
				"Bir cron işinden tek bir uç noktayı çağır. Cevabı JSON olarak oku.",
		},
		service: {
			label: "Bir servis",
			prompt: "Her yeni siparişi kontrol et ve yanlış görünenleri işaretle.",
			meaning:
				"Sunucun bir Turn başlatır. Sonra bir akışı okur ya da uzun yoklama ile bekler.",
		},
		bot: {
			label: "Bir sohbet botu",
			prompt:
				"Ekip sohbetimizde soruları cevapla. E-posta göndermeden önce bana sor.",
			meaning: "Riskli araç çağrıları bir kişi evet diyene kadar bekler.",
		},
	},
	contract: {
		visual: "Tek sözleşme",
		title: ["Her özellik bir HTTP çağrısıdır.", "Tek, tipli bir sözleşme."],
		body: "Sunucu, TypeScript istemcisi ve API başvurusu tek bir sözleşmeden gelir. Herhangi bir programdan bir API anahtarı ile kullan.",
	},
	features: {
		title: ["Kendi istemcini getir.", "Kontrol insanlarda kalsın."],
		items: [
			{
				title: "Session'lar ve Timeline'lar",
				text: "İş, Session'lar ve Turn'ler içinde olur. Timeline sürümleri saklar, böylece geri dönüp yeniden deneyebilirsin.",
			},
			{
				title: "Onaylar",
				text: "Riskli araç çağrıları bir kişi evet diyene kadar bekler. Her cevap geçmişini saklar.",
			},
			{
				title: "Açık App'ler",
				text: "Agent'lar, yayıncıların OpenBot App Protocol ile açık web'e koyduğu App'leri bulur ve kullanır.",
			},
			{
				title: "Senin modellerin",
				text: "OpenAI, Anthropic ya da Chat Completions konuşan herhangi bir sunucuyu kullan.",
			},
		],
	},
	closing: {
		title: ["Üç adımda", "başla."],
		label: "Adımlar",
		steps: [
			{
				title: "Sunucuyu başlat",
				text: "OpenBot'u bilgisayarında Docker ve devenv ile çalıştır. Bir test hesabı ve test modelleri ile gelir.",
			},
			{
				title: "Bir API anahtarı oluştur",
				text: "Bir kez tarayıcıda giriş yap, bir anahtar oluştur ve API'yi herhangi bir programdan çağır.",
			},
			{
				title: "Bir Turn başlat",
				text: "İşi sade bir dille gönder. Cevabı, araç çağrılarını ve geçmişi oku.",
			},
		],
	},
	license: {
		label: "Lisans",
		body: "OpenBot, AGPL-3.0-only altında özgür bir yazılımdır. Kodu okuyabilir, değiştirebilir ve kendi sunucularında çalıştırabilirsin.",
		link: "Kodu oku",
	},
} satisfies Messages
