const { applyStatusFromMatch } = require('./slackUtils');

function isIgnoredBot(message) {
	const name = message.username || (message.bot_profile && message.bot_profile.name) || '';
	return name.includes('Augustus Customer Support');
}

async function handleTicketSlackMessage(message, matchedTx, isReply, ourUserId) {
	if (isIgnoredBot(message)) return;

	const isFromUs = message.user === ourUserId;
	if (!isReply && !isFromUs) return;

	const newStatus = isFromUs ? 'in progress' : 'update';
	await applyStatusFromMatch('Slack [Ticket], live', matchedTx, newStatus);
}

async function processTicketBackfillThread(tx, ourUserId, threadMessages) {
	const validMessages = threadMessages.filter(m => !isIgnoredBot(m));

	if (validMessages.length === 0) return;

	if (validMessages.length === 1) {
		const isFromUs = validMessages[0].user === ourUserId;
		if (isFromUs) {
			await applyStatusFromMatch('Slack [Ticket], backfill (новий)', tx, 'in progress');
		}
		return;
	}

	const lastReply = validMessages[validMessages.length - 1];
	const isFromUs = lastReply.user === ourUserId;
	const newStatus = isFromUs ? 'in progress' : 'update';

	await applyStatusFromMatch('Slack [Ticket], backfill', tx, newStatus);
}

module.exports = { handleTicketSlackMessage, processTicketBackfillThread };
