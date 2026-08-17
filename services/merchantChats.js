const { getCachedDialogs } = require('./telegramHandler');

async function getMerchantChatId(doc, clients, chatName) {
	if (!chatName) return null;
	const targetName = chatName.toString().trim();

	const sheet = doc.sheetsByTitle['Мерчант-чати'];
	if (!sheet) {
		throw new Error('Аркуш "Мерчант-чати" не знайдено! Створіть його вручну з колонками "Назва чату" та "ID чату".');
	}

	await sheet.loadHeaderRow();
	const rows = await sheet.getRows();

	const existingRow = rows.find(r => (r.get('Назва чату') || '').toString().trim() === targetName);
	if (existingRow) {
		const existingId = existingRow.get('ID чату');
		if (existingId && existingId.toString().trim() !== '') {
			return Number(existingId.toString().trim());
		}
	}

	const ambiguousByClient = [];

	for (const [index, client] of clients.entries()) {
		const dialogs = getCachedDialogs(client);
		const matches = dialogs.filter(d => (d.title || '').toString().trim() === targetName);

		if (matches.length === 1) {
			const foundChatId = matches[0].id.toString();

			if (existingRow) {
				existingRow.set('ID чату', foundChatId);
				await existingRow.save();
			} else {
				await sheet.addRow({
					'Назва чату': targetName,
					'ID чату': foundChatId
				});
			}
			return Number(foundChatId);
		} else if (matches.length > 1) {
			ambiguousByClient.push({ clientIndex: index + 1, ids: matches.map(m => m.id.toString()) });
		}
	}

	if (ambiguousByClient.length > 0) {
		const details = ambiguousByClient
			.map(a => `клієнт ${a.clientIndex}: [${a.ids.join(', ')}]`)
			.join(' | ');
		console.log(`[MerchantChats] Неоднозначна назва чату "${targetName}" — жоден клієнт не дав однозначного збігу. Кандидати: ${details}. Додайте правильний ID вручну в аркуш "Мерчант-чати".`);
		return null;
	}

	return null;
}

module.exports = { getMerchantChatId };
