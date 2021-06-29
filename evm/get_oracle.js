"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');

const importJson = require('./build/contracts/Import.json');


//const evmNetwork = 'Ethereum';
const evmNetwork = 'BSC';


const provider = process.env.devnet
	? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
	: (evmNetwork === 'Ethereum'
		? new ethers.providers.InfuraProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id)
		: new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org"));



process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});


async function start() {
	const import_aa = evmNetwork === 'Ethereum' ? '0x263a511a935d3330bd4bd882004b43cad628f653' : '0xe2Bf106f88b1fb0F43c0F0FBeF1CA242c2aBF992';
	const importContract = new ethers.Contract(import_aa, importJson.abi, provider);
	console.log(evmNetwork, 'oracle', await importContract.oracleAddress());

	console.error('done');
	process.exit();
}

start();


