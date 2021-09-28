/*jslint node: true */
'use strict';
const { ethers } = require("ethers");
const conf = require('ocore/conf');
const eventBus = require('ocore/event_bus');
const db = require('ocore/db.js');
const headlessWallet = require('headless-obyte');
const { networkApi } = require('./transfers.js');

const { utils: { parseUnits, formatUnits }, constants: { AddressZero } } = ethers;


async function getMyBalance(network, asset, decimals) {
	let balance = await networkApi[network].getMyBalance(asset);
	return parseFloat(balance.toString()) / 10 ** decimals;
}

async function getAsset(network, symbol) {
	const [bridge_h] = await db.query("SELECT home_asset, home_asset_decimals FROM bridges WHERE home_network=? AND home_symbol=?", [network, symbol]);
	if (bridge_h)
		return { asset: bridge_h.home_asset, decimals: bridge_h.home_asset_decimals };
	const [bridge_f] = await db.query("SELECT foreign_asset, foreign_asset_decimals FROM bridges WHERE foreign_network=? AND foreign_symbol=?", [network, symbol]);
	if (bridge_f)
		return { asset: bridge_f.foreign_asset, decimals: bridge_f.foreign_asset_decimals };
	return {};
}


/**
 * headless wallet is ready
 */
function start() {
	
	headlessWallet.setupChatEventHandlers();
	
	/**
	 * user pairs his device with the bot
	 */
	eventBus.on('paired', (from_address, pairing_secret) => {
		// send a geeting message
		const device = require('ocore/device.js');
		device.sendMessageToDevice(from_address, 'text', "Welcome to counterstake watchdog/assistant admin chat! Type [help](command:help) to see the avaialble commands.");
	});

	/**
	 * user sends message to the bot
	 */
	eventBus.on('text', async (from_address, text) => {
		// analyze the text and respond
		text = text.trim();

		const device = require('ocore/device.js');
		const sendResponse = response => device.sendMessageToDevice(from_address, 'text', response);
		
		if (!headlessWallet.isControlAddress(from_address))
			return sendResponse("This bot can be managed only from control addresses.  If you are the owner, add your device address to the list of control addresses in conf.js or conf.json.");
		
		if (text === 'help') {
			let lines = [
				"[balances](command:balances) - query the bot's balances;",
				"[deposit <amount> <token>](suggest-command:deposit amount token) - deposit tokens;",
				"[withdraw <amount> <token>](suggest-command:withdraw amount token) - withdraw tokens;",
				"[withdraw all <token>](suggest-command:withdraw all token) - withdraw the entire balance of a token.",
			];
			return sendResponse(lines.join("\n"));
		}

		if (text === 'balances') {
			let balances = {};
			const bridges = await db.query("SELECT * FROM bridges WHERE import_aa IS NOT NULL AND export_aa IS NOT NULL");
			for (let bridge of bridges) {
				const { home_asset, foreign_asset, home_network, foreign_network, home_symbol, foreign_symbol, home_asset_decimals, foreign_asset_decimals } = bridge;
				if (!balances[home_network])
					balances[home_network] = {};
				if (!balances[foreign_network])
					balances[foreign_network] = {};
				if (balances[home_network][home_symbol] === undefined)
					balances[home_network][home_symbol] = await getMyBalance(home_network, home_asset, home_asset_decimals);
				if (balances[foreign_network][foreign_symbol] === undefined)
					balances[foreign_network][foreign_symbol] = await getMyBalance(foreign_network, foreign_asset, foreign_asset_decimals);
			}
		
			let lines = [];
			for (let network in balances)
				for (let symbol in balances[network])
					lines.push(`${symbol}-on-${network}: ${balances[network][symbol]}`)
			return sendResponse(lines.join("\n"));
		}
		
		let arrMatches = text.match(/^(withdraw|deposit) ([\de.]+|all) (\w+)-on-(\w+)/i);
		if (arrMatches) {
			const command = arrMatches[1].toLowerCase();
			let amount = arrMatches[2].toLowerCase();
			const symbol = arrMatches[3];
			const network = arrMatches[4];
			const { asset, decimals } = await getAsset(network, symbol);
			if (!asset)
				return sendResponse(`No such token: ${symbol}-on-${network}`);
			if (amount === 'all' && command === 'deposit')
				return sendResponse('"all" allowed for withdrawals only');
			let amount_in_pennies;
			if (amount === 'all') {
				amount_in_pennies = (network === 'Obyte' && asset === 'base') ? 'all' : await networkApi[network].getMyBalance(asset);
			}
			else {
				if (!parseFloat(amount))
					return sendResponse("bad amount: " + amount);
				amount_in_pennies = parseUnits(amount, decimals);
			}
			if (command === 'deposit') {
				const my_address = networkApi[network].getMyAddress();
				if (network === 'Obyte')
					sendResponse(`[payment](obyte:${my_address}?asset=${encodeURIComponent(asset)}&amount=${amount_in_pennies.toString()})`);
				else
					sendResponse(`Please send ${amount} ${symbol} to ${my_address}`);
			}
			else { // withdraw
				if (!conf.payout_addresses || !conf.payout_addresses[network])
					return sendResponse(`Please set your payout_addresses[${network}] in conf.json`);
				const txid = await networkApi[network].sendPayment(asset, conf.payout_addresses[network], amount_in_pennies, from_address);
				sendResponse(`sent in ${txid}`);
			}
			return;
		}
	});

}


exports.start = start;

