import type { Messages } from "./types.ts"

export default {
	description: "Platforma dla Botów bez interfejsu, oparta na API.",
	nav: {
		label: "Strona",
		docs: "Dokumentacja",
		api: "API",
		language: "Język",
	},
	hero: {
		title: ["Agenci, których wywołasz.", "Wyniki, które sprawdzisz."],
		body: "OpenBot to otwarta platforma dla Botów bez interfejsu użytkownika. Dajesz pracę Botowi przez HTTP.",
		quickStart: "Szybki start",
		apiReference: "Dokumentacja API",
		visual: "Zacznij Turn",
		prompt: "Zaplanuj trzy dni w Rzymie.",
	},
	scenarios: {
		title: "Co zbudujesz?",
		label: "Klienci",
		script: {
			label: "Skrypt",
			prompt:
				"Każdego ranka przeczytaj nowe zgłoszenia do supportu i je posortuj.",
			meaning:
				"Wywołaj jeden endpoint z zadania cron. Odczytaj odpowiedź jako JSON.",
		},
		service: {
			label: "Usługa",
			prompt: "Sprawdź każde nowe zamówienie i oznacz te, które wyglądają źle.",
			meaning:
				"Twój serwer zaczyna Turn. Potem czyta strumień albo czeka przez long polling.",
		},
		bot: {
			label: "Chatbot",
			prompt:
				"Odpowiadaj na pytania na naszym czacie zespołu. Zapytaj mnie, zanim wyślesz e-mail.",
			meaning: "Ryzykowne wywołania narzędzi czekają, aż człowiek się zgodzi.",
		},
	},
	contract: {
		visual: "Jeden kontrakt",
		title: ["Każda funkcja to wywołanie HTTP.", "Jeden typowany kontrakt."],
		body: "Serwer, klient TypeScript i dokumentacja API powstają z jednego kontraktu. Używaj klucza API z dowolnego programu.",
	},
	features: {
		title: ["Użyj własnego klienta.", "Ludzie mają kontrolę."],
		items: [
			{
				title: "Jeden czat z każdym Botem",
				text: "Z każdym Botem masz jeden czat. Bot zawsze odpowiada od razu, a długa praca idzie równolegle.",
			},
			{
				title: "Zgody",
				text: "Ryzykowne wywołania narzędzi czekają, aż człowiek się zgodzi. Każda odpowiedź zachowuje swoją historię.",
			},
			{
				title: "Otwarte Apps",
				text: "Agenci znajdują i używają Apps, które wydawcy publikują w otwartej sieci za pomocą OpenBot App Protocol.",
			},
			{
				title: "Twoje modele",
				text: "Używaj OpenAI, Anthropic albo dowolnego serwera, który obsługuje Chat Completions.",
			},
		],
	},
	closing: {
		title: ["Zacznij w", "trzech krokach."],
		label: "Kroki",
		steps: [
			{
				title: "Uruchom serwer",
				text: "Uruchom OpenBot na swoim komputerze z Docker i devenv. Dostajesz konto testowe i modele testowe.",
			},
			{
				title: "Utwórz klucz API",
				text: "Zaloguj się raz w przeglądarce, utwórz klucz i wywołuj API z dowolnego programu.",
			},
			{
				title: "Zacznij Turn",
				text: "Wyślij pracę zwykłym językiem. Przeczytaj odpowiedź, wywołania narzędzi i historię.",
			},
		],
	},
	license: {
		label: "Licencja",
		body: "OpenBot to wolne oprogramowanie na licencji AGPL-3.0-only. Możesz czytać kod, zmieniać go i uruchamiać na własnych serwerach.",
		link: "Zobacz kod",
	},
} satisfies Messages
