import type { Messages } from "./types.ts"

export default {
	description: "Platform Agent tanpa antarmuka yang mengutamakan API.",
	nav: {
		label: "Situs",
		docs: "Dokumentasi",
		api: "API",
		language: "Bahasa",
	},
	hero: {
		title: ["Agent yang bisa kamu panggil.", "Hasil yang bisa kamu periksa."],
		body: "OpenBot adalah platform Agent open source tanpa antarmuka pengguna. Kamu memberi pekerjaan ke Agent lewat HTTP.",
		quickStart: "Mulai cepat",
		apiReference: "Referensi API",
		visual: "Mulai Turn",
		prompt: "Buat rencana tiga hari di Roma.",
	},
	scenarios: {
		title: "Apa yang akan kamu buat?",
		label: "Klien",
		script: {
			label: "Skrip",
			prompt: "Setiap pagi, baca tiket dukungan yang baru lalu urutkan.",
			meaning:
				"Panggil satu endpoint dari cron job. Baca jawabannya sebagai JSON.",
		},
		service: {
			label: "Layanan",
			prompt: "Periksa setiap pesanan baru dan tandai yang kelihatan salah.",
			meaning:
				"Server kamu memulai Turn. Lalu server membaca stream atau menunggu dengan long poll.",
		},
		bot: {
			label: "Chatbot",
			prompt:
				"Jawab pertanyaan di chat tim kami. Tanya saya dulu sebelum mengirim email.",
			meaning:
				"Panggilan tool yang berisiko menunggu sampai ada orang yang setuju.",
		},
	},
	contract: {
		visual: "Satu kontrak",
		title: ["Setiap fitur adalah panggilan HTTP.", "Satu kontrak bertipe."],
		body: "Server, klien TypeScript, dan referensi API semuanya berasal dari satu kontrak. Pakai API key dari program apa pun.",
	},
	features: {
		title: ["Pakai klienmu sendiri.", "Manusia tetap memegang kendali."],
		items: [
			{
				title: "Session dan Timeline",
				text: "Pekerjaan berjalan di dalam Session dan Turn. Timeline menyimpan versi, jadi kamu bisa kembali dan mencoba lagi.",
			},
			{
				title: "Persetujuan",
				text: "Panggilan tool yang berisiko menunggu sampai ada orang yang setuju. Setiap jawaban menyimpan riwayatnya.",
			},
			{
				title: "App terbuka",
				text: "Agent menemukan dan memakai App yang dipasang penerbit di web terbuka dengan OpenBot App Protocol.",
			},
			{
				title: "Model kamu",
				text: "Pakai OpenAI, Anthropic, atau server apa pun yang mendukung Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Mulai dalam", "tiga langkah."],
		label: "Langkah",
		steps: [
			{
				title: "Jalankan server",
				text: "Jalankan OpenBot di komputermu dengan Docker dan devenv. Sudah ada akun uji dan model uji.",
			},
			{
				title: "Buat API key",
				text: "Masuk sekali di browser, buat key, lalu panggil API dari program apa pun.",
			},
			{
				title: "Mulai Turn",
				text: "Kirim pekerjaan dengan bahasa sehari-hari. Baca jawabannya, panggilan tool, dan riwayatnya.",
			},
		],
	},
	license: {
		label: "Lisensi",
		body: "OpenBot adalah perangkat lunak bebas dengan lisensi AGPL-3.0-only. Kamu bisa membaca kodenya, mengubahnya, dan menjalankannya di servermu sendiri.",
		link: "Baca kodenya",
	},
} satisfies Messages
