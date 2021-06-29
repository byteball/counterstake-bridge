/*jslint node: true */
"use strict";
const eventBus = require('ocore/event_bus.js');
const desktopApp = require('ocore/desktop_app.js');
const network = require('ocore/network.js');
const conf = require('ocore/conf.js');
const operator = require('aabot/operator.js');
const db_import = require('./db_import.js');
const transfers = require('./transfers.js');
const webserver = require('./webserver.js');

eventBus.on('headless_wallet_ready', async () => {
	await db_import.initDB();
	await operator.start();

	if (!conf.export_factory_aa || !conf.import_factory_aa)
		throw Error("Please specify export and import factory AAs in conf.json");
	if (!conf.admin_email || !conf.from_email) {
		console.log("please specify admin_email and from_email in your " + desktopApp.getAppDataDir() + "/conf.json");
		process.exit(1);
	}

//	network.start();
	await transfers.start();
	webserver.start();
});

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});
