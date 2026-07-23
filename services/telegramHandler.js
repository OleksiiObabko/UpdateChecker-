const state = require('./state');
const { updateTransactionStatus } = require('./googleSheets');
const { logStatusChange } = require('./statusLog');

const BACKFILL_DAYS = Number(process.env.TELEGRAM_BACKFILL_DAYS || 60);

// Формат рядка в KNOWN_CHAT_IDS: -123123123 (Назва ПС)
const psChatMap = new Map();
const knownChatIds = [];

(process.env.KNOWN_CHAT_IDS || '')
	.split('\n')
	.map(line => line.trim())
	.filter(line => line.length > 0)
	.forEach(line => {
		const idMatch = line.match(/-?\d+/);
		const nameMatch = line.match(/\(([^)]+)\)/);

		if (!idMatch) return;
		const chatId = Number(idMatch[0]);
		knownChatIds.push(chatId);

		if (nameMatch) {
			const psName = nameMatch[1].trim().toLowerCase();
			if (!psChatMap.has(psName)) psChatMap.set(psName, []);
			psChatMap.get(psName).push(chatId);
		}
	});

function getPsNameForChat(chatId) {
	for (const [psName, chatIds] of psChatMap.entries()) {
		if (chatIds.includes(chatId)) return psName;
	}
	return null;
}

const globalMessageCache = new Map();
const handledMessages = new Set();

async function resolveTransactionFromReply(client, chatId, replyToMsgId, candidateTxs, depth = 0) {
	if (depth > 3) return null;

	if (globalMessageCache.has(replyToMsgId)) {
		return globalMessageCache.get(replyToMsgId);
	}

	try {
		const msgs = await client.getMessages(chatId, { ids: [replyToMsgId] });
		if (msgs && msgs.length > 0) {
			const msg = msgs[0];
			if (msg && msg.message) {
				const allKnownTxs = [...candidateTxs, ...Array.from(globalMessageCache.values())];
				for (const tx of allKnownTxs) {
					if (msg.message.includes(tx.transactionId)) {
						globalMessageCache.set(replyToMsgId, tx);
						return tx;
					}
				}
			}
			if (msg && msg.replyTo) {
				return await resolveTransactionFromReply(client, chatId, msg.replyTo.replyToMsgId, candidateTxs, depth + 1);
			}
		}
	} catch (err) {
		console.error('Помилка отримання оригінального повідомлення:', err);
	}
	return null;
}

// Обробка ОДНОГО live-повідомлення — статус пишеться відразу, бо нові повідомлення приходять
// по одному й у хронологічному порядку, тож "останнє" завжди й так є найсвіжіший стан.
async function processTelegramMessage(doc, client, chatId, message, ourUserIds, candidateTxs) {
	if (!message) return;

	const msgKey = `${chatId}_${message.id}`;
	if (handledMessages.has(msgKey)) return;
	handledMessages.add(msgKey);

	if (handledMessages.size > 5000) {
		const iterator = handledMessages.values();
		for (let i = 0; i < 1000; i++) {
			handledMessages.delete(iterator.next().value);
		}
	}

	const senderId = message.senderId ? message.senderId.toString() : null;
	const isFromUs = ourUserIds.includes(senderId);

	let matchedTx = null;

	if (message.message) {
		for (const [, tx] of globalMessageCache.entries()) {
			if (message.message.includes(tx.transactionId)) {
				matchedTx = tx;
				break;
			}
		}
		if (!matchedTx) {
			for (const tx of candidateTxs) {
				if (message.message.includes(tx.transactionId)) {
					matchedTx = tx;
					break;
				}
			}
		}
	}

	if (!matchedTx && message.replyTo) {
		matchedTx = await resolveTransactionFromReply(client, chatId, message.replyTo.replyToMsgId, candidateTxs);
	}

	if (!matchedTx) return;

	globalMessageCache.set(message.id, matchedTx);
	const newStatus = isFromUs ? 'in progress' : 'update';

	const currentStatus = (matchedTx.status || '').toString().trim().toLowerCase();
	if (currentStatus === newStatus) return;

	try {
		const ok = await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, newStatus);
		if (ok) {
			logStatusChange('Telegram, live', matchedTx, currentStatus, newStatus);
			matchedTx.status = newStatus;

			const txIndex = state.activeTransactions.findIndex(tx => tx.transactionId === matchedTx.transactionId);
			if (txIndex !== -1) state.activeTransactions[txIndex].status = newStatus;
		}
	} catch (error) {
		console.error('Помилка оновлення статусу (Telegram, live):', error);
	}
}

function makeTelegramMessageHandler(doc, client, ourUserIds) {
	return async (event) => {
		const message = event.message;
		if (!message) return;

		const chatId = Number(message.chatId);
		if (!knownChatIds.includes(chatId)) return;

		const chatPsName = getPsNameForChat(chatId);
		const candidateTxs = chatPsName
			? state.activeTransactions.filter(tx => (tx.psName || '').toString().trim().toLowerCase() === chatPsName)
			: state.activeTransactions;

		await processTelegramMessage(doc, client, chatId, message, ourUserIds, candidateTxs);
	};
}

async function findTransactionMessagesInChat(client, chatId, transactionId, cutoffTimestamp) {
	try {
		const results = await client.getMessages(chatId, {
			search: transactionId,
			limit: 20
		});
		return results.filter(msg => msg.date && msg.date >= cutoffTimestamp);
	} catch (error) {
		console.error(`Помилка пошуку "${transactionId}" в чаті ${chatId}:`, error.message);
		return [];
	}
}

// Дивимось ЛИШЕ на останнє (найновіше) повідомлення в зібраній переписці по транзакції —
// пишемо в таблицю щонайбільше один раз, замість реакції на кожне повідомлення по черзі.
async function applyFinalStatusFromMessages(doc, tx, messages, ourUserIds) {
	if (messages.length === 0) return false;

	const sorted = [...messages].sort((a, b) => (a.date || 0) - (b.date || 0));
	const lastMessage = sorted[sorted.length - 1];

	const senderId = lastMessage.senderId ? lastMessage.senderId.toString() : null;
	const isFromUs = ourUserIds.includes(senderId);
	const newStatus = isFromUs ? 'in progress' : 'update';

	const currentStatus = (tx.status || '').toString().trim().toLowerCase();
	if (currentStatus === newStatus) return false;

	try {
		const ok = await updateTransactionStatus(doc, tx.sheetName, tx.transactionId, newStatus);
		if (!ok) return false;

		logStatusChange('Telegram, бекфіл', tx, currentStatus, newStatus);
		tx.status = newStatus;

		const txIndex = state.activeTransactions.findIndex(t => t.transactionId === tx.transactionId);
		if (txIndex !== -1) state.activeTransactions[txIndex].status = newStatus;

		globalMessageCache.set(lastMessage.id, tx);
		return true;
	} catch (error) {
		console.error('Помилка оновлення статусу (Telegram, бекфіл):', error);
		return false;
	}
}

async function runTelegramBackfill(doc, clients, ourUserIds) {
	const cutoffTimestamp = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60;
	const client = clients[0];

	const initialActiveCount = state.activeTransactions.filter(tx => {
		const status = (tx.status || '').toString().trim().toLowerCase();
		return status === '' || status === 'in progress';
	}).length;

	let totalMatched = 0;
	let updatedCount = 0;
	let skippedNoChat = 0;

	console.log(`Бекфіл Telegram: перевіряю ${state.activeTransactions.length} транзакцій по відповідних чатах ПС (за ${BACKFILL_DAYS} дн.)...`);

	for (const tx of state.activeTransactions) {
		const psName = (tx.psName || '').toString().trim().toLowerCase();
		const chatIds = psChatMap.get(psName);

		if (!chatIds || chatIds.length === 0) {
			skippedNoChat++;
			continue;
		}

		const allMessages = [];
		for (const chatId of chatIds) {
			const messages = await findTransactionMessagesInChat(client, chatId, tx.transactionId, cutoffTimestamp);
			allMessages.push(...messages);
		}

		if (allMessages.length === 0) continue;

		totalMatched += allMessages.length;

		const changed = await applyFinalStatusFromMessages(doc, tx, allMessages, ourUserIds);
		if (changed) updatedCount++;
	}

	const remainingActiveCount = state.activeTransactions.filter(tx => {
		const status = (tx.status || '').toString().trim().toLowerCase();
		return status === '' || status === 'in progress';
	}).length;

	console.log(`Бекфіл Telegram завершено.`);
	console.log(`  Активних запитів на початку: ${initialActiveCount}`);
	console.log(`  Надано апдейтів статусу: ${updatedCount}`);
	console.log(`  Активних запитів лишилось: ${remainingActiveCount}`);
	console.log(`  Опрацьовано повідомлень: ${totalMatched}. Транзакцій без відповідного чату ПС: ${skippedNoChat}`);
}

async function setupTelegram(mainDoc, telegramClients, ourUserIds) {
	const { NewMessage } = require('telegram/events');

	await runTelegramBackfill(mainDoc, telegramClients, ourUserIds);

	for (const client of telegramClients) {
		client.addEventHandler(makeTelegramMessageHandler(mainDoc, client, ourUserIds), new NewMessage({}));
	}
	console.log(`Telegram: підключено ${telegramClients.length} клієнт(и), слухаємо чатів: ${knownChatIds.length}`);
}

module.exports = { setupTelegram };
