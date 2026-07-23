function logStatusChange(source, tx, previousStatus, newStatus) {
	const before = previousStatus || 'порожньо';
	console.log(`[${source}] Транзакція ${tx.transactionId} (${tx.sheetName}): "${before}" → "${newStatus}"`);
}

module.exports = { logStatusChange };
