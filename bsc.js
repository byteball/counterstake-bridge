"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');

let bCreated = false;

class BSC extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("BSC class already created, must be a singleton");
		bCreated = true;
		
		const provider = new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org");
		super('BSC', conf.bsc_factory_contract_address, conf.bsc_assistant_factory_contract_address, provider);
	}

	getNativeSymbol() {
		return 'BNB';
	}

	getMaxBlockRange() {
		return 5000;
	}


}

module.exports = BSC;
