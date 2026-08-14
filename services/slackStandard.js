const { applyStatusFromMatch } = require('./slackUtils');

async function handleStandardSlackMessage(doc, message, matchedTx, isReply, ourUserId) {
	const isFromUs = message.user === ourUserId;
	if (!isReply && !isFromUs) return;
	const newStatus = isFromUs ? 'in progress' : 'update';
	await applyStatusFromMatch(doc, 'Slack [Standard], live', matchedTx, newStatus);
}

async function processStandardBackfillThread(doc, tx, ourUserId, threadMessages) {
	if (!threadMessages || threadMessages.length === 0) return;

	if (threadMessages.length === 1) {
		const isFromUs = threadMessages[0].user === ourUserId;
		if (isFromUs) {
			await applyStatusFromMatch(doc, 'Slack [Standard], backfill (новий)', tx, 'in progress');
		}
		return;
	}

	const lastReply = threadMessages[threadMessages.length - 1];
	const isFromUs = lastReply.user === ourUserId;
	const hasReaction = lastReply.reactions && lastReply.reactions.length > 0;
	const newStatus = (isFromUs || hasReaction) ? 'in progress' : 'update';

	await applyStatusFromMatch(doc, 'Slack [Standard], backfill', tx, newStatus);
}

module.exports = { handleStandardSlackMessage, processStandardBackfillThread };
