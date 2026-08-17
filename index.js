require('dotenv').config();
const prompts = require('prompts');
const state = require('./services/state');
const { updateCacheShared } = require('./services/cache');
const { initGoogleSheets } = require('./services/googleSheets');
const { initTelegramClients } = require('./services/telegram');
const { setupTelegram, runTelegramBackfill } = require('./services/telegramHandler');
const { createSlackApp, runSlackBackfill } = require('./services/slack');
const { runMerchantSubmissionCycle } = require('./services/merchantSubmission');

let targetSheets = [];
let cacheCountdown = 300;
let backfillCountdown = 630;

const originalLog = console.log;
console.log = function (...args) {
	process.stdout.write('\x1b[2K\r');
	originalLog.apply(console, args);
};

const originalError = console.error;
console.error = function (...args) {
	process.stdout.write('\x1b[2K\r');
	originalError.apply(console, args);
};

// const ALL_SHEETS = ['Кити', 'Омнік', 'Лелеки', 'Фікси', 'Дракони', 'Корівки', 'Вулик'];
const ALL_SHEETS = ['Кити', 'Омнік', 'Корівки'];

async function promptSheetSelection() {
	const response = await prompts({
		type: 'select',
		name: 'sheet',
		message: 'Оберіть аркуш для моніторингу:',
		choices: [
			{ title: 'Усі аркуші', value: 'ALL' },
			{ title: 'Кити', value: 'Кити' },
			{ title: 'Омнік', value: 'Омнік' },
			{ title: 'Лелеки', value: 'Лелеки' },
			{ title: 'Фікси', value: 'Фікси' },
			{ title: 'Дракони', value: 'Дракони' },
			{ title: 'Корівки', value: 'Корівки' },
			{ title: 'Вулик', value: 'Вулик' },
			{ title: 'Запит від мерчантів Slack', value: 'Запит від мерчантів Slack' },
			{ title: 'Запити від TripleC', value: 'Запити від TripleC' }
		],
		initial: 0
	});

	if (!response.sheet) process.exit(0);

	if (response.sheet === 'ALL') {
		targetSheets = ALL_SHEETS;
	} else {
		targetSheets = [response.sheet];
	}
}

async function main() {
	await promptSheetSelection();

	state.targetSheets = targetSheets;

	const mainDoc = await initGoogleSheets();

	await updateCacheShared(mainDoc, targetSheets);

	const sheetsLogName = targetSheets.length > 1 ? 'Усі аркуші' : targetSheets[0];
	console.log(`\nЗапуск моніторингу для: ${sheetsLogName}`);

	const slackApp = createSlackApp(mainDoc);

	let tgClients = [];
	let tgUserIds = [];

	try {
		const { clients, ourUserIds } = await initTelegramClients();
		tgClients = clients;
		tgUserIds = ourUserIds;
		await setupTelegram(mainDoc, clients, ourUserIds);
	} catch (error) {
		console.error('Помилка ініціалізації Telegram:', error);
	}

	if (tgClients.length > 0) {
		try {
			console.log('Виконуємо першу перевірку автоподачі...');
			await runMerchantSubmissionCycle(mainDoc, tgClients);
			console.log('Першу перевірку автоподачі завершено.');
		} catch (error) {
			console.error('Помилка першої автоподачі:', error);
		}
	}

	if (state.activeTransactions.length > 0) {
		await runSlackBackfill(mainDoc, slackApp.client);
	}

	setInterval(async () => {
		cacheCountdown--;
		backfillCountdown--;

		if (cacheCountdown <= 0) {
			cacheCountdown = 300;
			try {
				await updateCacheShared(mainDoc, targetSheets);
				if (state.activeTransactions.length > 0 && tgClients.length > 0) {
					await runMerchantSubmissionCycle(mainDoc, tgClients);
				}
			} catch (error) {
				console.error('Помилка оновлення кешу або автоподачі:', error.message);
			}
		}

		if (backfillCountdown <= 0) {
			backfillCountdown = 600;
			if (state.activeTransactions.length > 0) {
				try {
					await runSlackBackfill(mainDoc, slackApp.client);
					if (tgClients.length > 0) {
						await runTelegramBackfill(mainDoc, tgClients, tgUserIds);
					}
				} catch (error) {
					console.error('Помилка періодичного бекфілу:', error);
				}
			}
		}

		const cM = Math.floor(cacheCountdown / 60).toString().padStart(2, '0');
		const cS = (cacheCountdown % 60).toString().padStart(2, '0');
		const bM = Math.floor(backfillCountdown / 60).toString().padStart(2, '0');
		const bS = (backfillCountdown % 60).toString().padStart(2, '0');

		process.stdout.write(`\x1b[2K\rОновлення кешу (і подача): ${cM}:${cS} | Авто-бекфіл: ${bM}:${bS}`);
	}, 1000);

	await slackApp.start();
}

main();
