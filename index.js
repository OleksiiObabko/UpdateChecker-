require('dotenv').config();
const { App } = require('@slack/bolt');
const {
	initGoogleSheets,
	fetchActiveTransactions,
	updateTransactionStatus,
	initExternalSheets,
	checkExternalPsUpdates
} = require('./services/googleSheets');

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

		const match = parentMessage.text.match(/\b(\d+)\b/);

		if (match) {
			const transactionId = match[1];
			const matchedTx = activeTransactions.find(tx => tx.transactionId === transactionId);

			if (matchedTx) {
				console.log(`Matched INCOMING Slack message for TX: ${transactionId}`);
				const doc = await initGoogleSheets();
				await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.rowIndex, 'update');
				matchedTx.status = 'update';
			}
		}
	} catch (error) {
		console.error(error);
	}
});

async function main() {
	const mainDoc = await initGoogleSheets();
	const externalDoc = await initExternalSheets();

	await updateCacheShared(mainDoc, targetSheets);

	setInterval(async () => {
		await updateCacheShared(mainDoc, targetSheets);
	}, 5 * 60 * 1000);

	setInterval(async () => {
		if (activeTransactions.length > 0) {
			try {
				await checkExternalPsUpdates(mainDoc, externalDoc, activeTransactions);
			} catch (error) {
				console.error('Error checking external PS:', error);
			}
		}
	}, 20 * 60 * 1000);

	await slackApp.start();
	console.log('Slack bot started');
}

main();
