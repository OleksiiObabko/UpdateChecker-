const { App } = require('@slack/bolt');
const state = require('./state');
const { initGoogleSheets, updateTransactionStatus, findTransactionAnySheet } = require('./googleSheets');
const { logStatusChange } = require('./statusLog');

async function applyStatusFromMatch(source, matchedTx, newStatus) {
	const currentStatus = (matchedTx.status || '').toString().trim().toLowerCase();
	if (currentStatus === newStatus) return;

	const previousStatus = matchedTx.status;
	const doc = await initGoogleSheets();
	const ok = await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, newStatus);
	if (ok) {
		logStatusChange(source, matchedTx, previousStatus, newStatus);
		matchedTx.status = newStatus;
		if (state.stats) state.stats.updatesProvided++;
	}
}

// Шукає транзакцію в кеші; якщо не знайдено — шукає напряму в Google Таблиці
// (покриває щойно створені рядки, які ще не потрапили в state.activeTransactions).
async function resolveTransactionById(transactionId) {
	let matchedTx = state.activeTransactions.find(tx => tx.transactionId === transactionId);
	if (matchedTx) return matchedTx;

	if (!state.targetSheets || state.targetSheets.length === 0) return null;

	const doc = await initGoogleSheets();
	const found = await findTransactionAnySheet(doc, state.targetSheets, transactionId);
	if (!found) return null;

	const psNameRaw = found.row.get('ПС');
	const cpayRaw = found.row.get('Cpay');
	const statusRaw = found.row.get('Статус');

	matchedTx = {
		transactionId,
		psName: psNameRaw,
		cpay: cpayRaw ? cpayRaw.toString().trim() : '',
		sheetName: found.sheetName,
		status: statusRaw ? statusRaw.toString().trim().toLowerCase() : ''
	};

	// Додаємо в кеш одразу — щоб наступні повідомлення (і Telegram-хендлер теж) бачили її без затримки
	state.activeTransactions.push(matchedTx);

	return matchedTx;
}

function createSlackApp() {
	const slackApp = new App({
		token: process.env.SLACK_BOT_TOKEN,
		appToken: process.env.SLACK_APP_TOKEN,
		socketMode: true
	});

	slackApp.message(async ({ message, client }) => {
		if (message.subtype === 'message_changed' || message.subtype === 'message_deleted') return;

		try {
			const isReply = message.thread_ts && message.ts !== message.thread_ts;
			let parentText = '';

			if (isReply) {
				const threadData = await client.conversations.replies({
					channel: message.channel,
					ts: message.thread_ts,
					limit: 1
				});
				const parentMessage = threadData.messages[0];
				if (!parentMessage || !parentMessage.text) return;
				parentText = parentMessage.text;
			} else {
				if (!message.text) return;
				parentText = message.text;
			}

			const match = parentText.match(/\b(\d+)\b/);
			if (!match) return;

			const transactionId = match[1];
			const matchedTx = await resolveTransactionById(transactionId);
			if (!matchedTx) return;

			const senderId = message.user;
			if (!senderId) return;

			const isFromUs = senderId === process.env.OUR_SLACK_USER_ID;

			// Для кореневого повідомлення без реплая — тригеримо лише якщо це МИ подали запит
			if (!isReply && !isFromUs) return;

			const newStatus = isFromUs ? 'in progress' : 'update';
			await applyStatusFromMatch('Slack, live', matchedTx, newStatus);
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

			const rootCandidates = new Map();
			for (const msg of searchMatches) {
				if (!msg.channel || !msg.channel.id) continue;
				const rootTs = msg.thread_ts || msg.ts;
				rootCandidates.set(`${msg.channel.id}|${rootTs}`, { channelId: msg.channel.id, rootTs });
			}

			for (const { channelId, rootTs } of rootCandidates.values()) {
				const threadRes = await client.conversations.replies({ channel: channelId, ts: rootTs });

				if (!threadRes.messages || threadRes.messages.length === 0) continue;

				const parentText = threadRes.messages[0].text || '';
				if (!parentText.includes(tx.transactionId)) continue;

				if (threadRes.messages.length === 1) {
					const isFromUs = threadRes.messages[0].user === process.env.OUR_SLACK_USER_ID;
					if (isFromUs) {
						await applyStatusFromMatch('Slack, бекфіл (новий запит)', tx, 'in progress');
					}
					break;
				}

				const lastReply = threadRes.messages[threadRes.messages.length - 1];
				const isFromUs = lastReply.user === process.env.OUR_SLACK_USER_ID;
				const newStatus = isFromUs ? 'in progress' : 'update';

				await applyStatusFromMatch('Slack, бекфіл', tx, newStatus);
				break;
			}
		} catch (err) {
			console.error(`Помилка бекфілу Slack для ${tx.transactionId}:`, err.message);
		}
	}

	console.log('Бекфіл Slack: успішно завершено.');
}

module.exports = { createSlackApp, runSlackBackfill };
