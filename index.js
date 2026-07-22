require('dotenv').config();
const { initGoogleSheets, fetchActiveTransactions, updateTransactionStatus } = require('./services/googleSheets');
const { initTelegramClients } = require('./services/telegram');
const { NewMessage } = require('telegram/events');

let activeTransactions = [];
let globalMessageCache = new Map();
const targetSheets = ['Вулик'];
let fetchPromise = null;
const handledMessages = new Set();

const knownChatIds = (process.env.KNOWN_CHAT_IDS || '')
	.split(/[\n,]+/)
	.map(line => {
		const match = line.match(/-?\d+/);
		return match ? Number(match[0]) : NaN;
	})
	.filter(id => !isNaN(id) && id !== 0);



async function updateCacheShared(doc, sheets) {
	if (fetchPromise) {
		return fetchPromise;
	}
	fetchPromise = fetchActiveTransactions(doc, sheets)
		.then(txs => {
			activeTransactions = txs;
			return txs;
		})
		.finally(() => {
			fetchPromise = null;
		});
	return fetchPromise;
}

async function resolveTransactionFromReply(client, chatId, replyToMsgId, depth = 0) {
	if (depth > 3) return null;

	if (globalMessageCache.has(replyToMsgId)) {
		return globalMessageCache.get(replyToMsgId);
	}

	try {
		const msgs = await client.getMessages(chatId, { ids: [replyToMsgId] });
		if (msgs && msgs.length > 0) {
			const msg = msgs[0];
			if (msg && msg.message) {
				const allKnownTxs = [...activeTransactions, ...Array.from(globalMessageCache.values())];
				for (const tx of allKnownTxs) {
					if (msg.message.includes(tx.transactionId)) {
						globalMessageCache.set(replyToMsgId, tx);
						return tx;
					}
				}
			}
			if (msg && msg.replyTo) {
				return await resolveTransactionFromReply(client, chatId, msg.replyTo.replyToMsgId, depth + 1);
			}
		}
	} catch (err) {
		console.log('Error fetching original message:', err);
	}
	return null;
}

async function main() {
	console.log(`Обрані аркуші: ${targetSheets.join(', ')}`);

	const doc = await initGoogleSheets();

	await updateCacheShared(doc, targetSheets);
	console.log('Active transactions fetched:', activeTransactions.length);

	setInterval(async () => {
		await updateCacheShared(doc, targetSheets);
		console.log('Active transactions fetched:', activeTransactions.length);
	}, 5 * 60 * 1000);

	const { clients, ourUserIds } = await initTelegramClients();
	console.log(`Initialized ${clients.length} Telegram clients.`);

	const messageHandler = (client) => async (event) => {
		const message = event.message;
		if (!message) return;

		const chatId = Number(message.chatId);
		const isKnownChat = knownChatIds.includes(chatId);
		if (!isKnownChat) return;

		const msgKey = `${chatId}_${message.id}`;
		if (handledMessages.has(msgKey)) return;
		handledMessages.add(msgKey);

		if (handledMessages.size > 2000) {
			const iterator = handledMessages.values();
			for (let i = 0; i < 500; i++) {
				handledMessages.delete(iterator.next().value);
			}
		}

		const senderId = message.senderId ? message.senderId.toString() : null;
		const isFromUs = ourUserIds.includes(senderId);

		let matchedTx = null;

		if (!matchedTx && message.message) {
			for (const [msgId, tx] of globalMessageCache.entries()) {
				if (message.message.includes(tx.transactionId)) {
					matchedTx = tx;
					break;
				}
			}
			if (!matchedTx) {
				for (const tx of activeTransactions) {
					if (message.message.includes(tx.transactionId)) {
						matchedTx = tx;
						break;
					}
				}
			}
		}

		if (!matchedTx && message.replyTo) {
			matchedTx = await resolveTransactionFromReply(client, chatId, message.replyTo.replyToMsgId);
		}

		if (isFromUs) {
			if (!matchedTx && message.message) {
				await updateCacheShared(doc, targetSheets);

				for (const tx of activeTransactions) {
					if (message.message.includes(tx.transactionId)) {
						matchedTx = tx;
						break;
					}
				}
			}

			if (matchedTx) {
				globalMessageCache.set(message.id, matchedTx);
				console.log(`Matched OUTGOING message from team. TransactionID: ${matchedTx.transactionId}`);

				try {
					await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.rowIndex, 'in progress');

					const txIndex = activeTransactions.findIndex(tx => tx.transactionId === matchedTx.transactionId);
					if (txIndex !== -1) {
						activeTransactions[txIndex].status = 'in progress';
					}
				} catch (error) {
					console.log('Error updating status:', error);
				}
			}
		} else {
			if (matchedTx) {
				globalMessageCache.set(message.id, matchedTx);
				console.log(`Matched INCOMING message from PS. TransactionID: ${matchedTx.transactionId}`);

				try {
					await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.rowIndex, 'update');

					const txIndex = activeTransactions.findIndex(tx => tx.transactionId === matchedTx.transactionId);
					if (txIndex !== -1) {
						activeTransactions[txIndex].status = 'update';
					}
				} catch (error) {
					console.log('Error updating Google Sheet:', error);
				}
			}
		}
	};

	for (const client of clients) {
		client.addEventHandler(messageHandler(client), new NewMessage({}));
	}
}

main();
