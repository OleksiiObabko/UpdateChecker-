require('dotenv').config();
const prompts = require('prompts');
const state = require('./services/state');
const { updateCacheShared } = require('./services/cache');
const {
	initGoogleSheets,
	initExternalSheets,
	checkExternalPsUpdates
} = require('./services/googleSheets');
const { initTelegramClients } = require('./services/telegram');
const { setupTelegram } = require('./services/telegramHandler');
const { createSlackApp } = require('./services/slack');

let targetSheets = [];
let cacheCountdown = 300;
let psCountdown = 300;

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

async function promptSheetSelection() {
	const response = await prompts({
		type: 'select',
		name: 'sheet',
		message: 'Оберіть аркуш для моніторингу:',
		choices: [
			{ title: 'Кити', value: 'Кити' },
			{ title: 'Омнік', value: 'Омнік' },
			{ title: 'Лелеки', value: 'Лелеки' },
			{ title: 'Фікси', value: 'Фікси' },
			{ title: 'Дракони', value: 'Дракони' },
			{ title: 'Корівки', value: 'Корівки' },
			{ title: 'Вулик', value: 'Вулик' }
		],
		initial: 0
	});

	if (!response.sheet) {
		process.exit(0);
	}

	targetSheets = [response.sheet];
}

async function main() {
	await promptSheetSelection();

	const mainDoc = await initGoogleSheets();
	const externalDoc = await initExternalSheets();

	await updateCacheShared(mainDoc, targetSheets);

	console.log(`\nЗапуск моніторингу для аркуша: ${targetSheets[0]}`);
	console.log(`Активних запитів знайдено: ${state.activeTransactions.length}\n`);

	try {
		const { clients, ourUserIds } = await initTelegramClients();
		await setupTelegram(mainDoc, clients, ourUserIds);
	} catch (error) {
		console.error('Помилка ініціалізації Telegram:', error);
	}

	if (state.activeTransactions.length > 0) {
		console.log(`[Ініціалізація] Виконую першу перевірку зовнішньої таблиці ПС...`);
		try {
			await checkExternalPsUpdates(mainDoc, externalDoc, state.activeTransactions);
		} catch (error) {
			console.error('Помилка першої перевірки ПС:', error);
		}
	}

	// 3. Запуск таймерів
	setInterval(async () => {
		cacheCountdown--;
		psCountdown--;

		if (cacheCountdown <= 0) {
			cacheCountdown = 300;
			try {
				await updateCacheShared(mainDoc, targetSheets);
				const now = new Date().toLocaleTimeString('uk-UA');
				console.log(`[${now}] Кеш оновлено. Активних запитів: ${state.activeTransactions.length}`);
			} catch (error) {
				console.error('Помилка оновлення кешу:', error.message);
			}
		}

		if (psCountdown <= 0) {
			psCountdown = 300;
			if (state.activeTransactions.length > 0) {
				try {
					await checkExternalPsUpdates(mainDoc, externalDoc, state.activeTransactions);
				} catch (error) {
					console.error('Помилка перевірки ПС:', error);
				}
			}
		}

		const cM = Math.floor(cacheCountdown / 60).toString().padStart(2, '0');
		const cS = (cacheCountdown % 60).toString().padStart(2, '0');
		const pM = Math.floor(psCountdown / 60).toString().padStart(2, '0');
		const pS = (psCountdown % 60).toString().padStart(2, '0');

		process.stdout.write(`\x1b[2K\rОновлення кешу через: ${cM}:${cS} | Перевірка ПС через: ${pM}:${pS}`);
	}, 1000);

	const slackApp = createSlackApp();
	await slackApp.start();
}

main();
