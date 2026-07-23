require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const apiId = parseInt(process.env.API_ID_1);
const apiHash = process.env.API_HASH_1;
const stringSession = new StringSession(process.env.SESSION_1 || '');

async function main() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  console.log('Підключено! Відправте повідомлення у потрібний чат...');

  client.addEventHandler(async (event) => {
    const message = event.message;
    let title = 'Unknown/Private';

    try {
      const chat = await message.getChat();
      if (chat) {
        title = chat.title || chat.username || chat.firstName || 'Private';
      }
    } catch (e) {}

    const chatId = message.chatId ? message.chatId.toString() : 'Невідомо';

    console.log(`Назва/Ім'я: ${title}`);
    console.log(`ID чату: ${chatId}\n`);
  }, new NewMessage({}));
}

main();
