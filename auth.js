const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

const apiId = 35891564;
const apiHash = 'b3e5eaf6effbb3ea26e455f8df127ef3';
const stringSession = new StringSession('');

(async () => {
	const client = new TelegramClient(stringSession, apiId, apiHash, {
		connectionRetries: 5,
	});

	await client.start({
		phoneNumber: async () => await ask('Phone number (+380...): '),
		password: async () => await ask('2FA Password (if enabled): '),
		phoneCode: async () => await ask('Telegram code: '),
		onError: (err) => console.log(err),
	});

	console.log('\nОсь твоя SESSION_2. Скопіюй цей рядок:');
	console.log(client.session.save());

	process.exit(0);
})();
