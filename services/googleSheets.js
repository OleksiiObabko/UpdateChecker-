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

			const expectFrom = expectFromRaw ? expectFromRaw.toString().trim().toLowerCase() : '';
			const status = statusRaw ? statusRaw.toString().trim().toLowerCase() : '';
			const psName = psNameRaw ? psNameRaw.toString().trim().toLowerCase() : '';

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
					activeTransactions.push({
						transactionId: trackingId,
						psName: psNameRaw,
						sheetName: sheetName.trim(),
						rowIndex: row.rowNumber
					});
				}
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
