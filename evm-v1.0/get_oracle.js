"use strict";
const { ethers } = require("ethers");
const { getProvider } = require("./provider.js");

const importJson = require('./build/contracts/Import.json');


//const evmNetwork = 'Ethereum';
const evmNetwork = 'BSC';
//const evmNetwork = 'Polygon';


const provider = getProvider(evmNetwork);


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


