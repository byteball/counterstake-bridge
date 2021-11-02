"use strict";

const conf = require('ocore/conf.js');

const network = require('ocore/network.js');
const headlessWallet = require('headless-obyte');
const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const db_import = require('./db_import.js');


async function removeSupportFromToken(asset, symbol, amount) {
	return await dag.sendPayment({
		to_address: conf.token_registry_aa,
		amount: 1e4,
		data: { asset, symbol, amount, withdraw: 1 },
		is_aa: true,
	});
}



process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});


async function start() {
	await headlessWallet.waitTillReady();
	await db_import.initDB();
	await operator.start();
	network.start();
	const unit = await removeSupportFromToken('NV07T/1+dSGHmPyQkBb86Hpuf40JfxLaAfqzoy+MVr8=', 'GBYTEEA', 0.1e9);
	console.error('done', unit);
	process.exit(0);
}


start();
