"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');


function getProvider(network, bFree) {
	if (process.env.devnet)
		return new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
	switch (network) {
		case 'Ethereum':
			if (process.env.testnet)
				throw Error("rinkeby was discontinued");
			return process.env.devnet
				? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
			//	: new ethers.providers.WebSocketProvider(process.env.testnet ? `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/eth/rinkeby/ws` : `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/eth/mainnet/ws`);
				: ethers.providers.InfuraProvider.getWebSocketProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id);
		//	return new ethers.providers.InfuraProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id);
		
		case 'BSC':
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://bsc-testnet.blockvision.org/v1/${conf.blockvision_key}` : `wss://bsc-mainnet.blockvision.org/v1/${conf.blockvision_key}`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://bsc-testnet.nodereal.io/ws/v1/${conf.nodereal_key}` : `wss://bsc-mainnet.nodereal.io/ws/v1/${conf.nodereal_key}`);
			return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://bsc.getblock.io/${conf.getblock_key}/testnet/` : `wss://bsc.getblock.io/${conf.getblock_key}/mainnet/`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://rpc.ankr.com/bsc_testnet_chapel/ws/${conf.ankr_key}` : `wss://rpc.ankr.com/bsc/ws/${conf.ankr_key}`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/bsc/testnet/ws` : `wss://bsc--mainnet--ws.datahub.figment.io/apikey/${conf.datahub_key}`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/bsc/testnet/ws` : `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/bsc/mainnet/ws`);
		//	return new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org");
		//	return new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://bsc-testnet.publicnode.com" : "https://bsc.publicnode.com");
		
		case 'Polygon':
			/*
			const url = bFree
				? (process.env.testnet ? "https://matic-testnet-archive-rpc.bwarelabs.com" : "https://rpc-mainnet.maticvigil.com")
				: (process.env.testnet ? `https://polygon-mumbai.infura.io/v3/${conf.infura_project_id}` : `https://polygon-mainnet.infura.io/v3/${conf.infura_project_id}`);
			return new ethers.providers.JsonRpcProvider(url);
			*/
		//	return new ethers.providers.JsonRpcProvider((process.env.testnet ? `https://polygon-mumbai.infura.io/v3/${conf.infura_project_id}` : `https://polygon-mainnet.infura.io/v3/${conf.infura_project_id}`));
		//	return new ethers.providers.JsonRpcProvider((process.env.testnet ? `https://rpc.ankr.com/polygon_mumbai` : `https://polygon-rpc.com`));
			return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://rpc.ankr.com/polygon_mumbai/ws/${conf.ankr_key}` : `wss://rpc.ankr.com/polygon/ws/${conf.ankr_key}`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://polygon-mumbai.g.alchemy.com/v2/${conf.alchemy_keys.polygon.testnet}` : `wss://polygon-mainnet.g.alchemy.com/v2/${conf.alchemy_keys.polygon.mainnet}`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://matic-mumbai--ws.datahub.figment.io/apikey/${conf.datahub_key}` : `wss://matic-mainnet--ws.datahub.figment.io/apikey/${conf.datahub_key}`);
		//	return new ethers.providers.WebSocketProvider(process.env.testnet ? `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/polygon/mumbai/ws` : `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/polygon/mainnet/ws`);

		case 'Kava':
			return new ethers.providers.WebSocketProvider(process.env.testnet ? `wss://wevm.testnet.kava.io` : `wss://wevm.kava.io`);
	}
	throw Error(`unknown network ` + network);
}

exports.getProvider = getProvider;
