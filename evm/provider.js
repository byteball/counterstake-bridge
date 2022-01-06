"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');


function getProvider(network, bFree) {
	if (process.env.devnet)
		return new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
	switch (network) {
		case 'Ethereum':
			return new ethers.providers.InfuraProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id);
		case 'BSC':
			return new ethers.providers.JsonRpcProvider(process.env.testnet ? `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/bsc/testnet` : `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/bsc/mainnet`);
		//	return new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org");
		case 'Polygon':
			/*
			const url = bFree
				? (process.env.testnet ? "https://matic-testnet-archive-rpc.bwarelabs.com" : "https://rpc-mainnet.maticvigil.com")
				: (process.env.testnet ? `https://polygon-mumbai.infura.io/v3/${conf.infura_project_id}` : `https://polygon-mainnet.infura.io/v3/${conf.infura_project_id}`);
			return new ethers.providers.JsonRpcProvider(url);
			*/
			return new ethers.providers.JsonRpcProvider(process.env.testnet ? `https://polygon-mumbai.g.alchemy.com/v2/${conf.alchemy_keys.polygon.testnet}` : `https://polygon-mainnet.g.alchemy.com/v2/${conf.alchemy_keys.polygon.mainnet}`);
	}
	throw Error(`unknown network ` + network);
}

exports.getProvider = getProvider;
