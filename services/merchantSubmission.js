const state = require('./state');
const { getMerchantChatId } = require('./merchantChats');
const { psChatMap } = require('./telegramHandler');
const { applyStatusFromMatch } = require('./slackUtils');
const { CURRENCY_SHEET_MAP } = require('./googleSheets');

async function findMerchantMessage(clients, chatId, merchantId) {
	const searchTerm = merchantId.toString().trim();
	const cutoffTs = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60; // шукаємо за останні 14 днів

	for (const client of clients) {
		try {
			const recent = await client.getMessages(chatId, { limit: 50 });
			let match = recent.find(m => m.message && m.message.includes(searchTerm) && m.date >= cutoffTs);

			if (!match) {
				const searchResults = await client.getMessages(chatId, { search: searchTerm, limit: 10 });
				match = searchResults.find(m => m.date >= cutoffTs);
			}

			if (match) {
				const mediaGroup = [];
				if (match.groupedId) {
					const groupResults = await client.getMessages(chatId, {
						limit: 20,
						maxId: match.id + 10,
						minId: match.id - 10
					});
					const albumMsgs = groupResults.filter(m => m.groupedId && m.groupedId.toString() === match.groupedId.toString());
					for (const m of albumMsgs) {
						if (m.media) mediaGroup.push(m.media);
					}
				} else if (match.media) {
					mediaGroup.push(match.media);
				}

				return { message: match, media: mediaGroup };
			}
		} catch (err) {
			// Ігноруємо помилки доступу, пробуємо інший клієнт
		}
	}
	return null;
}

function groupRelatedRows(messageText, baseTx) {
	const targetPs = (baseTx.psName || '').toString().trim().toLowerCase();

	return state.activeTransactions.filter(tx => {
		const isSendToPs = (tx.status || '').toString().trim().toLowerCase() === 'send to ps';
		const isSamePs = (tx.psName || '').toString().trim().toLowerCase() === targetPs;

		const merchantId =
			tx.merchantId && tx.merchantId.toString().trim() !== ''
				? tx.merchantId.toString().trim()
				: '';

		const ufId =
			tx.ufId && tx.ufId.toString().trim() !== ''
				? tx.ufId.toString().trim()
				: '';

		// Якщо у повідомленні є або ID мерчанта, або ID UF — додаємо рядок у групу
		const isInMessage =
			(merchantId !== '' && messageText.includes(merchantId)) ||
			(ufId !== '' && messageText.includes(ufId));

		return isSendToPs && isSamePs && isInMessage;
	});
}

async function writeToExternalSheet(externalDoc, tx) {
	const externalPsNames = process.env.EXTERNAL_PS_NAMES
		? process.env.EXTERNAL_PS_NAMES.split(',').map(s => s.trim().toLowerCase())
		: [];

	if (!externalPsNames.includes((tx.psName || '').toLowerCase())) return;

	const candidates = CURRENCY_SHEET_MAP[tx.currency] || [];
	if (candidates.length === 0) return;

	for (const sheetName of candidates) {
		const sheet = externalDoc.sheetsByTitle[sheetName];
		if (!sheet) continue;

		try {
			await sheet.loadCells(`C1:C${sheet.rowCount}`);

			let targetRowIndex = -1;
			for (let r = 0; r < sheet.rowCount; r++) {
				const cell = sheet.getCell(r, 2);
				if (cell.value === null || cell.value === '') {
					targetRowIndex = r;
					break;
				}
			}

			if (targetRowIndex !== -1) {
				const cell = sheet.getCell(targetRowIndex, 2);
				cell.value = tx.transactionId.toString().trim();
				await sheet.saveUpdatedCells();
				console.log(`[Зовнішня таблиця] Записано ID ${tx.transactionId} в аркуш ${sheetName}, рядок ${targetRowIndex + 1}`);
				return;
			}
		} catch (err) {
			console.error(`[Зовнішня таблиця] Помилка запису ${tx.transactionId}:`, err.message);
		}
	}
}

async function submitToPs(client, psChatId, psIds, mediaGroup) {
	const text = psIds.join('\n');

	try {
		let sentResult;
		if (mediaGroup && mediaGroup.length > 0) {
			sentResult = await client.sendFile(psChatId, {
				file: mediaGroup,
				caption: text,
				forceDocument: true
			});
		} else {
			sentResult = await client.sendMessage(psChatId, { message: text });
		}

		const isSuccess = Array.isArray(sentResult)
			? sentResult.length > 0 && sentResult[0].id
			: sentResult && sentResult.id;

		if (!isSuccess) {
			throw new Error("Telegram API не повернув ID надісланого повідомлення.");
		}

		return true;
	} catch (error) {
		console.error(`[Автоподача ПС] Помилка відправки в чат ${psChatId}:`, error.message);
		return false;
	}
}

async function runMerchantSubmissionCycle(mainDoc, externalDoc, clients) {
	// Беремо записи, де є або ID мерчанта, або ID UF
	const candidates = state.activeTransactions.filter(tx =>
		(tx.status || '').toString().trim().toLowerCase() === 'send to ps' &&
		(tx.chatName || '').trim() !== '' &&
		(
			(tx.merchantId && tx.merchantId.toString().trim() !== '') ||
			(tx.transactionId && tx.transactionId.toString().trim() !== '')
		)
	);

	if (candidates.length === 0) return;

	const processedSearchTerms = new Set();
	const mainClient = clients[0];

	for (const baseTx of candidates) {
		// Якщо є ID мерчанта — шукаємо за ним, інакше за ID UF
		const searchTerm =
			(baseTx.merchantId && baseTx.merchantId.toString().trim() !== '')
				? baseTx.merchantId.toString().trim()
				: baseTx.ufId.toString().trim();

		if (processedSearchTerms.has(searchTerm)) continue;

		try {
			const merchantChatId = await getMerchantChatId(mainDoc, clients, baseTx.chatName);
			if (!merchantChatId) {
				console.log(`[Автоподача] Чат мерчанта "${baseTx.chatName}" не визначено. Пропуск.`);
				continue;
			}

			const foundData = await findMerchantMessage(clients, merchantChatId, searchTerm);
			if (!foundData) {
				console.log(`[Автоподача] Повідомлення з ID ${searchTerm} в чаті "${baseTx.chatName}" не знайдено.`);
				continue;
			}

			const group = groupRelatedRows(foundData.message.message || '', baseTx);

			const psIds = [];
			const validGroup = [];

			for (const tx of group) {
				if (tx.transactionId && tx.transactionId.toString().trim() !== '') {
					let idText = tx.transactionId.toString().trim();

					if (tx.requestType && tx.requestType.toLowerCase() === 'арн-код') {
						idText += '\nUTR';
					}

					psIds.push(idText);
					validGroup.push(tx);

					const txSearchTerm =
						(tx.merchantId && tx.merchantId.toString().trim() !== '')
							? tx.merchantId.toString().trim()
							: tx.ufId.toString().trim();

					processedSearchTerms.add(txSearchTerm);
				}
			}

			if (psIds.length === 0) continue;

			const psName = (baseTx.psName || '').toString().trim().toLowerCase();
			const psChatIds = psChatMap.get(psName);

			if (!psChatIds || psChatIds.length === 0) {
				console.log(`[Автоподача] Чат для ПС "${baseTx.psName}" не знайдено в мапі.`);
				continue;
			}

			const targetPsChatId = psChatIds[0];

			const success = await submitToPs(mainClient, targetPsChatId, psIds, foundData.media);

			if (success) {
				console.log(`[Автоподача] Успішно надіслано в ПС "${baseTx.psName}" ID: ${validGroup.map(t => t.transactionId).join(', ')}`);

				for (const tx of validGroup) {
					await applyStatusFromMatch('Автоподача ПС', tx, 'in progress');
					await writeToExternalSheet(externalDoc, tx);
				}
			}

		} catch (error) {
			if (error.message.includes('Аркуш "Мерчант-чати" не знайдено')) {
				console.error(`\n[Автоподача] Фатальна помилка: ${error.message}`);
				return;
			}
			console.error(`[Автоподача] Помилка обробки транзакції ${baseTx.transactionId}:`, error);
		}
	}
}

module.exports = { runMerchantSubmissionCycle };
