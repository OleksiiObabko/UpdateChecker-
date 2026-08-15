const state = require('./state');
const { updateTransactionStatus, findTransactionAnySheet } = require('./googleSheets');
const { logStatusChange } = require('./statusLog');

const parsedBackfillDays = Number(process.env.TELEGRAM_BACKFILL_DAYS);
const BACKFILL_DAYS = Number.isFinite(parsedBackfillDays) && parsedBackfillDays > 0 ? parsedBackfillDays : 60;
if (process.env.TELEGRAM_BACKFILL_DAYS && !(Number.isFinite(parsedBackfillDays) && parsedBackfillDays > 0)) {
	console.error(`[УВАГА] TELEGRAM_BACKFILL_DAYS="${process.env.TELEGRAM_BACKFILL_DAYS}" не є коректним числом, використовую значення за замовчуванням: ${BACKFILL_DAYS} дн.`);
}

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
const GLOBAL_MESSAGE_CACHE_LIMIT = 5000;
const handledMessages = new Set();

function cacheMessage(msgId, tx) {
	globalMessageCache.set(msgId, tx);
	if (globalMessageCache.size > GLOBAL_MESSAGE_CACHE_LIMIT) {
		const iterator = globalMessageCache.keys();
		for (let i = 0; i < 1000; i++) globalMessageCache.delete(iterator.next().value);
	}
}

function getOrCreateTransaction(transactionId, psNameRaw, cpayRaw, sheetName, statusRaw) {
	const existing = state.activeTransactions.find(t => t.transactionId === transactionId);
	if (existing) return existing;

	const tx = {
		transactionId,
		psName: psNameRaw,
		cpay: cpayRaw ? cpayRaw.toString().trim() : '',
		sheetName,
		status: statusRaw ? statusRaw.toString().trim().toLowerCase() : ''
	};
	state.activeTransactions.push(tx);
	return tx;
}

async function matchTransactionInText(doc, text, candidateTxs) {
	if (!text) return null;

	for (const [, tx] of globalMessageCache.entries()) {
		const txId = tx.transactionId;
		const cpay = tx.cpay;
		if ((txId && text.includes(txId)) || (cpay && text.includes(cpay))) return tx;
	}

	for (const tx of candidateTxs) {
		const txId = tx.transactionId;
		const cpay = tx.cpay;
		if ((txId && text.includes(txId)) || (cpay && text.includes(cpay))) return tx;
	}

	if (state.targetSheets && state.targetSheets.length > 0) {
		const potentialIds = extractPotentialIds(text).slice(0, 5);
		for (const matchId of potentialIds) {
			const found = await findTransactionAnySheet(doc, state.targetSheets, matchId);
			if (found) {
				return getOrCreateTransaction(
					matchId,
					found.row.get('ПС'),
					found.row.get('Cpay'),
					found.sheetName,
					found.row.get('Статус')
				);
			}
		}
	}

	return null;
}

const txLocks = new Map();

function lockTransaction(transactionId, fn) {
	const prevLock = txLocks.get(transactionId) || Promise.resolve();
	const nextLock = prevLock.then(fn, fn);
	txLocks.set(transactionId, nextLock.catch(() => {}));
	return nextLock;
}

function applyStatusUpdate(doc, tx, newStatus, source) {
	return lockTransaction(tx.transactionId, async () => {
		const currentStatus = (tx.status || '').toString().trim().toLowerCase();
		if (currentStatus === newStatus) return false;

		tx.status = newStatus;
		const txIndex = state.activeTransactions.findIndex(t => t.transactionId === tx.transactionId);
		if (txIndex !== -1) state.activeTransactions[txIndex].status = newStatus;

		try {
			const ok = await updateTransactionStatus(doc, tx.sheetName, tx.transactionId, newStatus);
			if (ok) {
				logStatusChange(source, tx, currentStatus, newStatus);
				return true;
			}
			tx.status = currentStatus;
			if (txIndex !== -1) state.activeTransactions[txIndex].status = currentStatus;
			return false;
		} catch (error) {
			tx.status = currentStatus;
			if (txIndex !== -1) state.activeTransactions[txIndex].status = currentStatus;
			console.error(error);
			return false;
		}
	});
}

async function resolveTransactionFromReply(doc, client, chatId, replyToMsgId, candidateTxs, depth = 0) {
	if (depth > 3) return null;

	const targetId = Number(replyToMsgId);
	if (globalMessageCache.has(targetId)) {
		return globalMessageCache.get(targetId);
	}

	try {
		const msgs = await client.getMessages(chatId, { ids: [replyToMsgId] });
		if (msgs && msgs.length > 0) {
			const msg = msgs[0];
			if (msg && msg.message) {
				const matchedTx = await matchTransactionInText(doc, msg.message, candidateTxs);
				if (matchedTx) {
					cacheMessage(targetId, matchedTx);
					return matchedTx;
				}
			}
			if (msg && msg.replyTo) {
				return await resolveTransactionFromReply(doc, client, chatId, msg.replyTo.replyToMsgId, candidateTxs, depth + 1);
			}
		}
	} catch (err) {
		console.error(err);
	}
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

	let matchedTx = message.message ? await matchTransactionInText(doc, message.message, candidateTxs) : null;

	if (!matchedTx && message.replyTo) {
		matchedTx = await resolveTransactionFromReply(doc, client, chatId, message.replyTo.replyToMsgId, candidateTxs);
	}

	if (!matchedTx) return;

	cacheMessage(Number(message.id), matchedTx);
	const newStatus = isFromUs ? 'in progress' : 'update';
	await applyStatusUpdate(doc, matchedTx, newStatus, 'Telegram, live');
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
			const msgId = event.msgId ? Number(event.msgId) : null;
			if (!msgId) return;

			const tx = globalMessageCache.get(msgId);
			if (!tx) return;

			const hasReactions = event.reactions && event.reactions.results && event.reactions.results.length > 0;
			const newStatus = hasReactions ? 'in progress' : 'update';
			const source = hasReactions ? 'Telegram, reaction' : 'Telegram, reaction removed';

			await applyStatusUpdate(doc, tx, newStatus, source);
		}
	};
}

const clientChatAccess = new Map(); // client -> Set<string> доступних chatId

async function warmupTelegramClients(clients) {
	for (const client of clients) {
		try {
			const dialogs = await client.getDialogs();
			clientChatAccess.set(client, new Set(dialogs.map(d => d.id.toString())));
		} catch (err) {
			console.error('Помилка прогріву діалогів клієнта:', err.message);
		}
	}
}

function pickClientsForChat(clients, chatId) {
	const targetId = chatId.toString();
	const withAccess = clients.filter(c => {
		const ids = clientChatAccess.get(c);
		return ids && ids.has(targetId);
	});

	return withAccess.length > 0 ? withAccess : clients;
}

const chatRecentCache = new Map();

async function findTransactionMessagesInChat(clients, chatId, searchTerm, cutoffTimestamp) {
	let lastError = null;
	const candidateClients = pickClientsForChat(clients, chatId);

	for (const client of candidateClients) {
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

			const childrenByParent = new Map();
			for (const msg of recentMessages) {
				if (msg.replyTo) {
					const parentId = msg.replyTo.replyToMsgId;
					if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
					childrenByParent.get(parentId).push(msg);
				}
			}

			const relatedMessages = new Map();
			for (const msg of validBase) {
				relatedMessages.set(msg.id, msg);
			}

			const queue = [...validBase];
			while (queue.length > 0) {
				const current = queue.shift();
				const children = childrenByParent.get(current.id) || [];
				for (const child of children) {
					if (!relatedMessages.has(child.id)) {
						relatedMessages.set(child.id, child);
						queue.push(child);
					}
				}
			}

			return Array.from(relatedMessages.values());

		} catch (error) {
			lastError = error;
		}
	}

	if (lastError) {
		console.error(lastError.message);
	}
	return [];
}

async function applyFinalStatusFromMessages(doc, tx, messages, ourUserIds) {
	const validMessages = messages.filter(m => !isIgnoredAutoReply(m.message));
	if (validMessages.length === 0) return false;

	const sorted = [...validMessages].sort((a, b) => (a.date || 0) - (b.date || 0));

	sorted.forEach(m => {
		if (m.id) cacheMessage(Number(m.id), tx);
	});

	const lastMessage = sorted[sorted.length - 1];

	const senderId = lastMessage.senderId ? lastMessage.senderId.toString() : null;
	const isFromUs = ourUserIds.includes(senderId);

	const hasReaction = lastMessage.reactions && lastMessage.reactions.results && lastMessage.reactions.results.length > 0;

	const newStatus = (isFromUs || hasReaction) ? 'in progress' : 'update';

	return applyStatusUpdate(doc, tx, newStatus, 'Telegram, бекфіл');
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

	await warmupTelegramClients(telegramClients);
	await runTelegramBackfill(mainDoc, telegramClients, ourUserIds, true);
	for (const client of telegramClients) {
		client.addEventHandler(makeTelegramMessageHandler(mainDoc, client, ourUserIds), new NewMessage({}));
		client.addEventHandler(makeReactionHandler(mainDoc), new Raw({}));
	}
	console.log(`Telegram: підключено ${telegramClients.length} клієнт(и), слухаємо чатів: ${knownChatIds.length}`);
}

module.exports = { setupTelegram, runTelegramBackfill, psChatMap, pickClientsForChat };
