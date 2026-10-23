import type { Messages } from "./types.ts"

export default {
	description:
		"Una plataforma de Bots sin interfaz y pensada primero para la API.",
	nav: {
		label: "Sitio",
		docs: "Docs",
		api: "API",
		language: "Idioma",
	},
	hero: {
		title: ["Bots a los que puedes llamar.", "Resultados que puedes revisar."],
		body: "OpenBot es una plataforma de Bots de código abierto sin interfaz de usuario. Le das trabajo a un Bot por HTTP.",
		quickStart: "Inicio rápido",
		apiReference: "Referencia de la API",
		visual: "Inicia un Turn",
		prompt: "Planea tres días en Roma.",
	},
	scenarios: {
		title: "¿Qué vas a crear?",
		label: "Clientes",
		script: {
			label: "Un script",
			prompt: "Cada mañana, lee los tickets de soporte nuevos y ordénalos.",
			meaning:
				"Llama a un endpoint desde una tarea cron. Lee la respuesta como JSON.",
		},
		service: {
			label: "Un servicio",
			prompt: "Revisa cada pedido nuevo y marca los que parezcan incorrectos.",
			meaning:
				"Tu servidor inicia un Turn. Luego lee un stream o espera con long polling.",
		},
		bot: {
			label: "Un chatbot",
			prompt:
				"Responde preguntas en el chat del equipo. Pregúntame antes de enviar un correo.",
			meaning:
				"Las llamadas a herramientas con riesgo esperan hasta que una persona dice que sí.",
		},
	},
	contract: {
		visual: "Un contrato",
		title: ["Cada función es una llamada HTTP.", "Un contrato con tipos."],
		body: "El servidor, el cliente de TypeScript y la referencia de la API salen de un solo contrato. Usa una clave de API desde cualquier programa.",
	},
	features: {
		title: ["Usa tu propio cliente.", "Las personas tienen el control."],
		items: [
			{
				title: "Sessions y Timelines",
				text: "El trabajo ocurre en Sessions y Turns. La Timeline guarda versiones, así que puedes volver atrás e intentarlo de nuevo.",
			},
			{
				title: "Aprobaciones",
				text: "Las llamadas a herramientas con riesgo esperan hasta que una persona dice que sí. Cada respuesta guarda su historial.",
			},
			{
				title: "Apps abiertas",
				text: "Los Bots encuentran y usan Apps que los editores publican en la web abierta con el OpenBot App Protocol.",
			},
			{
				title: "Tus modelos",
				text: "Usa OpenAI, Anthropic o cualquier servidor compatible con Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Empieza en", "tres pasos."],
		label: "Pasos",
		steps: [
			{
				title: "Inicia el servidor",
				text: "Ejecuta OpenBot en tu computadora con Docker y devenv. Incluye una cuenta de prueba y modelos de prueba.",
			},
			{
				title: "Crea una clave de API",
				text: "Inicia sesión una vez en el navegador, crea una clave y llama a la API desde cualquier programa.",
			},
			{
				title: "Inicia un Turn",
				text: "Envía trabajo en lenguaje sencillo. Lee la respuesta, las llamadas a herramientas y el historial.",
			},
		],
	},
	license: {
		label: "Licencia",
		body: "OpenBot es software libre bajo AGPL-3.0-only. Puedes leer el código, cambiarlo y ejecutarlo en tus propios servidores.",
		link: "Lee el código",
	},
} satisfies Messages
