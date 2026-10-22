import type { Messages } from "./types.ts"

export default {
	description: "一个无界面、API 优先的 Agent 平台。",
	nav: {
		label: "网站",
		docs: "文档",
		api: "API",
		language: "语言",
	},
	hero: {
		title: ["可以调用的 Agent。", "可以检查的结果。"],
		body: "OpenBot 是一个开源的 Agent 平台，没有用户界面。你通过 HTTP 把工作交给 Agent。",
		quickStart: "快速开始",
		apiReference: "API 参考",
		visual: "开始一个 Turn",
		prompt: "帮我规划三天的罗马行程。",
	},
	scenarios: {
		title: "你想做什么？",
		label: "客户端",
		script: {
			label: "一个脚本",
			prompt: "每天早上读一遍新的客服工单，并给它们分类。",
			meaning: "用 cron 定时任务调用一个接口。以 JSON 读取结果。",
		},
		service: {
			label: "一个服务",
			prompt: "检查每个新订单，标出看起来有问题的订单。",
			meaning: "你的服务器开始一个 Turn。然后读取数据流，或用长轮询等待结果。",
		},
		bot: {
			label: "一个聊天机器人",
			prompt: "在我们团队的聊天里回答问题。发邮件之前先问我。",
			meaning: "有风险的工具调用会等待，直到有人同意。",
		},
	},
	contract: {
		visual: "一份契约",
		title: ["每个功能都是一次 HTTP 调用。", "一份有类型的契约。"],
		body: "服务器、TypeScript 客户端和 API 参考都来自同一份契约。在任何程序里都能用 API 密钥调用。",
	},
	features: {
		title: ["用你自己的客户端。", "让人来掌控。"],
		items: [
			{
				title: "Session 和 Timeline",
				text: "工作在 Session 和 Turn 中进行。Timeline 会保存各个版本，你可以回到之前的版本再试一次。",
			},
			{
				title: "审批",
				text: "有风险的工具调用会等待，直到有人同意。每个回答都保留历史。",
			},
			{
				title: "开放的 App",
				text: "Agent 可以找到并使用发布者通过 OpenBot App Protocol 放在开放网络上的 App。",
			},
			{
				title: "你的模型",
				text: "可以用 OpenAI、Anthropic，或任何支持 Chat Completions 的服务器。",
			},
		],
	},
	closing: {
		title: ["三步", "即可开始。"],
		label: "步骤",
		steps: [
			{
				title: "启动服务器",
				text: "用 Docker 和 devenv 在你的电脑上运行 OpenBot。它自带测试账号和测试模型。",
			},
			{
				title: "创建 API 密钥",
				text: "在浏览器里登录一次，创建一个密钥，然后在任何程序里调用 API。",
			},
			{
				title: "开始一个 Turn",
				text: "用普通的话发送工作。读取回答、工具调用和历史记录。",
			},
		],
	},
	license: {
		label: "许可证",
		body: "OpenBot 是基于 AGPL-3.0-only 的自由软件。你可以阅读代码、修改代码，并在自己的服务器上运行。",
		link: "阅读代码",
	},
} satisfies Messages
