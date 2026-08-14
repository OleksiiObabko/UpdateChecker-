const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const credentials = require('../credentials.json');
const state = require('./state');

const SHEET_ID = process.env.SHEET_ID;

const rowsCache = new Map();
const CACHE_TTL_MS = 60000;

async function getSheetRowsCached(sheet) {
	try {
		sheet.headerValues;
	} catch {
		await sheet.loadHeaderRow();
	}

	const now = Date.now();
	const cached = rowsCache.get(sheet.sheetId);

	if (cached && now - cached.timestamp < CACHE_TTL_MS) {
		return cached.promise;
	}

	const promise = (async () => {
		let retries = 3;
		while (retries > 0) {
			try {
				return await sheet.getRows();
			} catch (error) {
				retries--;
				if (error.response && error.response.status === 429) {
					if (retries === 0) throw error;
					await new Promise(resolve => setTimeout(resolve, 5000));
				} else {
					if (retries === 0) throw error;
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}
		}
	})();

	promise.catch(() => {
		const current = rowsCache.get(sheet.sheetId);
		if (current && current.promise === promise) {
			rowsCache.delete(sheet.sheetId);
		}
	});

	rowsCache.set(sheet.sheetId, { promise, timestamp: now });
	return promise;
}

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

async function fetchActiveTransactions(doc, targetSheets) {
	const activeTransactions = [];
	const slackPsList = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const slackTicketPsList = process.env.SLACK_TICKET_PS ? process.env.SLACK_TICKET_PS.split(',').map(s => s.trim().toLowerCase()) : [];
	const allSlackPs = [...slackPsList, ...slackTicketPsList];

	for (const sheetName of targetSheets) {
		const sheet = doc.sheetsByTitle[sheetName.trim()];
		if (!sheet) continue;

		const rows = await getSheetRowsCached(sheet);
		for (const row of rows) {
			const expectFromRaw = row.get('Від кого очікуємо відповідь');
			const statusRaw = row.get('Статус');
			const bankTransactionIdRaw = row.get('status.bankTransactionId');
			const cpayRaw = row.get('Cpay');
			const psNameRaw = row.get('ПС');
			const ourIdRaw = row.get(sheet.headerValues[3]);
			const currencyRaw = row.get('Валюта') || row.get(sheet.headerValues[2]);
			const merchantIdRaw = row.get('ID мерчанта');
			const chatNameRaw = row.get('Чат');
			const requestTypeRaw = row.get('Тип запиту');
			const methodRaw = row.get('Метод');

			const expectFrom = expectFromRaw ? expectFromRaw.toString().trim().toLowerCase() : '';
			const status = statusRaw ? statusRaw.toString().trim().toLowerCase() : '';
			const psName = psNameRaw ? psNameRaw.toString().trim().toLowerCase() : '';
			const currency = currencyRaw ? currencyRaw.toString().trim().toUpperCase() : null;
			const requestType = requestTypeRaw ? requestTypeRaw.toString().trim() : '';
			const method = methodRaw ? methodRaw.toString().trim() : '';

			const bankTxId = bankTransactionIdRaw ? bankTransactionIdRaw.toString().trim() : '';
			const cpayId = cpayRaw ? cpayRaw.toString().trim() : '';
			const ourId = ourIdRaw ? ourIdRaw.toString().trim() : '';

			const isStatusValid = status === '' || status === 'in progress' || status === 'update' || status === 'send to ps';
			const isExpectFromValid = expectFrom === '' || expectFrom === 'пс';

			if (isExpectFromValid && isStatusValid) {
				const isSlackPs = allSlackPs.includes(psName);
				let trackingId = '';

				if (isSlackPs && ourId !== '') {
					trackingId = ourId;
				} else if (bankTxId !== '') {
					trackingId = bankTxId;
				} else if (cpayId !== '') {
					trackingId = cpayId;
				}

				if (trackingId !== '') {
					activeTransactions.push({
						transactionId: trackingId,
						ufId: ourId,
						bankTransactionId: bankTxId,
						cpay: cpayId,
						psName: psNameRaw,
						sheetName: sheetName.trim(),
						status: status,
						currency,
						merchantId: merchantIdRaw ? merchantIdRaw.toString().trim() : '',
						chatName: chatNameRaw ? chatNameRaw.toString().trim() : '',
						requestType: requestType,
						method: method
					});
				}
			}
		}
	}

	return activeTransactions;
}

async function updateTransactionStatus(doc, sheetName, transactionId, newStatus) {
	const sheet = doc.sheetsByTitle[sheetName];
	if (!sheet) return false;

	const rows = await getSheetRowsCached(sheet);

	const row = rows.findLast(r => {
		const bankId = r.get('status.bankTransactionId');
		const ourId = r.get(sheet.headerValues[3]);
		const cpay = r.get('Cpay');
		const targetId = transactionId.toString().trim();

		return (bankId && bankId.toString().trim() === targetId) ||
			(ourId && ourId.toString().trim() === targetId) ||
			(cpay && cpay.toString().trim() === targetId);
	});

	if (!row) return false;

	const colIndex = sheet.headerValues.indexOf('Статус');
	const rowIndex = row.rowNumber - 1;

	if (colIndex !== -1) {
		await sheet.loadCells({
			startRowIndex: rowIndex, endRowIndex: rowIndex + 1,
			startColumnIndex: colIndex, endColumnIndex: colIndex + 1
		});

		const statusCell = sheet.getCell(rowIndex, colIndex);
		statusCell.value = newStatus;

		await sheet.saveUpdatedCells();
		row.set('Статус', newStatus);
	} else {
		row.set('Статус', newStatus);
		await row.save();
	}

	return true;
}

async function findTransactionAnySheet(doc, targetSheets, transactionId) {
	const targetId = transactionId.toString().trim();

	for (const sheetName of targetSheets) {
		const sheet = doc.sheetsByTitle[sheetName.trim()];
		if (!sheet) continue;

		const rows = await getSheetRowsCached(sheet);
		const row = rows.findLast(r => {
			const bankId = r.get('status.bankTransactionId');
			const ourId = r.get(sheet.headerValues[3]);
			const cpay = r.get('Cpay');

			return (bankId && bankId.toString().trim() === targetId) ||
				(ourId && ourId.toString().trim() === targetId) ||
				(cpay && cpay.toString().trim() === targetId);
		});

		if (row) return { sheetName: sheetName.trim(), row };
	}
	return null;
}

module.exports = {
	initGoogleSheets,
	fetchActiveTransactions,
	updateTransactionStatus,
	findTransactionAnySheet
};
