const state = require('./state');
const { updateTransactionStatus, findTransactionAnySheet } = require('./googleSheets');

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

function extractPotentialIds(text) {
	if (!text) return [];
	const extracted = text.match(/\b(?=[a-zA-Z0-9_-]*\d)[a-zA-Z0-9_-]{3,}\b/g);
	return extracted ? Array.from(new Set(extracted)) : [];
}

function isIgnoredAutoReply(text) {
	if (!text) return false;
	const lower = text.toLowerCase();
	return lower.includes('ticket has been created') ||
		lower.includes('your ticket created successfully');
}

const globalMessageCache = new Map();
const handledMessages = new Set();

async function resolveTransactionFromReply(doc, client, chatId, replyToMsgId, candidateTxs, depth = 0) {
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

				if (state.targetSheets && state.targetSheets.length > 0) {
					const potentialIds = extractPotentialIds(msg.message);
					for (const matchId of potentialIds.slice(0, 2)) {
						const found = await findTransactionAnySheet(doc, state.targetSheets, matchId);
						if (found) {
							const psNameRaw = found.row.get('ПС');
							const cpayRaw = found.row.get('Cpay');
							const statusRaw = found.row.get('Статус');

							const matchedTx = {
								transactionId: matchId,
								psName: psNameRaw,
								cpay: cpayRaw ? cpayRaw.toString().trim() : '',
								sheetName: found.sheetName,
								status: statusRaw ? statusRaw.toString().trim().toLowerCase() : ''
							};
							state.activeTransactions.push(matchedTx);
							globalMessageCache.set(replyToMsgId, matchedTx);
							return matchedTx;
						}
					}
				}
			}
			if (msg && msg.replyTo) {
				return await resolveTransactionFromReply(doc, client, chatId, msg.replyTo.replyToMsgId, candidateTxs, depth + 1);
			}
		}
	} catch (err) {}
	return null;
}

async function processTelegramMessage(doc, client, chatId, message, ourUserIds, candidateTxs) {
	if (!message || isIgnoredAutoReply(message.message)) return;

	const msgKey = `${chatId}_${message.id}`;
	if (handledMessages.has(msgKey)) return;
	handledMessages.add(msgKey);

	if (handledMessages.size > 5000) {
		const iterator = handledMessages.values();
		for (let i = 0; i < 1000; i++) handledMessages.delete(iterator.next().value);
	}

	const senderId = message.senderId ? message.senderId.toString() : null;
	const isFromUs = ourUserIds.includes(senderId);
	let matchedTx = null;

	if (message.message) {
		for (const [, tx] of globalMessageCache.entries()) {
			const txId = tx.transactionId;
			const cpay = tx.cpay;
			if ((txId && message.message.includes(txId)) || (cpay && message.message.includes(cpay))) {
				matchedTx = tx; break;
			}
		}
		if (!matchedTx) {
			for (const tx of candidateTxs) {
				const txId = tx.transactionId;
				const cpay = tx.cpay;
				if ((txId && message.message.includes(txId)) || (cpay && message.message.includes(cpay))) {
					matchedTx = tx; break;
				}
			}
		}

		if (!matchedTx && state.targetSheets && state.targetSheets.length > 0) {
			const potentialIds = extractPotentialIds(message.message);
			for (const matchId of potentialIds.slice(0, 2)) {
				const found = await findTransactionAnySheet(doc, state.targetSheets, matchId);
				if (found) {
					const psNameRaw = found.row.get('ПС');
					const cpayRaw = found.row.get('Cpay');
					const statusRaw = found.row.get('Статус');
					matchedTx = {
						transactionId: matchId, psName: psNameRaw, cpay: cpayRaw ? cpayRaw.toString().trim() : '',
						sheetName: found.sheetName, status: statusRaw ? statusRaw.toString().trim().toLowerCase() : ''
					};
					state.activeTransactions.push(matchedTx);
					break;
				}
			}
		}
	}

	if (!matchedTx && message.replyTo) {
		matchedTx = await resolveTransactionFromReply(doc, client, chatId, message.replyTo.replyToMsgId, candidateTxs);
	}

	if (!matchedTx) return;

	globalMessageCache.set(message.id, matchedTx);
	const newStatus = isFromUs ? 'in progress' : 'update';
	const currentStatus = (matchedTx.status || '').toString().trim().toLowerCase();

	if (currentStatus === newStatus) return;

	matchedTx.status = newStatus;
	const txIndex = state.activeTransactions.findIndex(tx => tx.transactionId === matchedTx.transactionId);
	if (txIndex !== -1) state.activeTransactions[txIndex].status = newStatus;

	try {
		await updateTransactionStatus(doc, matchedTx.sheetName, matchedTx.transactionId, newStatus);
	} catch (error) {
		matchedTx.status = currentStatus;
		if (txIndex !== -1) state.activeTransactions[txIndex].status = currentStatus;
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

function makeReactionHandler(doc) {
	return async (event) => {
		if (event && (event.className === 'UpdateMessageReactions' || event.className === 'UpdateBotMessageReaction')) {
			const msgId = event.msgId;
			if (!msgId) return;

			const tx = globalMessageCache.get(msgId);
			if (!tx) return;

			const hasReactions = event.reactions && event.reactions.results && event.reactions.results.length > 0;

			if (hasReactions) {
				const newStatus = 'in progress';
				const currentStatus = (tx.status || '').toString().trim().toLowerCase();

				if (currentStatus !== newStatus) {
					tx.status = newStatus;
					const txIndex = state.activeTransactions.findIndex(t => t.transactionId === tx.transactionId);
					if (txIndex !== -1) state.activeTransactions[txIndex].status = newStatus;

					try {
						await updateTransactionStatus(doc, tx.sheetName, tx.transactionId, newStatus);
					} catch (err) {}
				}
			}
		}
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

			let validBase = recentMessages.filter(msg => msg.message && msg.message.includes(searchTerm) && msg.date && msg.date >= cutoffTimestamp);

			if (validBase.length === 0) {
				const searchResults = await client.getMessages(chatId, { search: searchTerm, limit: 20 });
				validBase = searchResults.filter(msg => msg.date && msg.date >= cutoffTimestamp);
			}

			if (validBase.length === 0) continue;

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
	return [];
}

async function applyFinalStatusFromMessages(doc, tx, messages, ourUserIds) {
	const validMessages = messages.filter(m => !isIgnoredAutoReply(m.message));
	if (validMessages.length === 0) return false;

	const sorted = [...validMessages].sort((a, b) => (a.date || 0) - (b.date || 0));
	const lastMessage = sorted[sorted.length - 1];

	const senderId = lastMessage.senderId ? lastMessage.senderId.toString() : null;
	const isFromUs = ourUserIds.includes(senderId);

	const hasReaction = lastMessage.reactions && lastMessage.reactions.results && lastMessage.reactions.results.length > 0;

	const newStatus = (isFromUs || hasReaction) ? 'in progress' : 'update';

	const currentStatus = (tx.status || '').toString().trim().toLowerCase();

	if (currentStatus === newStatus) return false;

	try {
		const ok = await updateTransactionStatus(doc, tx.sheetName, tx.transactionId, newStatus);
		if (!ok) return false;

		if (currentStatus !== newStatus) {
			tx.status = newStatus;
			const txIndex = state.activeTransactions.findIndex(t => t.transactionId === tx.transactionId);
			if (txIndex !== -1) state.activeTransactions[txIndex].status = newStatus;
		}

		globalMessageCache.set(lastMessage.id, tx);
		return true;
	} catch (error) {
		return false;
	}
}

async function runTelegramBackfill(doc, clients, ourUserIds, isInitialRun = false) {
	const cutoffTimestamp = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 24 * 60 * 60;
	const slackPsList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const slackTicketPsList = process.env.SLACK_TICKET_PS ? process.env.SLACK_TICKET_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const externalPsNames = process.env.EXTERNAL_PS_NAMES ? process.env.EXTERNAL_PS_NAMES.split(',').map(s => s.trim().toLowerCase()) : [];

	const initialActiveCount = state.activeTransactions.filter(tx => {
		const status = (tx.status || '').toString().trim().toLowerCase();
		return status === '' || status === 'in progress';
	}).length;

	let totalMatched = 0;
	let updatedCount = 0;
	let skippedNoChat = 0;
	const unmonitoredPsNames = new Set();

	if (isInitialRun) {
		console.log(`Бекфіл Telegram: перевіряю ${state.activeTransactions.length} транзакцій по відповідних чатах ПС (за ${BACKFILL_DAYS} дн.)...`);
	}

	for (const tx of state.activeTransactions) {
		const psName = (tx.psName || '').toString().trim().toLowerCase();
		const chatIds = psChatMap.get(psName);

		if (!chatIds || chatIds.length === 0) {
			skippedNoChat++;
			if (psName && !slackPsList.includes(psName) && !slackTicketPsList.includes(psName) && !externalPsNames.includes(psName)) {
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

	if (isInitialRun) {
		console.log(`Бекфіл Telegram завершено.`);
		console.log(`  Активних запитів на початку: ${initialActiveCount}`);
		console.log(`  Надано апдейтів статусу: ${updatedCount}`);
		console.log(`  Активних запитів лишилось: ${remainingActiveCount}`);
		console.log(`  Опрацьовано повідомлень: ${totalMatched}. Транзакцій без чату: ${skippedNoChat}`);

		if (unmonitoredPsNames.size > 0) {
			console.log(`  [УВАГА] Не стежимо за цими ПС: ${Array.from(unmonitoredPsNames).join(', ')}`);
		}
	}
}

async function setupTelegram(mainDoc, telegramClients, ourUserIds) {
	const { NewMessage, Raw } = require('telegram/events');
	await runTelegramBackfill(mainDoc, telegramClients, ourUserIds, true);
	for (const client of telegramClients) {
		client.addEventHandler(makeTelegramMessageHandler(mainDoc, client, ourUserIds), new NewMessage({}));
		client.addEventHandler(makeReactionHandler(mainDoc), new Raw({}));
	}
}

module.exports = { setupTelegram, runTelegramBackfill, psChatMap };
