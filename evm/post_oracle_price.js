"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const desktopApp = require("ocore/desktop_app.js");

const oracleJson = require('./build/contracts/Oracle.json');



//const evmNetwork = 'Ethereum';
const evmNetwork = 'BSC';
const evmNativePrice = 300;


const provider = process.env.devnet
	? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
	: (evmNetwork === 'Ethereum'
		? new ethers.providers.InfuraProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id)
		: new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org"));
const ethWallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
console.error(`====== my ETH address: `, ethWallet.address);
const signer = process.env.devnet ? provider.getSigner(0) : ethWallet.connect(provider);

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}




process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});


async function start() {

	// OUSD on Obyte
	let ousdAsset = process.env.testnet ? 'CPPYMBzFzI4+eMk7tLMTGjLF4E60t5MUfo2Gq7Y6Cn4=' : '0IwAk71D5xFP0vTzwamKBwzad3I1ZUjZ1gdeB5OnfOg=';
	
	// oracle
	const oracleAddress = '0x3B9AF3beead49768734A93c2B27E0d5205328a88';
	const oracle = new ethers.Contract(oracleAddress, oracleJson.abi, signer);
	await oracle.setPrice("Obyte", "_NATIVE_", 50, evmNativePrice);
	await wait(2000);
	await oracle.setPrice(ousdAsset, "_NATIVE_", 1, evmNativePrice);
	await wait(2000);

	console.error('done');
	process.exit();
}

start();


