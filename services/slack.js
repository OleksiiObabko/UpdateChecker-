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
					logStatusChange('Slack', matchedTx, previousStatus, 'update');
					matchedTx.status = 'update';
				}
			}
		} catch (error) {
			console.error('Помилка обробки Slack-повідомлення:', error);
		}
	});

	return slackApp;
}

module.exports = { createSlackApp };
