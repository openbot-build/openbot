import type { Messages } from "./types.ts"

export default {
	description: "Uma plataforma de Bots sem interface e com foco na API.",
	nav: {
		label: "Site",
		docs: "Docs",
		api: "API",
		language: "Idioma",
	},
	hero: {
		title: ["Bots que você pode chamar.", "Resultados que você pode conferir."],
		body: "OpenBot é uma plataforma de Bots de código aberto sem interface de usuário. Você entrega trabalho a um Bot por HTTP.",
		quickStart: "Começo rápido",
		apiReference: "Referência da API",
		visual: "Inicie um Turn",
		prompt: "Planeje três dias em Roma.",
	},
	scenarios: {
		title: "O que você vai criar?",
		label: "Clientes",
		script: {
			label: "Um script",
			prompt: "Toda manhã, leia os novos tickets de suporte e organize-os.",
			meaning:
				"Chame um endpoint a partir de um job cron. Leia a resposta como JSON.",
		},
		service: {
			label: "Um serviço",
			prompt: "Confira cada novo pedido e marque os que parecem errados.",
			meaning:
				"Seu servidor inicia um Turn. Depois ele lê um stream ou espera com long polling.",
		},
		bot: {
			label: "Um chatbot",
			prompt:
				"Responda perguntas no chat da equipe. Me pergunte antes de enviar e-mail.",
			meaning:
				"Chamadas de ferramentas arriscadas esperam até uma pessoa dizer sim.",
		},
	},
	contract: {
		visual: "Um contrato",
		title: ["Cada recurso é uma chamada HTTP.", "Um contrato tipado."],
		body: "O servidor, o cliente TypeScript e a referência da API vêm todos de um único contrato. Use uma chave de API em qualquer programa.",
	},
	features: {
		title: ["Use o seu próprio cliente.", "As pessoas ficam no controle."],
		items: [
			{
				title: "Um chat com cada Bot",
				text: "Você tem um chat com cada Bot. O Bot sempre responde na hora, e o trabalho longo roda em paralelo.",
			},
			{
				title: "Aprovações",
				text: "Chamadas de ferramentas arriscadas esperam até uma pessoa dizer sim. Cada resposta guarda o seu histórico.",
			},
			{
				title: "Apps abertos",
				text: "Bots encontram e usam Apps que publicadores colocam na web aberta com o OpenBot App Protocol.",
			},
			{
				title: "Seus modelos",
				text: "Use OpenAI, Anthropic ou qualquer servidor compatível com Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Comece em", "três passos."],
		label: "Passos",
		steps: [
			{
				title: "Inicie o servidor",
				text: "Rode o OpenBot no seu computador com Docker e devenv. Ele já vem com uma conta de teste e modelos de teste.",
			},
			{
				title: "Crie uma chave de API",
				text: "Entre uma vez no navegador, crie uma chave e chame a API de qualquer programa.",
			},
			{
				title: "Inicie um Turn",
				text: "Envie o trabalho em linguagem simples. Leia a resposta, as chamadas de ferramentas e o histórico.",
			},
		],
	},
	license: {
		label: "Licença",
		body: "OpenBot é software livre sob a AGPL-3.0-only. Você pode ler o código, alterá-lo e rodá-lo nos seus próprios servidores.",
		link: "Leia o código",
	},
} satisfies Messages
