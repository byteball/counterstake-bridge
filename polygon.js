"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");
const { getAddressBlocks } = require("./etherscan.js");

const etherscan_base_url = process.env.testnet ? 'https://api-testnet.polygonscan.com' : 'https://api.etherscan.io/v2';

let bCreated = false;

class Polygon extends EvmChain {

	#bFree;

	constructor(bFree) {
		if (bCreated)
			throw Error("Polygon class already created, must be a singleton");
		bCreated = true;
		
	//	const provider = getProvider('Polygon', bFree);
	//	const provider = new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://polygon-mumbai.g.alchemy.com/v2/${conf.alchemy_keys.polygon.testnet}` : `wss://polygon-mainnet.g.alchemy.com/v2/${conf.alchemy_keys.polygon.mainnet}`);
	//	const provider = new ethers.providers.JsonRpcProvider((process.env.testnet ? `https://polygon-mumbai.infura.io/v3/${conf.infura_project_id}` : `https://polygon-mainnet.infura.io/v3/${conf.infura_project_id}`));
	//	provider.pollingInterval = conf.polygon_polling_interval * 1000;
		const provider = getProvider('Polygon');
		super('Polygon', conf.polygon_factory_contract_addresses, conf.polygon_assistant_factory_contract_addresses, provider);
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

	getMaxBlockRange() {
	//	return 100000; // infura
		return 500;
	}

	getGasPriceMultiplier() {
		return 1.3;
	}

	async getAddressBlocks(address, startblock, startts) {
		return await getAddressBlocks({ base_url: etherscan_base_url, chainid: 137, address, startblock, startts, api_key: conf.etherscan_api_key });
	}

}

module.exports = Polygon;
