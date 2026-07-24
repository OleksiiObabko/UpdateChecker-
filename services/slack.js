const { App } = require('@slack/bolt');
const state = require('./state');
const { initGoogleSheets, updateTransactionStatus } = require('./googleSheets');
const { logStatusChange } = require('./statusLog');

function createSlackApp() {
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
			if (!match) return;

			const transactionId = match[1];
			const matchedTx = state.activeTransactions.find(tx => tx.transactionId === transactionId);

			if (matchedTx) {
				const previousStatus = matchedTx.status;
				const doc = await initGoogleSheets();
				const ok = await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, 'update');
				if (ok) {
					logStatusChange('Slack, live', matchedTx, previousStatus, 'update');
					matchedTx.status = 'update';
					if (state.stats) state.stats.updatesProvided++;
				}
			}
		} catch (error) {
			console.error('Помилка обробки Slack-повідомлення:', error);
		}
	});

	return slackApp;
}

async function runSlackBackfill(doc, client) {
	const slackPsList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	if (slackPsList.length === 0) return;

	const targetTxs = state.activeTransactions.filter(tx => {
		const ps = (tx.psName || '').toString().trim().toLowerCase();
		const st = (tx.status || '').toString().trim().toLowerCase();
		return slackPsList.includes(ps) && (st === '' || st === 'in progress');
	});

	if (targetTxs.length === 0) return;

	console.log(`Бекфіл Slack: перевіряю ${targetTxs.length} транзакцій...`);

	for (const tx of targetTxs) {
		try {
			const searchRes = await client.search.messages({
				query: tx.transactionId,
				count: 1,
				sort: 'timestamp',
				sort_dir: 'desc',
				token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN
			});

			if (!searchRes.messages || !searchRes.messages.matches || searchRes.messages.matches.length === 0) continue;

			const msg = searchRes.messages.matches[0];
			if (!msg.channel || !msg.channel.id || !msg.ts) continue;

			const threadRes = await client.conversations.replies({
				channel: msg.channel.id,
				ts: msg.ts
			});

			if (!threadRes.messages || threadRes.messages.length <= 1) continue;

			const lastReply = threadRes.messages[threadRes.messages.length - 1];
			const isFromUs = lastReply.user === process.env.OUR_SLACK_USER_ID;

			if (!isFromUs) {
				const previousStatus = tx.status;
				const ok = await updateTransactionStatus(doc, tx.sheetName, tx.transactionId, 'update');
				if (ok) {
					logStatusChange('Slack, бекфіл', tx, previousStatus, 'update');
					tx.status = 'update';
					if (state.stats) state.stats.updatesProvided++;
				}
			}
		} catch (err) {
			console.error(`Помилка бекфілу Slack для ${tx.transactionId}:`, err.message);
		}
	}
}

module.exports = { createSlackApp, runSlackBackfill };
