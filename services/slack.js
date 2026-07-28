const { App } = require('@slack/bolt');
const state = require('./state');
const { resolveTransactionById } = require('./slackUtils');
const { handleStandardSlackMessage, processStandardBackfillThread } = require('./slackStandard');
const { handleTicketSlackMessage, processTicketBackfillThread } = require('./slackTicket');

function getPsType(psNameRaw) {
	const psName = (psNameRaw || '').toString().trim().toLowerCase();
	const standardList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const ticketList = process.env.SLACK_TICKET_PS ? process.env.SLACK_TICKET_PS.split(',').map(s => s.trim().toLowerCase()) : [];

	if (standardList.includes(psName)) return 'standard';
	if (ticketList.includes(psName)) return 'ticket';
	return null;
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

			const match = parentText.match(/\b([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}|\d+)\b/);
			if (!match) return;

			const transactionId = match[1];
			const matchedTx = await resolveTransactionById(transactionId);
			if (!matchedTx) return;

			const psType = getPsType(matchedTx.psName);
			if (!psType) return;

			const ourUserId = process.env.OUR_SLACK_USER_ID;

			if (psType === 'standard') {
				await handleStandardSlackMessage(message, matchedTx, isReply, ourUserId);
			} else if (psType === 'ticket') {
				await handleTicketSlackMessage(message, matchedTx, isReply, ourUserId);
			}
		} catch (error) {
			process.stdout.write(`\x1b[2K\rПомилка обробки Slack-повідомлення: ${error.message}\n`);
		}
	});

	return slackApp;
}

async function runSlackBackfill(doc, client) {
	const standardList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const ticketList = process.env.SLACK_TICKET_PS ? process.env.SLACK_TICKET_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const allSlackPs = [...standardList, ...ticketList];

	if (allSlackPs.length === 0) return;

	const targetTxs = state.activeTransactions.filter(tx => {
		const ps = (tx.psName || '').toString().trim().toLowerCase();
		const st = (tx.status || '').toString().trim().toLowerCase();
		return allSlackPs.includes(ps) && (st === '' || st === 'in progress' || st === 'update');
	});

	if (targetTxs.length === 0) return;

	process.stdout.write(`\x1b[2K\rБекфіл Slack: перевіряю ${targetTxs.length} транзакцій...\n`);

	for (const tx of targetTxs) {
		try {
			const searchRes = await client.search.messages({
				query: `"${tx.transactionId}"`,
				count: 20,
				sort: 'timestamp',
				sort_dir: 'desc',
				token: process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN
			});

			const searchMatches = searchRes.messages && searchRes.messages.matches ? searchRes.messages.matches : [];

			if (searchMatches.length > 0) {
				const rootCandidates = new Map();
				for (const msg of searchMatches) {
					if (!msg.channel || !msg.channel.id) continue;
					const rootTs = msg.thread_ts || msg.ts;
					rootCandidates.set(`${msg.channel.id}|${rootTs}`, { channelId: msg.channel.id, rootTs });
				}

				for (const { channelId, rootTs } of rootCandidates.values()) {
					const threadRes = await client.conversations.replies({ channel: channelId, ts: rootTs });

					if (!threadRes.messages || threadRes.messages.length === 0) continue;

					const parentText = (threadRes.messages[0].text || '').toLowerCase();
					if (!parentText.includes(tx.transactionId.toString().toLowerCase())) continue;

					const psType = getPsType(tx.psName);
					const ourUserId = process.env.OUR_SLACK_USER_ID;

					if (psType === 'standard') {
						await processStandardBackfillThread(tx, ourUserId, threadRes.messages);
					} else if (psType === 'ticket') {
						await processTicketBackfillThread(tx, ourUserId, threadRes.messages);
					}
					break;
				}
			}
		} catch (err) {
			process.stdout.write(`\x1b[2K\rПомилка бекфілу Slack для ${tx.transactionId}: ${err.message}\n`);
		}

		await new Promise(resolve => setTimeout(resolve, 4500));
	}

	process.stdout.write(`\x1b[2K\rБекфіл Slack: успішно завершено.\n`);
}

module.exports = { createSlackApp, runSlackBackfill };
