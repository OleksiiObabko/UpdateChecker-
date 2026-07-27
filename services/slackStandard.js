const { applyStatusFromMatch } = require('./slackUtils');

async function handleStandardSlackMessage(message, matchedTx, isReply, ourUserId) {
	const isFromUs = message.user === ourUserId;
	if (!isReply && !isFromUs) return;
	const newStatus = isFromUs ? 'in progress' : 'update';
	await applyStatusFromMatch('Slack [Standard], live', matchedTx, newStatus);
}

async function processStandardBackfillThread(tx, ourUserId, threadMessages) {
	if (!threadMessages || threadMessages.length === 0) return;

	if (threadMessages.length === 1) {
		const isFromUs = threadMessages[0].user === ourUserId;
		if (isFromUs) {
			await applyStatusFromMatch('Slack [Standard], backfill (новий)', tx, 'in progress');
		}
		return;
	}

	const lastReply = threadMessages[threadMessages.length - 1];
	const isFromUs = lastReply.user === ourUserId;
	const newStatus = isFromUs ? 'in progress' : 'update';

	await applyStatusFromMatch('Slack [Standard], backfill', tx, newStatus);
}

module.exports = { handleStandardSlackMessage, processStandardBackfillThread };
