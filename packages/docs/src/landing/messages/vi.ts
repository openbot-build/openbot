import type { Messages } from "./types.ts"

export default {
	description: "Nền tảng Bot không giao diện, ưu tiên API.",
	nav: {
		label: "Trang",
		docs: "Tài liệu",
		api: "API",
		language: "Ngôn ngữ",
	},
	hero: {
		title: ["Bot bạn có thể gọi.", "Kết quả bạn có thể kiểm tra."],
		body: "OpenBot là nền tảng Bot mã nguồn mở, không có giao diện người dùng. Bạn giao việc cho Bot qua HTTP.",
		quickStart: "Bắt đầu nhanh",
		apiReference: "Tài liệu API",
		visual: "Bắt đầu một Turn",
		prompt: "Lên kế hoạch ba ngày ở Rome.",
	},
	scenarios: {
		title: "Bạn sẽ xây gì?",
		label: "Ứng dụng khách",
		script: {
			label: "Một script",
			prompt: "Mỗi sáng, đọc các yêu cầu hỗ trợ mới và phân loại chúng.",
			meaning:
				"Gọi một endpoint từ một cron job. Đọc câu trả lời dưới dạng JSON.",
		},
		service: {
			label: "Một dịch vụ",
			prompt: "Kiểm tra từng đơn hàng mới và đánh dấu những đơn có vẻ sai.",
			meaning:
				"Máy chủ của bạn bắt đầu một Turn. Sau đó nó đọc một luồng hoặc chờ bằng long poll.",
		},
		bot: {
			label: "Một chat bot",
			prompt:
				"Trả lời câu hỏi trong nhóm chat của chúng tôi. Hỏi tôi trước khi gửi email.",
			meaning: "Các lệnh gọi công cụ rủi ro sẽ chờ đến khi có người đồng ý.",
		},
	},
	contract: {
		visual: "Một hợp đồng",
		title: [
			"Mọi tính năng là một lệnh gọi HTTP.",
			"Một hợp đồng có kiểu rõ ràng.",
		],
		body: "Máy chủ, TypeScript client và tài liệu API đều đến từ một hợp đồng. Dùng API key từ bất kỳ chương trình nào.",
	},
	features: {
		title: ["Dùng client của riêng bạn.", "Con người luôn nắm quyền."],
		items: [
			{
				title: "Session và Timeline",
				text: "Công việc diễn ra trong Session và Turn. Timeline giữ các phiên bản, nên bạn có thể quay lại và thử lại.",
			},
			{
				title: "Phê duyệt",
				text: "Các lệnh gọi công cụ rủi ro sẽ chờ đến khi có người đồng ý. Mọi câu trả lời đều giữ lịch sử.",
			},
			{
				title: "App mở",
				text: "Bot tìm và dùng các App mà nhà phát hành đưa lên web mở bằng OpenBot App Protocol.",
			},
			{
				title: "Mô hình của bạn",
				text: "Dùng OpenAI, Anthropic, hoặc bất kỳ máy chủ nào hỗ trợ Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Bắt đầu với", "ba bước."],
		label: "Các bước",
		steps: [
			{
				title: "Khởi động máy chủ",
				text: "Chạy OpenBot trên máy tính của bạn với Docker và devenv. Có sẵn tài khoản thử và mô hình thử.",
			},
			{
				title: "Tạo API key",
				text: "Đăng nhập một lần trên trình duyệt, tạo key, rồi gọi API từ bất kỳ chương trình nào.",
			},
			{
				title: "Bắt đầu một Turn",
				text: "Gửi việc bằng ngôn ngữ thường ngày. Đọc câu trả lời, các lệnh gọi công cụ và lịch sử.",
			},
		],
	},
	license: {
		label: "Giấy phép",
		body: "OpenBot là phần mềm tự do theo AGPL-3.0-only. Bạn có thể đọc mã, sửa nó và chạy nó trên máy chủ của riêng bạn.",
		link: "Đọc mã nguồn",
	},
} satisfies Messages
