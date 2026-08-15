const { Api } = require('telegram');
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
const globalSearchThrottle = new Map();
let lastWarmupTime = 0;

async function getPsSheetData(doc) {
	const sheetName = 'ПС-чати';
	let sheet = doc.sheetsByTitle[sheetName];

	if (!sheet) {
		sheet = await doc.addSheet({ title: sheetName, headerValues: ['Назва чату', 'ID чату', 'Col3', 'Незнайдені чати'] });
	} else {
		await sheet.loadHeaderRow();
		let headers = [...sheet.headerValues];
		let changed = false;
		while (headers.length < 4) { headers.push(''); changed = true; }
		if (headers[3] !== 'Незнайдені чати') { headers[3] = 'Незнайдені чати'; changed = true; }
		headers = headers.map((h, i) => h === '' ? `Col${i+1}` : h);
		if (changed) {
			try { await sheet.setHeaderRow(headers); } catch(e){}
		}
	}

	const rows = await sheet.getRows();
	const knownList = [];
	const unfoundSet = new Set();

	for (const row of rows) {
		const name = (row.get('Назва чату') || '').toString().trim();
		const id = (row.get('ID чату') || '').toString().trim();
		const unfound = (row.get('Незнайдені чати') || '').toString().trim();

		if (name && id) knownList.push({ name, id });
		if (unfound) unfoundSet.add(unfound);
	}
	return { sheet, knownList, unfoundSet };
}

async function writePsSheetDataFast(sheet, knownList, unfoundSet) {
	knownList.sort((a, b) => a.name.localeCompare(b.name, 'uk'));
	const unfoundList = Array.from(unfoundSet).sort((a, b) => a.localeCompare(b, 'uk'));

	const maxLen = Math.max(knownList.length, unfoundList.length);
	const totalRowsToLoad = Math.max(maxLen + 2, sheet.rowCount);

	if (sheet.rowCount < maxLen + 2) {
		await sheet.resize({ rowCount: maxLen + 10, columnCount: sheet.columnCount });
	}

	await sheet.loadCells(`A2:D${totalRowsToLoad}`);
	let needsSave = false;

	for (let i = 0; i < totalRowsToLoad - 1; i++) {
		const expectedName = i < knownList.length ? knownList[i].name : '';
		const expectedId = i < knownList.length ? knownList[i].id : '';
		const expectedUnfound = i < unfoundList.length ? unfoundList[i] : '';

		const cellA = sheet.getCell(i + 1, 0);
		const cellB = sheet.getCell(i + 1, 1);
		const cellD = sheet.getCell(i + 1, 3);

		if (cellA.value !== expectedName) { cellA.value = expectedName; needsSave = true; }
		if (cellB.value !== expectedId) { cellB.value = expectedId; needsSave = true; }
		if (cellD.value !== expectedUnfound) { cellD.value = expectedUnfound; needsSave = true; }
	}

	if (needsSave) {
		await sheet.saveUpdatedCells();
	}
}

async function syncPsChats(doc) {
	const { sheet, knownList, unfoundSet } = await getPsSheetData(doc);
	let hasChanges = false;

	psChatMap.clear();
	knownChatIds.length = 0;

	for (const item of knownList) {
		const cIdNum = Number(item.id);
		const norm = item.name.toLowerCase();
		if (!knownChatIds.includes(cIdNum)) knownChatIds.push(cIdNum);
		if (!psChatMap.has(norm)) psChatMap.set(norm, []);
		if (!psChatMap.get(norm).includes(cIdNum)) psChatMap.get(norm).push(cIdNum);
	}

	const unfoundArr = Array.from(unfoundSet);
	for (const u of unfoundArr) {
		if (psChatMap.has(u.toLowerCase())) {
			unfoundSet.delete(u);
			hasChanges = true;
		}
	}

	if (hasChanges) {
		try {
			await writePsSheetDataFast(sheet, knownList, unfoundSet);
		} catch (err) {
			console.error('[УВАГА] Не вдалося оновити аркуш "ПС-чати":', err.message);
		}
	}
}

async function addPsChatToSheet(doc, psNameRaw, chatId) {
	const { sheet, knownList, unfoundSet } = await getPsSheetData(doc);
	const norm = psNameRaw.toLowerCase();

	if (knownList.find(k => k.name.toLowerCase() === norm)) return;

	knownList.push({ name: psNameRaw, id: chatId.toString() });

	const unfoundArr = Array.from(unfoundSet);
	for (const u of unfoundArr) {
		if (u.toLowerCase() === norm) {
			unfoundSet.delete(u);
		}
	}

	try {
		await writePsSheetDataFast(sheet, knownList, unfoundSet);
	} catch (err) {
		console.error(`[УВАГА] Помилка запису нового ПС "${psNameRaw}" в аркуш:`, err.message);
	}

	const cNum = Number(chatId);
	if (!knownChatIds.includes(cNum)) knownChatIds.push(cNum);
	if (!psChatMap.has(norm)) psChatMap.set(norm, []);
	if (!psChatMap.get(norm).includes(cNum)) psChatMap.get(norm).push(cNum);
}

async function flushUnfoundPsToSheet(doc, newUnfoundPsNamesSet) {
	if (newUnfoundPsNamesSet.size === 0) return;

	const { sheet, knownList, unfoundSet } = await getPsSheetData(doc);
	let hasChanges = false;

	for (const psNameRaw of newUnfoundPsNamesSet) {
		const norm = psNameRaw.toLowerCase();
		if (!psChatMap.has(norm)) {
			const already = Array.from(unfoundSet).some(u => u.toLowerCase() === norm);
			if (!already) {
				unfoundSet.add(psNameRaw);
				hasChanges = true;
			}
		}
	}

	if (hasChanges) {
		try {
			await writePsSheetDataFast(sheet, knownList, unfoundSet);
		} catch (err) {
			console.error('[УВАГА] Помилка запису незнайдених ПС:', err.message);
		}
	}
}

const clientChatAccess = new Map();

async function warmupTelegramClients(clients) {
	for (let i = 0; i < clients.length; i++) {
		const client = clients[i];
		try {
			const dialogs = await client.getDialogs();
			if (!clientChatAccess.has(client)) {
				clientChatAccess.set(client, new Set());
			}
			const accessSet = clientChatAccess.get(client);
			dialogs.forEach(d => accessSet.add(d.id.toString()));
		} catch (err) {
			console.error(`Помилка прогріву діалогів клієнта ${i + 1}:`, err.message);
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

async function findChatIdForTransactionGlobal(clients, searchTerm) {
	for (const client of clients) {
		try {
			const result = await client.invoke(new Api.messages.SearchGlobal({
				q: searchTerm.toString().trim(),
				limit: 1,
				offsetRate: 0,
				offsetId: 0,
				offsetPeer: new Api.InputPeerEmpty()
			}));

			if (result && result.messages && result.messages.length > 0) {
				const msg = result.messages[0];
				if (msg.peerId) {
					let foundId = null;
					if (msg.peerId.className === 'PeerChannel') {
						foundId = '-100' + msg.peerId.channelId.toString();
					} else if (msg.peerId.className === 'PeerChat') {
						foundId = '-' + msg.peerId.chatId.toString();
					} else if (msg.peerId.className === 'PeerUser') {
						foundId = msg.peerId.userId.toString();
					}

					if (foundId) {
						if (!clientChatAccess.has(client)) {
							clientChatAccess.set(client, new Set());
						}
						clientChatAccess.get(client).add(foundId);
						return foundId;
					}
				}
			}
		} catch (err) {
			if (err.message && err.message.toLowerCase().includes('flood')) {
				console.error(`[Помилка Telegram] FloodWait при глобальному пошуку: ${err.message}`);
			}
		}
	}
	return null;
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
const txLocks = new Map();

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
			console.error(`[Помилка оновлення Google Таблиці] Транзакція: ${tx.transactionId} -> ${error.message}`);
			return false;
		}
	});
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
		console.error(`[Помилка Telegram] Пошук reply-транзакції у чаті ${chatId}: ${err.message}`);
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

		const chatPsName = Array.from(psChatMap.entries()).find(([, ids]) => ids.includes(chatId))?.[0];
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

const chatRecentCache = new Map();

async function findTransactionMessagesInChat(clients, chatId, searchTerm, cutoffTimestamp, tx) {
	const candidateClients = pickClientsForChat(clients, chatId);
	let errors = [];

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
			errors.push(error.message);
		}
	}

	if (errors.length > 0) {
		const txName = tx ? (tx.transactionId || tx.cpay || 'Невідомо') : searchTerm;
		const uniqueErrors = Array.from(new Set(errors)).join(' | ');
		console.error(`\n[Помилка Telegram] Транзакція: ${txName} (Чат: ${chatId}) -> ${uniqueErrors}`);
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
	const now = Date.now();
	if (now - lastWarmupTime > 3600000) {
		await warmupTelegramClients(clients);
		lastWarmupTime = now;
	}

	const cutoffTimestamp = Math.floor(now / 1000) - BACKFILL_DAYS * 24 * 60 * 60;
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

	const totalCount = state.activeTransactions.length;

	if (isInitialRun) {
		console.log(`Бекфіл Telegram: перевіряю ${totalCount} транзакцій по відповідних чатах ПС (за ${BACKFILL_DAYS} дн.)...`);
	}

	let processedCount = 0;

	for (const tx of state.activeTransactions) {
		processedCount++;

		if (!tx.chatName || tx.chatName.toString().trim() === '') {
			continue;
		}

		process.stdout.write(`\x1b[2K\rБекфіл Telegram: перевірка ${processedCount}/${totalCount}`);

		const psNameRaw = (tx.psName || '').toString().trim();
		const psName = psNameRaw.toLowerCase();
		let chatIds = psChatMap.get(psName);

		if (!chatIds || chatIds.length === 0) {
			const lastSearch = globalSearchThrottle.get(psName) || 0;
			if (now - lastSearch > 3600000) {
				const searchTerm = tx.transactionId || tx.cpay;
				if (searchTerm && searchTerm.length > 4) {
					globalSearchThrottle.set(psName, now);
					const foundChatId = await findChatIdForTransactionGlobal(clients, searchTerm);
					if (foundChatId) {
						await addPsChatToSheet(doc, psNameRaw, foundChatId);
						chatIds = psChatMap.get(psName);
					}
				}
			}
		}

		if (!chatIds || chatIds.length === 0) {
			skippedNoChat++;
			if (psNameRaw && !slackPsList.includes(psName) && !slackTicketPsList.includes(psName) && !externalPsNames.includes(psName)) {
				unmonitoredPsNames.add(psNameRaw);
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
			const messages = await findTransactionMessagesInChat(clients, chatId, searchTerm, cutoffTimestamp, tx);
			allMessages.push(...messages);
		}

		if (allMessages.length === 0) continue;

		totalMatched += allMessages.length;
		const changed = await applyFinalStatusFromMessages(doc, tx, allMessages, ourUserIds);
		if (changed) updatedCount++;
	}

	process.stdout.write('\x1b[2K\r');

	const remainingActiveCount = state.activeTransactions.filter(tx => {
		const status = (tx.status || '').toString().trim().toLowerCase();
		return status === '' || status === 'in progress';
	}).length;

	await flushUnfoundPsToSheet(doc, unmonitoredPsNames);

	if (isInitialRun) {
		console.log(`Бекфіл Telegram завершено.`);
		console.log(`  Активних запитів на початку: ${initialActiveCount}`);
		console.log(`  Надано апдейтів статусу: ${updatedCount}`);
		console.log(`  Активних запитів лишилось: ${remainingActiveCount}`);
		console.log(`  Опрацьовано повідомлень: ${totalMatched}. Транзакцій без чату: ${skippedNoChat}`);

		if (unmonitoredPsNames.size > 0) {
			console.log(`\n[УВАГА] Не стежимо за цими ПС: ${Array.from(unmonitoredPsNames).join(', ')}`);
		}
	}
}

async function setupTelegram(mainDoc, telegramClients, ourUserIds) {
	const { NewMessage, Raw } = require('telegram/events');

	await syncPsChats(mainDoc);
	lastWarmupTime = Date.now();
	await warmupTelegramClients(telegramClients);
	await runTelegramBackfill(mainDoc, telegramClients, ourUserIds, true);

	for (const client of telegramClients) {
		client.addEventHandler(makeTelegramMessageHandler(mainDoc, client, ourUserIds), new NewMessage({}));
		client.addEventHandler(makeReactionHandler(mainDoc), new Raw({}));
	}
	console.log(`Telegram: підключено ${telegramClients.length} клієнт(и), слухаємо чатів: ${knownChatIds.length}`);
}

module.exports = { setupTelegram, runTelegramBackfill, psChatMap, pickClientsForChat };
