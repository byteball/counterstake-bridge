"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const desktopApp = require("ocore/desktop_app.js");

const args = process.argv.slice(2);

const exportAssistantJson = require('./evm/build/contracts/ExportAssistant.json');
const importAssistantJson = require('./evm/build/contracts/ImportAssistant.json');

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});

async function withdrawFromEvmAssistant(network, assistant_address) {
	const { getProvider } = require("./evm/provider.js");
	const mnemonic = JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase;
	const provider = getProvider(network);
	const wallet = ethers.Wallet.fromMnemonic(mnemonic).connect(provider);
	console.log(`my address on ${network}: ${wallet.address}`);

	// try ExportAssistant ABI first; if withdrawManagementFee reverts, it might be an ImportAssistant — both share the same interface for these two methods
	const contract = new ethers.Contract(assistant_address, exportAssistantJson.abi, wallet);

	console.log(`withdrawing management fee from ${assistant_address} on ${network}...`);
	const tx1 = await contract.withdrawManagementFee();
	console.log(`management fee withdrawal tx: ${tx1.hash}`);
	await tx1.wait();
	console.log(`management fee withdrawal mined`);

	console.log(`withdrawing success fee from ${assistant_address} on ${network}...`);
	const tx2 = await contract.withdrawSuccessFee();
	console.log(`success fee withdrawal tx: ${tx2.hash}`);
	await tx2.wait();
	console.log(`success fee withdrawal mined`);
}

async function withdrawFromObyteAssistant(assistant_address) {
	const headlessWallet = require('headless-obyte');
	const operator = require('aabot/operator.js');
	const dag = require('aabot/dag.js');
	const network = require('ocore/network.js');
	const db_import = require('./db_import.js');

	await headlessWallet.waitTillReady();
	await db_import.initDB();
	await operator.start();
	network.start();

	console.log(`withdrawing management fee from ${assistant_address} on Obyte...`);
	const unit1 = await dag.sendAARequest(assistant_address, { withdraw_management_fee: 1 });
	console.log(`management fee withdrawal unit: ${unit1}`);

	console.log(`withdrawing success fee from ${assistant_address} on Obyte...`);
	const unit2 = await dag.sendAARequest(assistant_address, { withdraw_success_fee: 1 });
	console.log(`success fee withdrawal unit: ${unit2}`);
}

async function start() {
	const network = args[0];
	const assistant_address = args[1];

	if (!network || !assistant_address) {
		console.error('Usage: node withdraw_fees.js <network> <assistant_address>');
		console.error('  network: Obyte | Ethereum | BSC | Polygon | Kava');
		process.exit(1);
	}

	if (network === 'Obyte') {
		await withdrawFromObyteAssistant(assistant_address);
	} else {
		await withdrawFromEvmAssistant(network, assistant_address);
	}
	process.exit(0);
}

start();
