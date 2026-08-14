const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId1 = parseInt(process.env.API_ID_1);
const apiHash1 = process.env.API_HASH_1;
const stringSession1 = new StringSession(process.env.SESSION_1 || '');

const apiId2 = parseInt(process.env.API_ID_2);
const apiHash2 = process.env.API_HASH_2;
const stringSession2 = new StringSession(process.env.SESSION_2 || '');

const apiId3 = parseInt(process.env.API_ID_3);
const apiHash3 = process.env.API_HASH_3;
const stringSession3 = new StringSession(process.env.SESSION_3 || '');

async function initTelegramClients() {
	const client1 = new TelegramClient(stringSession1, apiId1, apiHash1, {
		connectionRetries: 5,
	});
	client1.setLogLevel('none');
	await client1.connect();
	const me1 = await client1.getMe();

	const client2 = new TelegramClient(stringSession2, apiId2, apiHash2, {
		connectionRetries: 5,
	});
	client2.setLogLevel('none');
	await client2.connect();
	const me2 = await client2.getMe();

	const client3 = new TelegramClient(stringSession3, apiId3, apiHash3, {
		connectionRetries: 5,
	});
	client3.setLogLevel('none');
	await client3.connect();
	const me3 = await client3.getMe();

	return {
		clients: [client1, client2, client3],
		ourUserIds: [me1.id.toString(), me2.id.toString(), me3.id.toString()]
	};
}

module.exports = { initTelegramClients };
