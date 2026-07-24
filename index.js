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
const { createSlackApp, runSlackBackfill } = require('./services/slack');

let targetSheets = [];
let cacheCountdown = 300;
let psCountdown = 10;

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

const umamaPs = process.env.EXTERNAL_PS_NAMES ? process.env.EXTERNAL_PS_NAMES.split(',').map(s => s.trim().toLowerCase()) : [];
const slackPs = process.env.SLACK_PS ? process.env.SLACK_PS.split(',').map(s => s.trim().toLowerCase()) : [];
const tgPs = (process.env.KNOWN_CHAT_IDS || '').split('\n').map(line => {
	const match = line.match(/\(([^)]+)\)/);
	return match ? match[1].trim().toLowerCase() : null;
}).filter(Boolean);
const monitoredPsSet = new Set([...umamaPs, ...slackPs, ...tgPs]);

function printReport() {
	const inProgressAll = state.activeTransactions.filter(tx => tx.status === 'in progress').length;
	const inProgressMonitored = state.activeTransactions.filter(tx =>
		tx.status === 'in progress' && monitoredPsSet.has((tx.psName || '').toString().trim().toLowerCase())
	).length;

	console.log(`\n--- ЗВІТ ---`);
	console.log(`Надано апдейтів (разом): ${state.stats.updatesProvided}`);
	console.log(`Запитів in progress (незалежно від ПС): ${inProgressAll}`);
	console.log(`Запитів in progress (від ПС які моніторимо): ${inProgressMonitored}`);
	console.log(`------------\n`);
}

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

	if (!response.sheet) process.exit(0);
	targetSheets = [response.sheet];
}

async function main() {
	await promptSheetSelection();

	const mainDoc = await initGoogleSheets();
	const externalDoc = await initExternalSheets();

	await updateCacheShared(mainDoc, targetSheets);

	const inProgressAllInit = state.activeTransactions.filter(tx => tx.status === 'in progress').length;
	const inProgressMonitoredInit = state.activeTransactions.filter(tx =>
		tx.status === 'in progress' && monitoredPsSet.has((tx.psName || '').toString().trim().toLowerCase())
	).length;

	console.log(`\nЗапуск моніторингу для аркуша: ${targetSheets[0]}`);
	console.log(`Запитів in progress (незалежно від ПС): ${inProgressAllInit}`);
	console.log(`Запитів in progress (від ПС які моніторимо): ${inProgressMonitoredInit}`);
	console.log(`Початок запуску процесів...\n`);

	const slackApp = createSlackApp();

	try {
		const { clients, ourUserIds } = await initTelegramClients();
		await setupTelegram(mainDoc, clients, ourUserIds);
	} catch (error) {
		console.error('Помилка ініціалізації Telegram:', error);
	}

	if (state.activeTransactions.length > 0) {
		await runSlackBackfill(mainDoc, slackApp.client);

		try {
			await checkExternalPsUpdates(mainDoc, externalDoc, state.activeTransactions);
		} catch (error) {
			console.error('Помилка першої перевірки umama:', error);
		}
	}

	printReport();

	setInterval(async () => {
		cacheCountdown--;
		psCountdown--;

		let shouldPrintReport = false;

		if (cacheCountdown <= 0) {
			cacheCountdown = 300;
			try {
				await updateCacheShared(mainDoc, targetSheets);
				shouldPrintReport = true;
			} catch (error) {
				console.error('Помилка оновлення кешу:', error.message);
			}
		}

		if (psCountdown <= 0) {
			psCountdown = 300;
			if (state.activeTransactions.length > 0) {
				try {
					await checkExternalPsUpdates(mainDoc, externalDoc, state.activeTransactions);
					shouldPrintReport = true;
				} catch (error) {
					console.error('Помилка перевірки umama:', error);
				}
			}
		}

		if (shouldPrintReport) {
			printReport();
		}

		const cM = Math.floor(cacheCountdown / 60).toString().padStart(2, '0');
		const cS = (cacheCountdown % 60).toString().padStart(2, '0');
		const pM = Math.floor(psCountdown / 60).toString().padStart(2, '0');
		const pS = (psCountdown % 60).toString().padStart(2, '0');

		process.stdout.write(`\x1b[2K\rОновлення кешу через: ${cM}:${cS} | Перевірка umama через: ${pM}:${pS}`);
	}, 1000);

	await slackApp.start();
}

main();
