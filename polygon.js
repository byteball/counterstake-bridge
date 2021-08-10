"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");

let bCreated = false;

class Polygon extends EvmChain {

	#bFree;

	constructor(bFree) {
		if (bCreated)
			throw Error("Polygon class already created, must be a singleton");
		bCreated = true;
		
	//	const provider = getProvider('Polygon', bFree);
	//	const provider = new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://polygon-mumbai.g.alchemy.com/v2/${conf.alchemy_keys.polygon.testnet}` : `wss://polygon-mainnet.g.alchemy.com/v2/${conf.alchemy_keys.polygon.mainnet}`);
		const provider = new ethers.providers.JsonRpcProvider((process.env.testnet ? `https://polygon-mumbai.infura.io/v3/${conf.infura_project_id}` : `https://polygon-mainnet.infura.io/v3/${conf.infura_project_id}`));
		provider.pollingInterval = 120 * 1000;
		super('Polygon', conf.polygon_factory_contract_address, conf.polygon_assistant_factory_contract_address, provider, false);
		this.#bFree = bFree;
	}

	forget() {
		console.log(`removing ${this.getProvider().listenerCount()} listeners on ${this.network}`);
		this.getProvider().removeAllListeners();
		bCreated = false;
	}

	getNativeSymbol() {
		return 'MATIC';
	}

//	getMaxBlockRange() {
//		return this.#bFree ? 1000 : 0;
//	}


}

module.exports = Polygon;
