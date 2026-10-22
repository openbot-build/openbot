import type { Messages } from "./types.ts"

export default {
	description:
		"Eine Agent-Plattform ohne Oberfläche, mit der API an erster Stelle.",
	nav: {
		label: "Website",
		docs: "Doku",
		api: "API",
		language: "Sprache",
	},
	hero: {
		title: [
			"Agents, die du aufrufen kannst.",
			"Ergebnisse, die du prüfen kannst.",
		],
		body: "OpenBot ist eine Open-Source-Plattform für Agents ohne Benutzeroberfläche. Du gibst einem Agent Arbeit über HTTP.",
		quickStart: "Schnellstart",
		apiReference: "API-Referenz",
		visual: "Einen Turn starten",
		prompt: "Plane drei Tage in Rom.",
	},
	scenarios: {
		title: "Was baust du?",
		label: "Clients",
		script: {
			label: "Ein Skript",
			prompt: "Lies jeden Morgen die neuen Support-Tickets und sortiere sie.",
			meaning:
				"Rufe einen Endpoint aus einem cron-Job auf. Lies die Antwort als JSON.",
		},
		service: {
			label: "Ein Dienst",
			prompt:
				"Prüfe jede neue Bestellung und markiere die, die falsch aussehen.",
			meaning:
				"Dein Server startet einen Turn. Dann liest er einen Stream oder wartet per Long Polling.",
		},
		bot: {
			label: "Ein Chatbot",
			prompt:
				"Beantworte Fragen in unserem Team-Chat. Frag mich, bevor du eine E-Mail sendest.",
			meaning: "Riskante Tool-Aufrufe warten, bis ein Mensch Ja sagt.",
		},
	},
	contract: {
		visual: "Ein Vertrag",
		title: ["Jede Funktion ist ein HTTP-Aufruf.", "Ein typisierter Vertrag."],
		body: "Der Server, der TypeScript-Client und die API-Referenz kommen alle aus einem Vertrag. Nutze einen API-Schlüssel aus jedem Programm.",
	},
	features: {
		title: ["Nutze deinen eigenen Client.", "Menschen behalten die Kontrolle."],
		items: [
			{
				title: "Sessions und Timelines",
				text: "Die Arbeit passiert in Sessions und Turns. Die Timeline speichert Versionen, also kannst du zurückgehen und es noch einmal versuchen.",
			},
			{
				title: "Freigaben",
				text: "Riskante Tool-Aufrufe warten, bis ein Mensch Ja sagt. Jede Antwort behält ihren Verlauf.",
			},
			{
				title: "Offene Apps",
				text: "Agents finden und nutzen Apps, die Anbieter mit dem OpenBot App Protocol ins offene Web stellen.",
			},
			{
				title: "Deine Modelle",
				text: "Nutze OpenAI, Anthropic oder jeden Server, der Chat Completions spricht.",
			},
		],
	},
	closing: {
		title: ["Starte in", "drei Schritten."],
		label: "Schritte",
		steps: [
			{
				title: "Server starten",
				text: "Starte OpenBot auf deinem Computer mit Docker und devenv. Ein Testkonto und Testmodelle sind dabei.",
			},
			{
				title: "API-Schlüssel erstellen",
				text: "Melde dich einmal im Browser an, erstelle einen Schlüssel und rufe die API aus jedem Programm auf.",
			},
			{
				title: "Einen Turn starten",
				text: "Schicke Arbeit in einfacher Sprache. Lies die Antwort, die Tool-Aufrufe und den Verlauf.",
			},
		],
	},
	license: {
		label: "Lizenz",
		body: "OpenBot ist freie Software unter AGPL-3.0-only. Du kannst den Code lesen, ändern und auf deinen eigenen Servern laufen lassen.",
		link: "Code lesen",
	},
} satisfies Messages
