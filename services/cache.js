const state = require('./state');
const { fetchActiveTransactions } = require('./googleSheets');

async function updateCacheShared(doc, sheets) {
	if (state.fetchPromise) {
		return state.fetchPromise;
	}
	state.fetchPromise = fetchActiveTransactions(doc, sheets)
		.then(txs => {
			state.activeTransactions = txs;
			return txs;
		})
		.finally(() => {
			state.fetchPromise = null;
		});
	return state.fetchPromise;
}

module.exports = { updateCacheShared };
