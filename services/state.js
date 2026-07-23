// Єдине джерело правди для активних транзакцій — усі модулі (Slack, Telegram, external PS)
// читають і мутують саме цей об'єкт, щоб не розходитись у копіях масиву.
const state = {
	activeTransactions: [],
	fetchPromise: null
};

module.exports = state;
