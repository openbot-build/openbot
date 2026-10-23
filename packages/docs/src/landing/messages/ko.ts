import type { Messages } from "./types.ts"

export default {
	description: "화면 없이 API를 먼저 생각한 Bot 플랫폼.",
	nav: {
		label: "사이트",
		docs: "문서",
		api: "API",
		language: "언어",
	},
	hero: {
		title: ["호출할 수 있는 Bot.", "확인할 수 있는 결과."],
		body: "OpenBot은 사용자 인터페이스가 없는 오픈 소스 Bot 플랫폼입니다. HTTP로 Bot에게 일을 맡기세요.",
		quickStart: "빠른 시작",
		apiReference: "API 레퍼런스",
		visual: "Turn 시작하기",
		prompt: "로마에서 보낼 3일 일정을 짜 줘.",
	},
	scenarios: {
		title: "무엇을 만들까요?",
		label: "클라이언트",
		script: {
			label: "스크립트",
			prompt: "매일 아침 새 지원 티켓을 읽고 분류해 줘.",
			meaning:
				"cron 작업에서 엔드포인트 하나를 호출하세요. 답은 JSON으로 읽으면 됩니다.",
		},
		service: {
			label: "서비스",
			prompt: "새 주문을 하나씩 확인하고 이상해 보이는 주문을 표시해 줘.",
			meaning:
				"서버가 Turn을 시작합니다. 그다음 스트림을 읽거나 롱 폴링으로 기다립니다.",
		},
		bot: {
			label: "채팅 봇",
			prompt:
				"우리 팀 채팅에서 질문에 답해 줘. 이메일을 보내기 전에는 나에게 물어봐.",
			meaning: "위험한 도구 호출은 사람이 허락할 때까지 기다립니다.",
		},
	},
	contract: {
		visual: "하나의 계약",
		title: ["모든 기능은 HTTP 호출입니다.", "타입이 있는 하나의 계약."],
		body: "서버, TypeScript 클라이언트, API 레퍼런스가 모두 하나의 계약에서 만들어집니다. 어떤 프로그램에서든 API 키로 사용하세요.",
	},
	features: {
		title: ["원하는 클라이언트를 쓰세요.", "결정은 사람이 합니다."],
		items: [
			{
				title: "Bot마다 채팅 하나",
				text: "Bot마다 채팅이 하나 있습니다. Bot은 언제나 바로 답하고, 긴 일은 병렬로 진행됩니다.",
			},
			{
				title: "승인",
				text: "위험한 도구 호출은 사람이 허락할 때까지 기다립니다. 모든 답은 기록을 남깁니다.",
			},
			{
				title: "열린 App",
				text: "Bot는 게시자가 OpenBot App Protocol로 열린 웹에 올린 App을 찾아서 사용합니다.",
			},
			{
				title: "원하는 모델",
				text: "OpenAI, Anthropic, 또는 Chat Completions를 지원하는 어떤 서버든 쓸 수 있습니다.",
			},
		],
	},
	closing: {
		title: ["세 단계로", "시작하세요."],
		label: "단계",
		steps: [
			{
				title: "서버 시작하기",
				text: "Docker와 devenv로 내 컴퓨터에서 OpenBot을 실행하세요. 테스트 계정과 테스트 모델이 함께 들어 있습니다.",
			},
			{
				title: "API 키 만들기",
				text: "브라우저에서 한 번 로그인하고 키를 만든 뒤, 어떤 프로그램에서든 API를 호출하세요.",
			},
			{
				title: "Turn 시작하기",
				text: "평소 쓰는 말로 일을 보내세요. 답, 도구 호출, 기록을 읽을 수 있습니다.",
			},
		],
	},
	license: {
		label: "라이선스",
		body: "OpenBot은 AGPL-3.0-only 라이선스의 자유 소프트웨어입니다. 코드를 읽고, 바꾸고, 내 서버에서 실행할 수 있습니다.",
		link: "코드 보기",
	},
} satisfies Messages
