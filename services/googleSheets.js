const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const credentials = require('../credentials.json');

const SHEET_ID = process.env.SHEET_ID;

async function initGoogleSheets() {
	const serviceAccountAuth = new JWT({
		email: credentials.client_email,
		key: credentials.private_key,
		scopes: ['https://www.googleapis.com/auth/spreadsheets'],
	});

	const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
	await doc.loadInfo();
	return doc;
}

async function fetchActiveTransactions(doc, targetSheets) {
	const activeTransactions = [];

	for (const sheetName of targetSheets) {
		const sheet = doc.sheetsByTitle[sheetName.trim()];
		if (!sheet) continue;

		const rows = await sheet.getRows();
		for (const row of rows) {
			const expectFrom = row.get('Від кого очікуємо відповідь');
			const status = row.get('Статус');
			const transactionId = row.get('status.bankTransactionId');

			const isStatusValid = !status || status.trim() === '' || status === 'in progress' || status === 'update';
			const isExpectFromValid = !expectFrom || expectFrom.trim() === '' || expectFrom === 'ПС';

			if (isExpectFromValid && isStatusValid && transactionId && transactionId.trim() !== '') {
				activeTransactions.push({
					transactionId: transactionId.trim(),
					psName: row.get('ПС'),
					sheetName: sheetName.trim(),
					rowIndex: row.rowNumber
				});
			}
		}
	}
	return activeTransactions;
}

async function updateTransactionStatus(doc, sheetName, rowIndex, newStatus) {
	const sheet = doc.sheetsByTitle[sheetName];
	const rows = await sheet.getRows({ offset: rowIndex - 2, limit: 1 });
	const row = rows[0];

	row.set('Статус', newStatus);
	await row.save();
}

module.exports = {
	initGoogleSheets,
	fetchActiveTransactions,
	updateTransactionStatus
};
