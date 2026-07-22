require('dotenv').config();
const { App } = require('@slack/bolt');
const { initGoogleSheets, fetchActiveTransactions, updateTransactionStatus } = require('./googleSheets');

let activeTransactions = [];
const targetSheets = ['Вулик'];
let fetchPromise = null;

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

		console.log(`PARENT TEXT: ${parentMessage.text}`);

		const match = parentMessage.text.match(/\b(\d+)\b/);

		if (match) {
			const transactionId = match[1];
			console.log(`EXTRACTED ID: ${transactionId}`);

			const matchedTx = activeTransactions.find(tx => tx.transactionId === transactionId);

			if (matchedTx) {
				console.log(`MATCHED TX: ${transactionId}, Updating...`);
				const doc = await initGoogleSheets();
				await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.rowIndex, 'update');
				matchedTx.status = 'update';
				console.log(`UPDATED TX: ${transactionId}`);
			} else {
				console.log(`NOT FOUND IN CACHE: ${transactionId}`);
				console.log('CURRENT CACHE:', activeTransactions);
			}
		} else {
			console.log('NO ID MATCHED IN PARENT TEXT');
		}
	} catch (error) {
		console.error('SLACK API ERROR:', error);
	}
});

async function main() {
	const doc = await initGoogleSheets();
	await updateCacheShared(doc, targetSheets);

	setInterval(async () => {
		await updateCacheShared(doc, targetSheets);
	}, 5 * 60 * 1000);

	await slackApp.start();
	console.log('Slack bot started');
}

main();
