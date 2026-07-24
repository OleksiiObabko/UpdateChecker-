const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const credentials = require('../credentials.json');
const { logStatusChange } = require('./statusLog');
const state = require('./state');

const SHEET_ID = process.env.SHEET_ID;

const CURRENCY_SHEET_MAP = {
	'INR': ['all INR', 'ASAP INR']
};

const NON_FINAL_STATUSES = ['', 'в работе'];

function createServiceAccountAuth() {
	return new JWT({
		email: credentials.client_email,
		key: credentials.private_key,
		scopes: ['https://www.googleapis.com/auth/spreadsheets'],
	});
}

async function initGoogleSheets() {
	const doc = new GoogleSpreadsheet(SHEET_ID, createServiceAccountAuth());
	await doc.loadInfo();
	return doc;
}

async function initExternalSheets() {
	const doc = new GoogleSpreadsheet(process.env.EXTERNAL_PS_SHEET_ID, createServiceAccountAuth());
	await doc.loadInfo();
	return doc;
}

async function fetchActiveTransactions(doc, targetSheets) {
	const activeTransactions = [];
	const seenTransactionIds = new Set();
	const slackPsList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];

	for (const sheetName of targetSheets) {
		const sheet = doc.sheetsByTitle[sheetName.trim()];
		if (!sheet) continue;

		const rows = await sheet.getRows();
		for (const row of rows) {
			const expectFromRaw = row.get('Від кого очікуємо відповідь');
			const statusRaw = row.get('Статус');
			const bankTransactionIdRaw = row.get('status.bankTransactionId');
			const psNameRaw = row.get('ПС');
			const ourIdRaw = row.get(sheet.headerValues[3]);
			const currencyRaw = row.get('Валюта') || row.get(sheet.headerValues[2]);

			const expectFrom = expectFromRaw ? expectFromRaw.toString().trim().toLowerCase() : '';
			const status = statusRaw ? statusRaw.toString().trim().toLowerCase() : '';
			const psName = psNameRaw ? psNameRaw.toString().trim().toLowerCase() : '';
			const currency = currencyRaw ? currencyRaw.toString().trim().toUpperCase() : null;

			const isStatusValid = status === '' || status === 'in progress' || status === 'update';
			const isExpectFromValid = expectFrom === '' || expectFrom === 'пс';

			if (isExpectFromValid && isStatusValid) {
				const isSlackPs = slackPsList.includes(psName);
				let trackingId = null;

				if (isSlackPs && ourIdRaw && ourIdRaw.toString().trim() !== '') {
					trackingId = ourIdRaw.toString().trim();
				} else if (bankTransactionIdRaw && bankTransactionIdRaw.toString().trim() !== '') {
					trackingId = bankTransactionIdRaw.toString().trim();
				}

				if (trackingId) {
					// Захист від дубльованих рядків з однаковим ID у таблиці
					if (seenTransactionIds.has(trackingId)) {
						console.error(`Дублікат ID у "${sheetName.trim()}", рядок ${row.rowNumber}: "${trackingId}" вже додано раніше — пропущено`);
						continue;
					}
					seenTransactionIds.add(trackingId);

					activeTransactions.push({
						transactionId: trackingId,
						psName: psNameRaw,
						sheetName: sheetName.trim(),
						status: status || 'in progress',
						currency
					});
				}
			}
		}
	}

	return activeTransactions;
}

async function updateTransactionStatus(doc, sheetName, transactionId, newStatus) {
	const sheet = doc.sheetsByTitle[sheetName];
	if (!sheet) {
		console.error(`Аркуш "${sheetName}" не знайдено в основній таблиці`);
		return false;
	}

	const rows = await sheet.getRows();

	const row = rows.find(r => {
		const bankId = r.get('status.bankTransactionId');
		const ourId = r.get(sheet.headerValues[3]);
		return (bankId && bankId.toString().trim() === transactionId.toString().trim()) ||
			(ourId && ourId.toString().trim() === transactionId.toString().trim());
	});

	if (!row) {
		console.error(`Рядок для ID ${transactionId} не знайдено в "${sheetName}" (видалений/змінений?)`);
		return false;
	}

	row.set('Статус', newStatus);
	await row.save();
	return true;
}

async function findTransactionInExternalSheets(externalDoc, tx, sheetCache) {
	const candidates = CURRENCY_SHEET_MAP[tx.currency] || [];
	if (candidates.length === 0) return null;

	for (const sheetName of candidates) {
		const sheet = externalDoc.sheetsByTitle[sheetName];
		if (!sheet) continue;

		if (!sheetCache.has(sheetName)) {
			sheetCache.set(sheetName, await sheet.getRows());
		}
		const rows = sheetCache.get(sheetName);

		const matches = rows.filter(r => {
			const ufId = r.get('UF ID');
			const orderId = r.get('Order ID');
			return (ufId && ufId.toString().trim() === tx.transactionId.toString().trim()) ||
				(orderId && orderId.toString().trim() === tx.transactionId.toString().trim());
		});

		if (matches.length === 0) continue;

		// Останній рядок у таблиці = останнє (найновіше) звернення
		const row = matches[matches.length - 1];
		return { row, sheetName };
	}
	return null;
}

async function checkExternalPsUpdates(doc, externalDoc, transactions) {
	try {
		const externalPsNames = process.env.EXTERNAL_PS_NAMES
			? process.env.EXTERNAL_PS_NAMES.split(',').map(s => s.trim().toLowerCase())
			: [];

		const activeTransactions = transactions.filter(tx =>
			externalPsNames.includes((tx.psName || '').toLowerCase()) && tx.status.toLowerCase() === 'in progress'
		);

		if (activeTransactions.length === 0) return;

		const sheetCache = new Map();
		const mainSheetRowsCache = new Map();

		for (const tx of activeTransactions) {
			const found = await findTransactionInExternalSheets(externalDoc, tx, sheetCache);
			if (!found) continue;

			const originalStatusText = found.row.get('Status') ? found.row.get('Status').toString().trim() : '';
			const rowStatus = originalStatusText.toLowerCase();

			if (NON_FINAL_STATUSES.includes(rowStatus)) continue;

			let textToAdd = originalStatusText;
			if (rowStatus !== 'в работе') {
				const commentText = found.row.get('Comment') ? found.row.get('Comment').toString().trim() : '';
				if (commentText) {
					textToAdd = `${originalStatusText} | ${commentText}`;
				}
			}

			const mainSheet = doc.sheetsByTitle[tx.sheetName];
			if (!mainSheet) continue;

			if (!mainSheetRowsCache.has(tx.sheetName)) {
				mainSheetRowsCache.set(tx.sheetName, await mainSheet.getRows());
			}
			const mainRows = mainSheetRowsCache.get(tx.sheetName);

			const row = mainRows.find(r => {
				const bankId = r.get('status.bankTransactionId');
				const ourId = r.get(mainSheet.headerValues[3]);
				return (bankId && bankId.toString().trim() === tx.transactionId.toString().trim()) ||
					(ourId && ourId.toString().trim() === tx.transactionId.toString().trim());
			});

			if (!row) continue;

			const previousStatus = tx.status;
			row.set('Статус', 'update');

			const currentComment = row.get('Дод.коментарі/задача') ? row.get('Дод.коментарі/задача').toString().trim() : '';
			const newComment = currentComment
				? `${currentComment}\n${textToAdd}`
				: textToAdd;

			row.set('Дод.коментарі/задача', newComment);

			await row.save();
			tx.status = 'update';

			state.stats.updatesProvided++;
			logStatusChange('umama', tx, previousStatus, 'update');
		}
	} catch (error) {
		console.error('Помилка перевірки umama:', error.message);
	}
}

module.exports = {
	initGoogleSheets,
	fetchActiveTransactions,
	updateTransactionStatus,
	initExternalSheets,
	checkExternalPsUpdates
};
