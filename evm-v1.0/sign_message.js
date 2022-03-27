"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const desktopApp = require("ocore/desktop_app.js");
const conf = require("ocore/conf.js");

const args = process.argv.slice(2);

function isValidAddress(address) {
	try {
		return address.length === 42 && address === ethers.utils.getAddress(address);
	}
	catch (e) {
		return false;
	}
}

function to2(num) {
	return num <= 9 ? '0' + num : num;
}



process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});

async function start() {

	const contract_address = args[0];
	if (!contract_address)
		throw Error(`please specify import contract address as command line argument`);
	if (!isValidAddress(contract_address))
		throw Error(`invalid address: ${contract_address}`);
	
	const date = new Date();
	const day = to2(date.getUTCDate());
	const month = to2(date.getUTCMonth() + 1);
	const year = date.getUTCFullYear();
	const hour = to2(date.getUTCHours());
	const min = to2(date.getUTCMinutes());
	const sec = to2(date.getUTCSeconds());

	const msg = `[Etherscan.io ${day}/${month}/${year} ${hour}:${min}:${sec}] I, [Etherscan.io ${conf.etherscan_username}] hereby verify that I am the creator of the token contract address ${contract_address}`;

	const ethWallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
	const sig = await ethWallet.signMessage(msg);
	const full_sig = { address: ethWallet.address, msg, sig, version: "2.0" };
	console.error(JSON.stringify(full_sig, null, 2));

	process.exit();
}

start();


