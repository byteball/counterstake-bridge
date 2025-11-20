const _ = require('lodash');
const mutex = require('ocore/mutex.js');
const conf = require('ocore/conf.js');
const { request } = require('./request.js');
const { wait } = require('./utils.js');

let last_req_ts = 0;

const chains = {
	1: 'eth',
	56: 'bsc',
	137: 'polygon',
};

async function waitBetweenRequests() {
	const timeout = 100;
	const passed = Date.now() - last_req_ts;
	if (passed < timeout) {
		console.log(`will wait for ${timeout - passed} ms between moralis requests`);
		await wait(timeout - passed);
	}
}

async function getAddressHistory({ chainid, address, startblock, startts, bInternal = false, retry_count = 0 }) {
	const unlock = await mutex.lock('moralis');
	const chain = chains[chainid];
	const retry = async (msg) => {
		unlock(msg);
		await wait(1000);
		retry_count++;
		return await getAddressHistory({ chainid, address, startblock, startts, bInternal, retry_count });
	};
	const requestWithUnlock = async (url) => {
		try {
			return await request(url, {}, { 'X-API-Key': conf.moralis_api_key });
		}
		catch (e) {
			console.log(`request ${url} on chain ${chain} failed`, e);
			unlock();
			throw e;
		}
	};
	await waitBetweenRequests();
//	let url = `https://deep-index.moralis.io/api/v2.2/${address}/verbose?chain=${chain}&order=ASC&limit=100&include=internal_transactions`; // doesn't include internal txs
	let url = `https://deep-index.moralis.io/api/v2.2/wallets/${address}/history?chain=${chain}&order=ASC&limit=100&include_internal_transactions=true`;
	if (startblock)
		url += `&from_block=` + startblock;
	if (startts)
		url += `&from_date=` + startts;
	
	try {
		var resp = await requestWithUnlock(url);
		last_req_ts = Date.now();
	}
	catch (e) {
		console.log('error from moralis', e);
		if (e.toString().includes("Too Many Requests"))
			return await retry(`got "${e}" on chain ${chain}, will retry`);
		throw e;
	}
	unlock();
	const history = resp.result;
//	console.log(history)
	if (!Array.isArray(history))
		throw Error(`no history from moralis on chain ${chain} for ${address}: ${JSON.stringify(resp)}`);
	return history;
}

async function getAddressBlocks({ chainid, address, startblock, startts, count = 0 }) {
	try {
		const history = await getAddressHistory({ chainid, address, startblock, startts, bInternal: false });
		let blocks = _.uniq(history.map(tx => parseInt(tx.block_number)));
		if (startblock) {
			const initLen = blocks.length;
			blocks = blocks.filter(b => b >= startblock); // kava explorer seems to ignore startblock and return the entire history
			console.log(`${address} txs since ${startblock}: ${initLen} before filtering, ${blocks.length} after filtering`);
		}
		blocks.sort((a, b) => a - b);
		return blocks;
	}
	catch (e) {
		console.log(`getAddressBlocks moralis on chain ${chainid} failed`, e);
		if (count > 5)
			throw e;
		console.log(`will retry getAddressBlocks moralis on chain ${chainid} in 60 sec`);
		await wait(60 * 1000);
		count++;
		return await getAddressBlocks({ chainid, address, startblock, startts, count });
	}
}

async function test() {
//	const blocks = await getAddressBlocks({ address: '0x91C79A253481bAa22E7E481f6509E70e5E6A883F', chainid: 56 });
//	const blocks = await getAddressBlocks({ address: '0xeb34De0C4B2955CE0ff1526CDf735c9E6d249D09', chainid: 56, startblock: 64133048 });
	const blocks = await getAddressBlocks({ address: '0xAB5F7a0e20b0d056Aed4Aa4528C78da45BE7308b', chainid: 137, startblock: 79132931 });
	console.log(blocks);
	process.exit();
}
//test();

exports.getAddressBlocks = getAddressBlocks;
