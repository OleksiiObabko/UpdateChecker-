require('dotenv').config();
const { App } = require('@slack/bolt');
const prompts = require('prompts');
const {
	initGoogleSheets,
	fetchActiveTransactions,
	updateTransactionStatus,
	initExternalSheets,
	checkExternalPsUpdates
} = require('./services/googleSheets');
const { initTelegramClients } = require('./services/telegram');

let activeTransactions = [];
let targetSheets = [];
let fetchPromise = null;
let cacheCountdown = 300;
let psCountdown = 600;

const originalLog = console.log;
console.log = function (...args) {
	process.stdout.write('\x1b[2K\r');
	originalLog.apply(console, args);
};

const originalError = console.error;
console.error = function (...args) {
	process.stdout.write('\x1b[2K\r');
	originalError.apply(console, args);
};

async function promptSheetSelection() {
	const response = await prompts({
		type: 'select',
		name: 'sheet',
		message: 'Оберіть аркуш для моніторингу:',
		choices: [
			{ title: 'Корівки', value: 'Корівки' },
			{ title: 'Вулик', value: 'Вулик' },
			{ title: 'all INR', value: 'all INR' },
			{ title: 'ASAP INR', value: 'ASAP INR' },
			{ title: 'Bulk INR', value: 'Bulk INR' },
			{ title: 'NPR', value: 'NPR' },
			{ title: 'MAD', value: 'MAD' },
			{ title: 'LKR', value: 'LKR' },
			{ title: 'PKR', value: 'PKR' }
		],
		initial: 0
	});

	if (!response.sheet) {
		process.exit(0);
	}

	targetSheets = [response.sheet];
}

async function updateCacheShared(doc, sheets) {
	if (fetchPromise) {
		return fetchPromise;
	}
	fetchPromise = fetchActiveTransactions(doc, sheets)
		.then(txs => {
			activeTransactions = txs;
			return txs;
		})
		.finally(() => {
			fetchPromise = null;
		});
	return fetchPromise;
}

const slackApp = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true
});

slackApp.message(async ({ message, client }) => {
	if (message.subtype || !message.thread_ts || message.ts === message.thread_ts) return;

	const isFromUs = message.user === process.env.OUR_SLACK_USER_ID;
	if (isFromUs) return;

	try {
		const threadData = await client.conversations.replies({
			channel: message.channel,
			ts: message.thread_ts,
			limit: 1
		});

		const parentMessage = threadData.messages[0];
		if (!parentMessage || !parentMessage.text) return;

		const match = parentMessage.text.match(/\b(\d+)\b/);

		if (match) {
			const transactionId = match[1];
			const matchedTx = activeTransactions.find(tx => tx.transactionId === transactionId);

			if (matchedTx) {
				console.log(`Апдейт Slack: ID ${transactionId}, ПС ${matchedTx.psName}, Зона ${matchedTx.sheetName}`);
				const doc = await initGoogleSheets();
				await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, 'update');
				matchedTx.status = 'update';
			}
		}
	} catch (error) {
		console.error(error);
	}
});

async function main() {
	await promptSheetSelection();

	const mainDoc = await initGoogleSheets();
	const externalDoc = await initExternalSheets();

	try {
		await initTelegramClients();
	} catch (error) {
		console.error(error);
	}

	await updateCacheShared(mainDoc, targetSheets);

	console.log(`\nЗапуск моніторингу для аркуша: ${targetSheets[0]}`);
	console.log(`Активних запитів знайдено: ${activeTransactions.length}\n`);

	setInterval(async () => {
		cacheCountdown--;
		psCountdown--;

		if (cacheCountdown <= 0) {
			cacheCountdown = 300;
			try {
				await updateCacheShared(mainDoc, targetSheets);
				const now = new Date().toLocaleTimeString('uk-UA');
				console.log(`[${now}] Кеш оновлено. Активних запитів: ${activeTransactions.length}`);
			} catch (error) {
				console.error('Помилка оновлення кешу:', error.message);
			}
		}

		if (psCountdown <= 0) {
			psCountdown = 300;
			if (activeTransactions.length > 0) {
				try {
					await checkExternalPsUpdates(mainDoc, externalDoc, activeTransactions);
				} catch (error) {
					console.error(error);
				}
			}
		}

		const cM = Math.floor(cacheCountdown / 60).toString().padStart(2, '0');
		const cS = (cacheCountdown % 60).toString().padStart(2, '0');

		const pM = Math.floor(psCountdown / 60).toString().padStart(2, '0');
		const pS = (psCountdown % 60).toString().padStart(2, '0');

		process.stdout.write(`\x1b[2K\rОновлення кешу через: ${cM}:${cS} | Перевірка ПС через: ${pM}:${pS}`);
	}, 1000);

	await slackApp.start();
}

main();
