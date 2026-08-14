const state = require('./state');
const { updateTransactionStatus, findTransactionAnySheet } = require('./googleSheets');
const { logStatusChange } = require('./statusLog');

async function resolveTransactionById(doc, transactionId) {
	if (!transactionId) return null;

	let matchedTx = state.activeTransactions.find(tx =>
		tx.transactionId && tx.transactionId.toString().trim() === transactionId.toString().trim()
	);
	if (matchedTx) return matchedTx;

	if (!state.targetSheets || state.targetSheets.length === 0) return null;

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

	state.activeTransactions.push(matchedTx);
	return matchedTx;
}

async function applyStatusFromMatch(doc, source, matchedTx, newStatus) {
	if (!matchedTx) return;

	const currentStatus = (matchedTx.status || '').toString().trim().toLowerCase();
	const targetStatus = newStatus.toString().trim().toLowerCase();

	if (currentStatus === targetStatus) return;

	const previousStatus = matchedTx.status;
	matchedTx.status = targetStatus;
	matchedTx.lastStatusChange = Date.now();

	try {
		const ok = await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, targetStatus);
		if (ok) {
			logStatusChange(source, matchedTx, previousStatus, targetStatus);
			if (state.stats) state.stats.updatesProvided++;
		}
	} catch (error) {
		process.stdout.write(`\x1b[2K\rПомилка оновлення Google Таблиці для ${matchedTx.transactionId}: ${error.message}\n`);
	}
}

module.exports = {
	resolveTransactionById,
	applyStatusFromMatch
};
