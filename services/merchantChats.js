const dialogsCache = new Map(); // Кеш для getDialogs (ttl: 5 min)
const CACHE_TTL = 5 * 60 * 1000;

async function getMerchantChatId(doc, clients, chatName) {
	if (!chatName) return null;
	const targetName = chatName.toString().trim();

	// 1. Перевірка наявності аркуша (фатальна помилка для фічі, якщо немає)
	const sheet = doc.sheetsByTitle['Мерчант-чати'];
	if (!sheet) {
		throw new Error('Аркуш "Мерчант-чати" не знайдено! Створіть його вручну з колонками "Назва чату" та "ID чату".');
	}

	await sheet.loadHeaderRow();
	const rows = await sheet.getRows();

	// 2. Пошук у таблиці
	const existingRow = rows.find(r => (r.get('Назва чату') || '').toString().trim() === targetName);
	if (existingRow) {
		const existingId = existingRow.get('ID чату');
		if (existingId && existingId.toString().trim() !== '') {
			return Number(existingId.toString().trim());
		}
	}

	// 3. Пошук через Telegram API (з використанням кешу діалогів)
	for (const [index, client] of clients.entries()) {
		let dialogs = [];
		const cacheKey = `client_${index}`;
		const now = Date.now();

		if (dialogsCache.has(cacheKey) && now - dialogsCache.get(cacheKey).ts < CACHE_TTL) {
			dialogs = dialogsCache.get(cacheKey).dialogs;
		} else {
			try {
				dialogs = await client.getDialogs();
				dialogsCache.set(cacheKey, { dialogs, ts: now });
			} catch (err) {
				console.error(`Помилка getDialogs для клієнта ${index}:`, err.message);
				continue;
			}
		}

		const matches = dialogs.filter(d => (d.title || '').toString().trim() === targetName);

		if (matches.length === 1) {
			const foundChatId = matches[0].id.toString();

			// Дописуємо/оновлюємо в таблиці
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
			console.log(`[MerchantChats] Знайдено більше одного чату з назвою "${targetName}". Пропускаємо.`);
			return null;
		}
	}

	return null;
}

module.exports = { getMerchantChatId };
