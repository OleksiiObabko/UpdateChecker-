# Telegram & Slack Monitoring System

Система автоматичного моніторингу транзакцій, яка відслідковує наявність відповідей на звернення у Telegram, Slack і сторонній гугл таблиці. Програма здійснює лайв-відстеження повідомлень та періодичне сканування історії для пошуку пропущених апдейтів.

## Вимоги (Prerequisites)

* **Node.js** (версія 18.x або 20.x LTS)
* **npm**
* Ключ сервісного акаунта Google (`credentials.json`)
* Токени для Slack Bot (Bot Token та App Token)
* Telegram API ID та Hash

## Встановлення

```bash
npm install dotenv prompts google-spreadsheet google-auth-library @slack/bolt telegram
```

## Конфігурація

### 1. Google Sheets Credentials
Помісти файл `credentials.json` у кореневу папку проєкту. Надай email-у сервісного акаунта "client_email" доступ до редагування твоїх таблиць (основної та сторонньої).

### 2. Змінні оточення (.env)
Створи файл `.env` у кореневій папці та заповни його необхідними даними:

```env
SHEET_ID=ідентифікатор_таблиці

API_ID_1=api_id_1
API_HASH_1=api_hash_1
SESSION_1=перша_сесія

API_ID_2=api_id_2
API_HASH_2=api_hash_2
SESSION_2=друга_сесія

SLACK_BOT_TOKEN=xoxb-токен-бота
SLACK_APP_TOKEN=xapp-токен-застосунку
OUR_SLACK_USER_ID=ідентифікатор_акаунту_в_slack

SLACK_PS="name_ps_in_slack"

EXTERNAL_PS_SHEET_ID=ідентифікатор_таблиці_пс
EXTERNAL_PS_NAMES=назви_пс_як_у_твоїй_таблиці

KNOWN_CHAT_IDS="
-chatid1 (pgi:ps1)
-chatid2 (pgi:ps2)
"
```
## Запуск програми
```
node index.js
