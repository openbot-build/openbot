import type { Messages } from "./types.ts"

export default {
	description:
		"Une plateforme de Bots sans interface, pensée d’abord pour l’API.",
	nav: {
		label: "Site",
		docs: "Docs",
		api: "API",
		language: "Langue",
	},
	hero: {
		title: [
			"Des Bots que vous pouvez appeler.",
			"Des résultats que vous pouvez vérifier.",
		],
		body: "OpenBot est une plateforme de Bots open source sans interface utilisateur. Vous confiez du travail à un Bot par HTTP.",
		quickStart: "Démarrage rapide",
		apiReference: "Référence de l’API",
		visual: "Lancer un Turn",
		prompt: "Prépare un séjour de trois jours à Rome.",
	},
	scenarios: {
		title: "Qu’allez-vous créer ?",
		label: "Clients",
		script: {
			label: "Un script",
			prompt: "Chaque matin, lis les nouveaux tickets de support et trie-les.",
			meaning:
				"Appelez un endpoint depuis une tâche cron. Lisez la réponse en JSON.",
		},
		service: {
			label: "Un service",
			prompt:
				"Vérifie chaque nouvelle commande et signale celles qui semblent fausses.",
			meaning:
				"Votre serveur lance un Turn. Ensuite, il lit un flux ou attend avec du long polling.",
		},
		bot: {
			label: "Un chatbot",
			prompt:
				"Réponds aux questions dans le chat de l’équipe. Demande-moi avant d’envoyer un e-mail.",
			meaning:
				"Les appels d’outils à risque attendent qu’une personne dise oui.",
		},
	},
	contract: {
		visual: "Un seul contrat",
		title: ["Chaque fonction est un appel HTTP.", "Un seul contrat typé."],
		body: "Le serveur, le client TypeScript et la référence de l’API viennent tous d’un seul contrat. Utilisez une clé d’API depuis n’importe quel programme.",
	},
	features: {
		title: [
			"Utilisez votre propre client.",
			"Les humains gardent le contrôle.",
		],
		items: [
			{
				title: "Un chat avec chaque Bot",
				text: "Vous avez un chat avec chaque Bot. Le Bot répond toujours tout de suite, et le travail long avance en parallèle.",
			},
			{
				title: "Validations",
				text: "Les appels d’outils à risque attendent qu’une personne dise oui. Chaque réponse garde son historique.",
			},
			{
				title: "Apps ouvertes",
				text: "Les Bots trouvent et utilisent des Apps que des éditeurs publient sur le web ouvert avec l’OpenBot App Protocol.",
			},
			{
				title: "Vos modèles",
				text: "Utilisez OpenAI, Anthropic ou tout serveur compatible avec Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Démarrez en", "trois étapes."],
		label: "Étapes",
		steps: [
			{
				title: "Lancez le serveur",
				text: "Lancez OpenBot sur votre ordinateur avec Docker et devenv. Un compte de test et des modèles de test sont inclus.",
			},
			{
				title: "Créez une clé d’API",
				text: "Connectez-vous une fois dans un navigateur, créez une clé et appelez l’API depuis n’importe quel programme.",
			},
			{
				title: "Lancez un Turn",
				text: "Envoyez le travail en langage simple. Lisez la réponse, les appels d’outils et l’historique.",
			},
		],
	},
	license: {
		label: "Licence",
		body: "OpenBot est un logiciel libre sous AGPL-3.0-only. Vous pouvez lire le code, le modifier et le faire tourner sur vos propres serveurs.",
		link: "Lire le code",
	},
} satisfies Messages
