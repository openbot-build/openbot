import type { Messages } from "./types.ts"

export default {
	description: "UI を持たない、API ファーストの Bot プラットフォーム。",
	nav: {
		label: "サイト",
		docs: "ドキュメント",
		api: "API",
		language: "言語",
	},
	hero: {
		title: ["呼び出せる Bot。", "確かめられる結果。"],
		body: "OpenBot は、ユーザーインターフェースのないオープンソースの Bot プラットフォームです。HTTP で Bot に仕事を渡せます。",
		quickStart: "クイックスタート",
		apiReference: "API リファレンス",
		visual: "Turn を始める",
		prompt: "ローマで過ごす 3 日間の計画を立てて。",
	},
	scenarios: {
		title: "何を作りますか？",
		label: "クライアント",
		script: {
			label: "スクリプト",
			prompt: "毎朝、新しいサポートチケットを読んで振り分けて。",
			meaning:
				"cron ジョブから 1 つのエンドポイントを呼びます。答えは JSON で読めます。",
		},
		service: {
			label: "サービス",
			prompt: "新しい注文をすべて確認して、おかしそうなものに印を付けて。",
			meaning:
				"あなたのサーバーが Turn を始めます。そのあとストリームを読むか、ロングポーリングで待ちます。",
		},
		bot: {
			label: "チャットボット",
			prompt: "チームのチャットで質問に答えて。メールを送る前に私に確認して。",
			meaning: "リスクのあるツール呼び出しは、人が OK するまで待ちます。",
		},
	},
	contract: {
		visual: "1 つの契約",
		title: ["すべての機能は HTTP 呼び出し。", "型付きの契約は 1 つだけ。"],
		body: "サーバー、TypeScript クライアント、API リファレンスはすべて 1 つの契約から生まれます。どのプログラムからでも API キーで使えます。",
	},
	features: {
		title: ["クライアントは自由に。", "主導権は人の手に。"],
		items: [
			{
				title: "Session と Timeline",
				text: "仕事は Session と Turn の中で進みます。Timeline はバージョンを残すので、戻ってやり直せます。",
			},
			{
				title: "承認",
				text: "リスクのあるツール呼び出しは、人が OK するまで待ちます。どの答えも履歴が残ります。",
			},
			{
				title: "オープンな App",
				text: "Bot は、公開者が OpenBot App Protocol でオープンなウェブに置いた App を見つけて使います。",
			},
			{
				title: "好きなモデルを",
				text: "OpenAI、Anthropic、または Chat Completions に対応した任意のサーバーを使えます。",
			},
		],
	},
	closing: {
		title: ["3 つのステップで", "始めよう。"],
		label: "ステップ",
		steps: [
			{
				title: "サーバーを起動する",
				text: "Docker と devenv で、自分のパソコンで OpenBot を動かします。テスト用のアカウントとモデルが付いています。",
			},
			{
				title: "API キーを作る",
				text: "ブラウザで一度サインインしてキーを作れば、どのプログラムからでも API を呼べます。",
			},
			{
				title: "Turn を始める",
				text: "ふつうの言葉で仕事を送ります。答え、ツール呼び出し、履歴を読めます。",
			},
		],
	},
	license: {
		label: "ライセンス",
		body: "OpenBot は AGPL-3.0-only の自由ソフトウェアです。コードを読み、変更し、自分のサーバーで動かせます。",
		link: "コードを読む",
	},
} satisfies Messages
