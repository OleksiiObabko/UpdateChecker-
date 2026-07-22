const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SESSION_STRING = process.env.TELEGRAM_SESSION || '';

async function initTelegram() {
	const stringSession = new StringSession(SESSION_STRING);
	const client = new TelegramClient(stringSession, API_ID, API_HASH, {
		connectionRetries: 5,
	});

	await client.start({
		phoneNumber: async () => await input.text('Number: '),
		password: async () => await input.text('Password: '),
		phoneCode: async () => await input.text('Code: '),
		onError: (err) => console.log(err),
	});

	return client;
}

module.exports = { initTelegram };
