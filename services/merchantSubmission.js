const state = require('./state');
const { getMerchantChatId } = require('./merchantChats');
const { psChatMap, pickClientsForChat } = require('./telegramHandler');
const { applyStatusFromMatch } = require('./slackUtils');

async function findMerchantMessage(clients, chatId, merchantId) {
	const searchTerm = merchantId.toString().trim();
	const cutoffTs = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
	const candidateClients = pickClientsForChat(clients, chatId);

	for (const client of candidateClients) {
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

				return { message: match, media: mediaGroup, sourceClient: client };
			}
		} catch (err) {
			console.error(`[MerchantSubmission] Помилка пошуку повідомлення для ${merchantId} у чаті ${chatId}: ${err.message}`);
		}
	}
	return null;
}

function groupRelatedRows(messageText, baseTx) {
	const targetPs = (baseTx.psName || '').toString().trim().toLowerCase();

	return state.activeTransactions.filter(tx => {
		const isSendToPs = (tx.status || '').toString().trim().toLowerCase() === 'send to ps';
		const isSamePs = (tx.psName || '').toString().trim().toLowerCase() === targetPs;

		const merchantId = tx.merchantId && tx.merchantId.toString().trim() !== '' ? tx.merchantId.toString().trim() : '';
		const ufId = tx.ufId && tx.ufId.toString().trim() !== '' ? tx.ufId.toString().trim() : '';

		const isInMessage = (merchantId !== '' && messageText.includes(merchantId)) || (ufId !== '' && messageText.includes(ufId));
		return isSendToPs && isSamePs && isInMessage;
	});
}

async function submitToPs(client, psChatId, captionText, mediaGroup) {
	try {
		let sentResult;
		if (mediaGroup && mediaGroup.length > 0) {
			const downloadedFiles = [];

			for (let i = 0; i < mediaGroup.length; i++) {
				try {
					const media = mediaGroup[i];
					const buffer = await client.downloadMedia(media);
					if (buffer) {
						let fileName = `receipt_${Date.now()}_${i}.jpg`;

						if (media.document) {
							let originalName = null;
							if (media.document.attributes) {
								const nameAttr = media.document.attributes.find(a => a.className === 'DocumentAttributeFilename');
								if (nameAttr && nameAttr.fileName) {
									originalName = nameAttr.fileName;
								}
							}

							if (originalName) {
								fileName = originalName;
							} else if (media.document.mimeType === 'application/pdf') {
								fileName = `document_${Date.now()}_${i}.pdf`;
							} else {
								const ext = media.document.mimeType ? media.document.mimeType.split('/')[1] : 'file';
								fileName = `document_${Date.now()}_${i}.${ext}`;
							}
						}

						buffer.name = fileName;
						downloadedFiles.push(buffer);
					}
				} catch (dlErr) {
				}
			}

			if (downloadedFiles.length > 0) {
				sentResult = await client.sendFile(psChatId, {
					file: downloadedFiles,
					caption: captionText,
					forceDocument: true
				});
			} else {
				sentResult = await client.sendFile(psChatId, {
					file: mediaGroup,
					caption: captionText,
					forceDocument: true
				});
			}
		} else {
			sentResult = await client.sendMessage(psChatId, { message: captionText });
		}

		const isSuccess = Array.isArray(sentResult) ? sentResult.length > 0 && sentResult[0].id : sentResult && sentResult.id;
		if (!isSuccess) throw new Error("Telegram API return ID error.");

		return true;
	} catch (error) {
		console.error(`[MerchantSubmission] Помилка відправки в ПС чат ${psChatId}: ${error.message}`);
		return false;
	}
}

async function runMerchantSubmissionCycle(mainDoc, clients) {
	const externalPsNames = process.env.EXTERNAL_PS_NAMES ? process.env.EXTERNAL_PS_NAMES.split(',').map(s => s.trim().toLowerCase()) : [];

	const candidates = state.activeTransactions.filter(tx =>
		(tx.status || '').toString().trim().toLowerCase() === 'send to ps' &&
		(tx.chatName || '').trim() !== '' &&
		((tx.merchantId && tx.merchantId.toString().trim() !== '') || (tx.transactionId && tx.transactionId.toString().trim() !== ''))
	);

	if (candidates.length === 0) return;

	const processedSearchTerms = new Set();

	for (const baseTx of candidates) {
		const searchTerm = (baseTx.merchantId && baseTx.merchantId.toString().trim() !== '') ? baseTx.merchantId.toString().trim() : baseTx.ufId.toString().trim();
		if (processedSearchTerms.has(searchTerm)) continue;

		try {
			const merchantChatId = await getMerchantChatId(mainDoc, clients, baseTx.chatName);
			if (!merchantChatId) continue;

			const foundData = await findMerchantMessage(clients, merchantChatId, searchTerm);
			if (!foundData) continue;

			const group = groupRelatedRows(foundData.message.message || '', baseTx);
			const validGroup = [];
			const psIds = [];

			for (const tx of group) {
				if (tx.transactionId && tx.transactionId.toString().trim() !== '') {
					validGroup.push(tx);
					const txSearchTerm = (tx.merchantId && tx.merchantId.toString().trim() !== '') ? tx.merchantId.toString().trim() : tx.ufId.toString().trim();
					processedSearchTerms.add(txSearchTerm);
				}
			}

			if (validGroup.length === 0) continue;

			const psName = (baseTx.psName || '').toString().trim().toLowerCase();
			const psChatIds = psChatMap.get(psName);
			if (!psChatIds || psChatIds.length === 0) continue;

			const targetPsChatId = psChatIds[0];
			const submissionClient = pickClientsForChat(clients, targetPsChatId)[0];

			const isBotIntegration = externalPsNames.includes(psName);

			if (isBotIntegration) {
				for (const tx of validGroup) {
					let commentPart = '';
					if (tx.requestType && tx.requestType.toLowerCase() === 'арн-код') {
						commentPart = 'UTR';
					}

					let ticketType = 'Refill';
					const methodType = (tx.method || '').toLowerCase();
					if (methodType === 'credit') {
						ticketType = 'Payout';
					} else if (methodType === 'purchase') {
						ticketType = 'Refill';
					}

					const idText = tx.transactionId.toString().trim();
					const captionText = `/createTicket\nType: ${ticketType}\nTransaction ID: ${idText}\nComment: ${commentPart}`;

					const success = await submitToPs(submissionClient, targetPsChatId, captionText, foundData.media);
					if (success) {
						await applyStatusFromMatch(mainDoc, 'Автоподача ПС', tx, 'in progress');
					}
				}
			} else {
				for (const tx of validGroup) {
					let idText = tx.transactionId.toString().trim();
					if (tx.requestType && tx.requestType.toLowerCase() === 'арн-код') idText += '\nUTR';
					psIds.push(idText);
				}

				const captionText = psIds.join('\n');
				const success = await submitToPs(submissionClient, targetPsChatId, captionText, foundData.media);

				if (success) {
					for (const tx of validGroup) {
						await applyStatusFromMatch(mainDoc, 'Автоподача ПС', tx, 'in progress');
					}
				}
			}

		} catch (error) {
			if (error.message && error.message.includes('Мерчант-чати')) {
				console.error(`[MerchantSubmission] Відсутній аркуш: ${error.message}`);
				return;
			}
			console.error(`[MerchantSubmission] Неочікувана помилка обробки транзакції ${baseTx.transactionId}: ${error.message}`);
		}
	}
}

module.exports = { runMerchantSubmissionCycle };
