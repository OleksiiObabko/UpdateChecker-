const state = require('./state');
const { updateTransactionStatus } = require('./googleSheets');
const { logStatusChange } = require('./statusLog');

const BACKFILL_DAYS = Number(process.env.TELEGRAM_BACKFILL_DAYS || 60);

const psChatMap = new Map();
const knownChatIds = [];

const matches = [...(process.env.KNOWN_CHAT_IDS || '').matchAll(/(-?\d+)\s*\(([^)]+)\)/g)];

for (const match of matches) {
	const chatId = Number(match[1]);
	const psNames = match[2].split(',').map(s => s.trim().toLowerCase());

	if (!knownChatIds.includes(chatId)) {
		knownChatIds.push(chatId);
	}

	for (const psName of psNames) {
		if (!psChatMap.has(psName)) {
			psChatMap.set(psName, []);
		}
		if (!psChatMap.get(psName).includes(chatId)) {
			psChatMap.get(psName).push(chatId);
		}
	}
}

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
					const txId = tx.transactionId;
					const cpay = tx.cpay;
					if ((txId && msg.message.includes(txId)) || (cpay && msg.message.includes(cpay))) {
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
			const txId = tx.transactionId;
			const cpay = tx.cpay;
			if ((txId && message.message.includes(txId)) || (cpay && message.message.includes(cpay))) {
				matchedTx = tx;
				break;
			}
		}
		if (!matchedTx) {
			for (const tx of candidateTxs) {
				const txId = tx.transactionId;
				const cpay = tx.cpay;
				if ((txId && message.message.includes(txId)) || (cpay && message.message.includes(cpay))) {
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

const chatRecentCache = new Map();

async function findTransactionMessagesInChat(clients, chatId, searchTerm, cutoffTimestamp) {
	let lastError = null;

	for (const client of clients) {
		try {
			const now = Date.now();
			let recentMessages = [];
			const cacheKey = `${chatId}`;

			if (chatRecentCache.has(cacheKey) && (now - chatRecentCache.get(cacheKey).ts < 60000)) {
				recentMessages = chatRecentCache.get(cacheKey).msgs;
			} else {
				recentMessages = await client.getMessages(chatId, { limit: 1000 });
				chatRecentCache.set(cacheKey, { msgs: recentMessages, ts: now });
			}

			let validBase = recentMessages.filter(msg =>
				msg.message && msg.message.includes(searchTerm) && msg.date && msg.date >= cutoffTimestamp
			);

			if (validBase.length === 0) {
				const searchResults = await client.getMessages(chatId, {
					search: searchTerm,
					limit: 20
				});
				validBase = searchResults.filter(msg => msg.date && msg.date >= cutoffTimestamp);
			}

			if (validBase.length === 0) {
				continue;
			}

			const relatedMessages = new Map();
			const chainIds = new Set();

			for (const msg of validBase) {
				relatedMessages.set(msg.id, msg);
				chainIds.add(msg.id);
			}

			let addedNew = true;
			while (addedNew) {
				addedNew = false;
				for (let i = recentMessages.length - 1; i >= 0; i--) {
					const subMsg = recentMessages[i];
					if (!relatedMessages.has(subMsg.id) && subMsg.replyTo && chainIds.has(subMsg.replyTo.replyToMsgId)) {
						relatedMessages.set(subMsg.id, subMsg);
						chainIds.add(subMsg.id);
						addedNew = true;
					}
				}
			}

			return Array.from(relatedMessages.values());

		} catch (error) {
			lastError = error;
		}
	}

	if (lastError) {
		console.error(`Помилка пошуку "${searchTerm}" в чаті ${chatId}:`, lastError.message);
	}
	return [];
}

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

async function runTelegramBackfill(doc, clients, ourUserIds, isInitialRun = false) {
	const cutoffTimestamp = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60;

	const slackPsList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const externalPsNames = process.env.EXTERNAL_PS_NAMES ? process.env.EXTERNAL_PS_NAMES.split(',').map(s => s.trim().toLowerCase()) : [];

	const initialActiveCount = state.activeTransactions.filter(tx => {
		const status = (tx.status || '').toString().trim().toLowerCase();
		return status === '' || status === 'in progress';
	}).length;

	let totalMatched = 0;
	let updatedCount = 0;
	let skippedNoChat = 0;
	const unmonitoredPsNames = new Set();

	console.log(`Бекфіл Telegram: перевіряю ${state.activeTransactions.length} транзакцій по відповідних чатах ПС (за ${BACKFILL_DAYS} дн.)...`);

	for (const tx of state.activeTransactions) {
		const psName = (tx.psName || '').toString().trim().toLowerCase();
		const chatIds = psChatMap.get(psName);

		if (!chatIds || chatIds.length === 0) {
			skippedNoChat++;
			if (psName && !slackPsList.includes(psName) && !externalPsNames.includes(psName)) {
				unmonitoredPsNames.add(psName);
			}
			continue;
		}

		const searchTerm = tx.transactionId || tx.cpay;
		if (!searchTerm) {
			skippedNoChat++;
			continue;
		}

		const allMessages = [];
		for (const chatId of chatIds) {
			const messages = await findTransactionMessagesInChat(clients, chatId, searchTerm, cutoffTimestamp);
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
	console.log(`  Опрацьовано повідомлень: ${totalMatched}. Транзакцій без чату: ${skippedNoChat}`);

	if (unmonitoredPsNames.size > 0) {
		console.log(`  [УВАГА] Не стежимо за цими ПС: ${Array.from(unmonitoredPsNames).join(', ')}`);
	}
}

async function setupTelegram(mainDoc, telegramClients, ourUserIds) {
	const { NewMessage } = require('telegram/events');

	await runTelegramBackfill(mainDoc, telegramClients, ourUserIds, true);

	for (const client of telegramClients) {
		client.addEventHandler(makeTelegramMessageHandler(mainDoc, client, ourUserIds), new NewMessage({}));
	}
	console.log(`Telegram: підключено ${telegramClients.length} клієнт(и), слухаємо чатів: ${knownChatIds.length}`);
}

module.exports = { setupTelegram, runTelegramBackfill };
