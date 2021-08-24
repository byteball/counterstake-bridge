"use strict";
const network = require('ocore/network.js');
const headlessWallet = require('headless-obyte');
const operator = require('aabot/operator.js');
const dag = require('aabot/dag.js');
const { wait } = require('./utils.js');

const aas = [
	'export-governance.oscript',
	'import-governance.oscript',
	'assistant-governance.oscript',
	'export.oscript',
	'import.oscript',
	'export-assistant.oscript',
	'import-assistant.oscript',
	'export-assistant-factory.oscript',
	'import-assistant-factory.oscript',
	'export-factory.oscript',
	'import-factory.oscript',
];
const deploymentDependencies = {
	'export-factory.oscript': ['export-governance.oscript'],
	'import-factory.oscript': ['import-governance.oscript'],
};
let deploymentUnits = {};


async function deployAA(filename) {
	const unit = await dag.deployAAFromFile('./aas/' + filename);
	console.error(`deployed ${filename} in tx ${unit}`);
	return unit;
}

async function waitForDeploymentDependencies(aa) {
	const dependencies = deploymentDependencies[aa];
	if (!dependencies || dependencies.length === 0)
		return;
	for (let dependency_aa of dependencies) {
		const dependency_unit = deploymentUnits[dependency_aa];
		if (!dependency_unit)
			throw Error(`dependency AA ${dependency_aa} not deployed`);
		console.error(`waiting for stability of ${dependency_aa} unit ${dependency_unit}`);
		await headlessWallet.waitUntilMyUnitBecameStable(dependency_unit);
		console.error(`${dependency_unit} is stable`);
	}
}


async function start() {
	await headlessWallet.waitTillReady();
	await operator.start();
	network.start();
	await wait(1000);
	for (let aa of aas) {
		await waitForDeploymentDependencies(aa);
		deploymentUnits[aa] = await deployAA(aa);
		await wait(1000);
	}
	console.error('done');
	process.exit();
}

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});

start();
