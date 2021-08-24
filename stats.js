/*jslint node: true */
"use strict";
const { ethers } = require("ethers");
const db = require('ocore/db.js');
const dag = require('aabot/dag.js');

const { networkApi } = require('./transfers.js');
const { fetchExchangeRateInUSD } = require('./prices.js');
const { wait } = require('./utils.js');
const erc20Json = require('./evm/build/contracts/ERC20.json');
const exportJson = require('./evm/build/contracts/Export.json');

const { BigNumber, utils: { formatUnits } } = ethers;

function toDisplayUnits(amount_in_pennies, decimals) {
	return parseFloat(formatUnits(amount_in_pennies, decimals));
}

async function calcTransferredAmounts() {
	let total = 0;
	let bExportsIncomplete = false;
	let bImportsIncomplete = false;
	const bridges = await db.query("SELECT * FROM bridges WHERE import_aa IS NOT NULL AND export_aa IS NOT NULL");
	for (let bridge of bridges) {
		const { bridge_id, home_symbol, home_asset, foreign_asset, home_network, foreign_network, export_aa, import_aa, home_asset_decimals, foreign_asset_decimals } = bridge;
		let exported_amount, imported_amount;
		try {
			exported_amount = toDisplayUnits(await getExportedAmount(home_network, home_asset, export_aa), home_asset_decimals);
		}
		catch (e) {
			console.log(`getExportedAmount(${home_network}, ${home_asset}, ${export_aa}) failed`, e);
			bExportsIncomplete = true;
		}
		try {
			imported_amount = toDisplayUnits(await getImportedAmount(foreign_network, foreign_asset, import_aa), foreign_asset_decimals);
		}
		catch (e) {
			console.log(`getImportedAmount(${foreign_network}, ${foreign_asset}, ${import_aa}) failed`, e);
			bImportsIncomplete = true;
		}
		console.log(`bridge ${home_symbol} ${home_network}->${foreign_network}: exported ${exported_amount}, imported ${imported_amount}`);
		if (imported_amount > exported_amount)
			throw Error(`bridge ${bridge_id} ${home_symbol} ${home_network}->${foreign_network}: exported ${exported_amount} < imported ${imported_amount}`);
		const rate = await fetchExchangeRateInUSD(home_network, home_asset, true);
		if (imported_amount)
			total += rate * imported_amount;
	}
	console.log(`total traveling amount ${total}`, { bExportsIncomplete, bImportsIncomplete });
	return total;
}

async function getExportedAmount(home_network, home_asset, export_aa) {
	const api = networkApi[home_network];
	if (home_network === 'Obyte') {
		let balance = await api.getBalance(export_aa, home_asset, true);
		const vars = await dag.readAAStateVars(export_aa);
		for (let var_name in vars) {
			const matches = var_name.match(/^(\d+)_(yes|no)_by_/);
			if (!matches)
				continue;
			console.log(var_name);
			const [, claim_num, outcome] = matches;
			const stake = vars[var_name];
			const ongoing_claim = vars['o_' + claim_num];
			const finished_claim = vars['f_' + claim_num];
			if (!ongoing_claim && !finished_claim)
				throw Error(`neither ongoing nor finished claim ${claim_num}`);
			if (ongoing_claim)
				balance -= stake;
			else {
				const { current_outcome, stakes } = finished_claim;
				const total_stakes = stakes.yes + stakes.no;
				if (outcome === current_outcome)
					balance -= (stake / stakes[current_outcome]) * total_stakes;
			}
		}
		return balance;
	}
	else {
		let balance = BigNumber.from(0);

		// total expatriated
		const contract = new ethers.Contract(export_aa, exportJson.abi, api.getProvider());
		await processPastEvents(contract, contract.filters.NewExpatriation(), 0, null, (sender_address, amount, reward, foreign_address, data, event) => {
			console.log(`expat ${amount} from ${sender_address} to ${foreign_address}`);
			balance = balance.add(amount);
		});

		// total repatriated
		const last_claim_num = await contract.last_claim_num();
		for (let claim_num = 1; claim_num <= last_claim_num; claim_num++){
			const claim = await api.getClaim(export_aa, claim_num, null, true);
			if (claim.withdrawn)
				balance = balance.sub(claim.amount);
		}

		return balance;
	}
}

async function getImportedAmount(foreign_network, foreign_asset, import_aa) {
	if (foreign_network === 'Obyte') {
	//	const [row] = await db.query("SELECT SUM(amount) AS total FROM outputs WHERE asset=? AND is_spent=0 AND address!=?", [foreign_asset, import_aa]); // works on full node only
		const [issues_row] = await db.query("SELECT SUM(amount) AS total FROM unit_authors CROSS JOIN outputs USING(unit) WHERE asset=? AND outputs.address!=? AND unit_authors.address=?", [foreign_asset, import_aa, import_aa]);
		const [burns_row] = await db.query("SELECT SUM(amount) AS total FROM outputs LEFT JOIN unit_authors ON outputs.unit=unit_authors.unit AND unit_authors.address=? WHERE asset=? AND outputs.address=? AND unit_authors.address IS NULL", [import_aa, foreign_asset, import_aa]);
		return (issues_row.total || 0) - (burns_row.total || 0);
	}
	const api = networkApi[foreign_network];
	const token = new ethers.Contract(import_aa, erc20Json.abi, api.getProvider());
	return await token.totalSupply();
}


async function processPastEvents(contract, filter, since_block, thisArg, handler) {
	const events = await contract.queryFilter(filter, since_block);
	for (let event of events) {
		console.log('--- past event', event);
		let args = event.args.concat();
		args.push(event);
		await handler.apply(thisArg, args);
	}
}

async function start() {
	await wait(3 * 60 * 1000);
	calcTransferredAmounts();
	setInterval(calcTransferredAmounts, 3600 * 1000);
}

exports.start = start;
