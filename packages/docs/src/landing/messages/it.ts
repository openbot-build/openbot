import type { Messages } from "./types.ts"

export default {
	description:
		"Una piattaforma di Bot senza interfaccia, pensata prima di tutto per l’API.",
	nav: {
		label: "Sito",
		docs: "Docs",
		api: "API",
		language: "Lingua",
	},
	hero: {
		title: ["Bot che puoi chiamare.", "Risultati che puoi controllare."],
		body: "OpenBot è una piattaforma di Bot open source senza interfaccia utente. Dai il lavoro a un Bot tramite HTTP.",
		quickStart: "Inizio rapido",
		apiReference: "Riferimento API",
		visual: "Avvia un Turn",
		prompt: "Organizza tre giorni a Roma.",
	},
	scenarios: {
		title: "Cosa costruirai?",
		label: "Client",
		script: {
			label: "Uno script",
			prompt: "Ogni mattina leggi i nuovi ticket di assistenza e ordinali.",
			meaning:
				"Chiama un endpoint da un job cron. Leggi la risposta come JSON.",
		},
		service: {
			label: "Un servizio",
			prompt:
				"Controlla ogni nuovo ordine e segnala quelli che sembrano sbagliati.",
			meaning:
				"Il tuo server avvia un Turn. Poi legge uno stream o aspetta con il long polling.",
		},
		bot: {
			label: "Un chatbot",
			prompt:
				"Rispondi alle domande nella chat del team. Chiedimelo prima di inviare un’email.",
			meaning:
				"Le chiamate a strumenti rischiose aspettano finché una persona non dice sì.",
		},
	},
	contract: {
		visual: "Un solo contratto",
		title: [
			"Ogni funzione è una chiamata HTTP.",
			"Un solo contratto tipizzato.",
		],
		body: "Il server, il client TypeScript e il riferimento API nascono tutti da un solo contratto. Usa una chiave API da qualsiasi programma.",
	},
	features: {
		title: ["Usa il tuo client.", "Il controllo resta alle persone."],
		items: [
			{
				title: "Session e Timeline",
				text: "Il lavoro avviene in Session e Turn. La Timeline conserva le versioni, così puoi tornare indietro e riprovare.",
			},
			{
				title: "Approvazioni",
				text: "Le chiamate a strumenti rischiose aspettano finché una persona non dice sì. Ogni risposta conserva la sua cronologia.",
			},
			{
				title: "App aperte",
				text: "I Bot trovano e usano App che gli editori mettono sul web aperto con l’OpenBot App Protocol.",
			},
			{
				title: "I tuoi modelli",
				text: "Usa OpenAI, Anthropic o qualsiasi server compatibile con Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Inizia in", "tre passi."],
		label: "Passi",
		steps: [
			{
				title: "Avvia il server",
				text: "Esegui OpenBot sul tuo computer con Docker e devenv. Include un account di prova e modelli di prova.",
			},
			{
				title: "Crea una chiave API",
				text: "Accedi una volta nel browser, crea una chiave e chiama l’API da qualsiasi programma.",
			},
			{
				title: "Avvia un Turn",
				text: "Invia il lavoro in linguaggio semplice. Leggi la risposta, le chiamate agli strumenti e la cronologia.",
			},
		],
	},
	license: {
		label: "Licenza",
		body: "OpenBot è software libero con licenza AGPL-3.0-only. Puoi leggere il codice, modificarlo ed eseguirlo sui tuoi server.",
		link: "Leggi il codice",
	},
} satisfies Messages
