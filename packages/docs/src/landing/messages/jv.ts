import type { Messages } from "./types.ts"

export default {
	description: "Platform Bot tanpa antarmuka, sing ngutamakake API.",
	nav: {
		label: "Situs",
		docs: "Dokumentasi",
		api: "API",
		language: "Basa",
	},
	hero: {
		title: ["Bot sing bisa kok undang.", "Asil sing bisa kok priksa."],
		body: "OpenBot iku platform Bot open source tanpa antarmuka pangguna. Kowe menehi gawean marang Bot liwat HTTP.",
		quickStart: "Wiwitan cepet",
		apiReference: "Referensi API",
		visual: "Miwiti Turn",
		prompt: "Gawekake rencana telung dina ing Roma.",
	},
	scenarios: {
		title: "Kowe arep nggawe apa?",
		label: "Klien",
		script: {
			label: "Skrip",
			prompt: "Saben esuk, wacanen tiket dhukungan sing anyar lan urutna.",
			meaning:
				"Undang siji endpoint saka cron job (gawean sing mlaku ing wektu tartamtu). Wacanen wangsulane minangka JSON.",
		},
		service: {
			label: "Layanan",
			prompt: "Priksa saben pesenan anyar lan wenehi tandha sing katon salah.",
			meaning:
				"Server-mu miwiti Turn. Banjur server maca stream utawa ngenteni nganggo long poll.",
		},
		bot: {
			label: "Chat bot",
			prompt:
				"Wangsulana pitakon ing chat tim kita. Takon aku dhisik sadurunge ngirim email.",
			meaning:
				"Panggilan piranti sing ana risikone ngenteni nganti ana wong sing ngomong iya.",
		},
	},
	contract: {
		visual: "Siji kontrak",
		title: [
			"Saben fitur iku panggilan HTTP.",
			"Siji kontrak sing nduweni tipe.",
		],
		body: "Server, klien TypeScript, lan referensi API kabeh asale saka siji kontrak. Nganggo API key saka program apa wae.",
	},
	features: {
		title: ["Gawanen klien dhewe.", "Manungsa tetep sing ngatur."],
		items: [
			{
				title: "Siji chat karo saben Bot",
				text: "Kowe duwe siji chat karo saben Bot. Bot tansah mangsuli langsung, lan gawean sing dawa mlaku bebarengan.",
			},
			{
				title: "Persetujuan",
				text: "Panggilan piranti sing ana risikone ngenteni nganti ana wong sing ngomong iya. Saben wangsulan nyimpen riwayate.",
			},
			{
				title: "App sing mbukak",
				text: "Bot nggoleki lan nganggo App sing dipasang para penerbit ing web mbukak nganggo OpenBot App Protocol.",
			},
			{
				title: "Model duwekmu",
				text: "Nganggo OpenAI, Anthropic, utawa server apa wae sing ngerti Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Miwiti ing", "telung langkah."],
		label: "Langkah",
		steps: [
			{
				title: "Uripna server",
				text: "Mlakokna OpenBot ing komputermu nganggo Docker lan devenv. Wis ana akun uji coba lan model uji coba.",
			},
			{
				title: "Gawe API key",
				text: "Mlebu sepisan ing browser, gawe key, lan undang API saka program apa wae.",
			},
			{
				title: "Miwiti Turn",
				text: "Kirim gawean nganggo basa sing prasaja. Wacanen wangsulan, panggilan piranti, lan riwayate.",
			},
		],
	},
	license: {
		label: "Lisensi",
		body: "OpenBot iku piranti lunak bebas miturut AGPL-3.0-only. Kowe bisa maca kode, ngowahi, lan mlakokake ing server dhewe.",
		link: "Waca kode",
	},
} satisfies Messages
