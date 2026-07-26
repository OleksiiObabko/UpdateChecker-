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
			if (!matchedTx) return;

			const isFromUs = message.user === process.env.OUR_SLACK_USER_ID;
			const newStatus = isFromUs ? 'in progress' : 'update';

			const currentStatus = (matchedTx.status || '').toString().trim().toLowerCase();
			if (currentStatus === newStatus) return;

			const previousStatus = matchedTx.status;
			const doc = await initGoogleSheets();
			const ok = await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, newStatus);
			if (ok) {
				logStatusChange('Slack, live', matchedTx, previousStatus, newStatus);
				matchedTx.status = newStatus;
				if (state.stats) state.stats.updatesProvided++;
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
		return slackPsList.includes(ps) && (st === '' || st === 'in progress' || st === 'update');
	});

	if (targetTxs.length === 0) return;

	console.log(`Бекфіл Slack: перевіряю ${targetTxs.length} транзакцій...`);

	for (const tx of targetTxs) {
		try {
			const searchRes = await client.search.messages({
				query: tx.transactionId,
				count: 20,
				sort: 'timestamp',
				sort_dir: 'desc',
				token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN
			});

			const searchMatches = searchRes.messages && searchRes.messages.matches ? searchRes.messages.matches : [];
			if (searchMatches.length === 0) continue;

			// Кожен збіг міг бути реплаєм — справжній корінь треду це msg.thread_ts (якщо є), інакше сам msg.ts.
			// Дедуплікуємо, щоб не смикати той самий тред двічі.
			const rootCandidates = new Map(); // "channelId|rootTs" -> {channelId, rootTs}
			for (const msg of searchMatches) {
				if (!msg.channel || !msg.channel.id) continue;
				const rootTs = msg.thread_ts || msg.ts;
				rootCandidates.set(`${msg.channel.id}|${rootTs}`, { channelId: msg.channel.id, rootTs });
			}

			for (const { channelId, rootTs } of rootCandidates.values()) {
				const threadRes = await client.conversations.replies({ channel: channelId, ts: rootTs });

				if (!threadRes.messages || threadRes.messages.length <= 1) continue;

				// Перевіряємо, що це справді "наш" тред по цій транзакції — ID має бути в кореневому повідомленні
				const parentText = threadRes.messages[0].text || '';
				if (!parentText.includes(tx.transactionId)) continue;

				const lastReply = threadRes.messages[threadRes.messages.length - 1];
				const isFromUs = lastReply.user === process.env.OUR_SLACK_USER_ID;
				const newStatus = isFromUs ? 'in progress' : 'update';

				const currentStatus = (tx.status || '').toString().trim().toLowerCase();
				if (currentStatus === newStatus) break;

				const ok = await updateTransactionStatus(doc, tx.sheetName, tx.transactionId, newStatus);
				if (ok) {
					logStatusChange('Slack, бекфіл', tx, currentStatus, newStatus);
					tx.status = newStatus;
					if (state.stats) state.stats.updatesProvided++;
				}
				break; // знайшли й обробили правильний тред — далі не треба
			}
		} catch (err) {
			console.error(`Помилка бекфілу Slack для ${tx.transactionId}:`, err.message);
		}
	}
}

module.exports = { createSlackApp, runSlackBackfill };
