"use strict";
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");
const { getAddressBlocks } = require("./etherscan.js");

const etherscan_base_url = process.env.testnet ? 'https://api-testnet.bscscan.com' : 'https://api.bscscan.com';

let bCreated = false;

class BSC extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("BSC class already created, must be a singleton");
		bCreated = true;
		
		const provider = getProvider('BSC');
		super('BSC', conf.bsc_factory_contract_address, conf.bsc_assistant_factory_contract_address, provider);
	}

	getNativeSymbol() {
		return 'BNB';
	}

	getMaxBlockRange() {
		return 5000;
	}

	async getAddressBlocks(address, since_block) {
		return await getAddressBlocks(etherscan_base_url, address, since_block);
	}

}

module.exports = BSC;
