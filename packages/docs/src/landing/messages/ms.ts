import type { Messages } from "./types.ts"

export default {
	description: "Platform Bot tanpa antara muka, yang mengutamakan API.",
	nav: {
		label: "Laman",
		docs: "Dokumentasi",
		api: "API",
		language: "Bahasa",
	},
	hero: {
		title: ["Bot yang boleh anda panggil.", "Hasil yang boleh anda semak."],
		body: "OpenBot ialah platform Bot sumber terbuka tanpa antara muka pengguna. Anda beri kerja kepada Bot melalui HTTP.",
		quickStart: "Mula pantas",
		apiReference: "Rujukan API",
		visual: "Mulakan Turn",
		prompt: "Rancang percutian tiga hari di Rom.",
	},
	scenarios: {
		title: "Apa yang anda mahu bina?",
		label: "Klien",
		script: {
			label: "Skrip",
			prompt:
				"Setiap pagi, baca tiket sokongan baharu dan susun mengikut jenis.",
			meaning:
				"Panggil satu endpoint daripada cron job. Baca jawapan sebagai JSON.",
		},
		service: {
			label: "Perkhidmatan",
			prompt: "Semak setiap pesanan baharu dan tandakan yang nampak salah.",
			meaning:
				"Pelayan anda memulakan Turn. Kemudian ia membaca strim atau menunggu dengan long poll.",
		},
		bot: {
			label: "Bot sembang",
			prompt:
				"Jawab soalan dalam sembang pasukan kami. Tanya saya dulu sebelum hantar e-mel.",
			meaning:
				"Panggilan alat yang berisiko menunggu sehingga seseorang kata ya.",
		},
	},
	contract: {
		visual: "Satu kontrak",
		title: ["Setiap ciri ialah panggilan HTTP.", "Satu kontrak bertaip."],
		body: "Pelayan, klien TypeScript dan rujukan API semuanya datang daripada satu kontrak. Guna kunci API daripada mana-mana program.",
	},
	features: {
		title: ["Guna klien anda sendiri.", "Manusia tetap memegang kawalan."],
		items: [
			{
				title: "Satu sembang dengan setiap Bot",
				text: "Anda ada satu sembang dengan setiap Bot. Bot sentiasa menjawab serta-merta, dan kerja panjang berjalan serentak.",
			},
			{
				title: "Kelulusan",
				text: "Panggilan alat yang berisiko menunggu sehingga seseorang kata ya. Setiap jawapan menyimpan sejarahnya.",
			},
			{
				title: "App terbuka",
				text: "Bot mencari dan menggunakan App yang diletakkan oleh penerbit di web terbuka dengan OpenBot App Protocol.",
			},
			{
				title: "Model anda",
				text: "Guna OpenAI, Anthropic, atau mana-mana pelayan yang menyokong Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Mula dalam", "tiga langkah."],
		label: "Langkah",
		steps: [
			{
				title: "Hidupkan pelayan",
				text: "Jalankan OpenBot pada komputer anda dengan Docker dan devenv. Ia datang dengan akaun ujian dan model ujian.",
			},
			{
				title: "Buat kunci API",
				text: "Log masuk sekali dalam pelayar, buat kunci, dan panggil API daripada mana-mana program.",
			},
			{
				title: "Mulakan Turn",
				text: "Hantar kerja dalam bahasa biasa. Baca jawapan, panggilan alat dan sejarahnya.",
			},
		],
	},
	license: {
		label: "Lesen",
		body: "OpenBot ialah perisian bebas di bawah AGPL-3.0-only. Anda boleh baca kod, ubah kod dan jalankannya pada pelayan anda sendiri.",
		link: "Baca kod",
	},
} satisfies Messages
