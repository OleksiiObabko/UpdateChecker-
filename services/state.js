const txLocks = new Map();

function runWithLock(transactionId, fn) {
	const prevLock = txLocks.get(transactionId) || Promise.resolve();
	const nextLock = prevLock.then(fn, fn);
	txLocks.set(transactionId, nextLock.catch(() => {}));
	return nextLock;
}

const state = {
	activeTransactions: [],
	fetchPromise: null,
	targetSheets: [],
	stats: {
		updatesProvided: 0
	},
	runWithLock
};

module.exports = state;
