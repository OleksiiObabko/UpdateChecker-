require('dotenv').config();
const prompts = require('prompts');
const { initGoogleSheets, fetchActiveTransactions, updateTransactionStatus } = require('./services/googleSheets');
const { initTelegram } = require('./services/telegram');
const psChatMap = require('./chatMap.json');
const { NewMessage } = require('telegram/events');

let activeTransactions = [];
let globalMessageCache = new Map();
let targetSheets = [];

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
	const allAvailableSheets = ['Дракони', 'Лелеки', 'Корови', 'Вулик', 'Джира', 'КитиЛевіафан', 'Нексус'];

	const response = await prompts({
		type: 'multiselect',
		name: 'selectedSheets',
		message: 'Оберіть аркуші для моніторингу (Стрілки - навігація, Пробіл - вибір, Enter - підтвердити):',
		choices: allAvailableSheets.map(sheet => ({ title: sheet, value: sheet })),
		min: 1
	});

	if (!response.selectedSheets) {
		console.log('Вихід: аркуші не обрано.');
		process.exit(0);
	}

	targetSheets = response.selectedSheets;

	console.log(`Обрані аркуші: ${targetSheets.join(', ')}`);
	console.log('Starting application...');

	const doc = await initGoogleSheets();

	activeTransactions = await fetchActiveTransactions(doc, targetSheets);
	console.log('Active transactions fetched:', activeTransactions.length);

	setInterval(async () => {
		console.log('Updating active transactions cache...');
		activeTransactions = await fetchActiveTransactions(doc, targetSheets);
		console.log('Active transactions fetched:', activeTransactions.length);
	}, 5 * 60 * 1000);

	const client = await initTelegram();
	console.log('Telegram client initialized and listening for messages.');

	client.addEventHandler(async (event) => {
		const message = event.message;
		if (!message) return;

		const chatId = Number(message.chatId);
		const isKnownChat = Object.values(psChatMap).includes(chatId);
		if (!isKnownChat) return;

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

		if (message.out) {
			if (matchedTx) {
				globalMessageCache.set(message.id, matchedTx);
				console.log(`Matched OUTGOING message. TransactionID: ${matchedTx.transactionId}`);

				try {
					await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.rowIndex, 'in progress');
					console.log('Google Sheet updated to in progress.');

					console.log('Force updating active transactions cache...');
					activeTransactions = await fetchActiveTransactions(doc, targetSheets);
					console.log('Active transactions fetched:', activeTransactions.length);
				} catch (error) {
					console.log('Error reverting status:', error);
				}
			} else {
				console.log('Force updating active transactions cache after unknown outgoing message...');
				activeTransactions = await fetchActiveTransactions(doc, targetSheets);
				console.log('Active transactions fetched:', activeTransactions.length);

				for (const tx of activeTransactions) {
					if (message.message && message.message.includes(tx.transactionId)) {
						globalMessageCache.set(message.id, tx);
						console.log(`Saved outgoing message to cache. MsgID: ${message.id}, TransactionID: ${tx.transactionId}`);
						break;
					}
				}
			}
		} else {
			if (matchedTx) {
				globalMessageCache.set(message.id, matchedTx);
				console.log(`Matched INCOMING message. TransactionID: ${matchedTx.transactionId}`);

				try {
					await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.rowIndex, 'update');
					console.log('Google Sheet updated to update.');
				} catch (error) {
					console.log('Error updating Google Sheet:', error);
				}
			} else {
				console.log('No matching transaction found for this message.');
			}
		}
	}, new NewMessage({}));
}

main();
