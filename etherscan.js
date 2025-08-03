const _ = require('lodash');
const mutex = require('ocore/mutex.js');
const { request } = require('./request.js');
const { wait } = require('./utils.js');

let last_req_ts = {};


async function waitBetweenRequests(base_url, bWithApiKey) {
	const timeout = bWithApiKey ? 300 : 6000; // 6 sec
	const passed = last_req_ts[base_url] ? Date.now() - last_req_ts[base_url] : Infinity;
	if (passed < timeout) {
		console.log(`will wait for ${timeout - passed} ms between ${base_url} requests`);
		await wait(timeout - passed);
	}
}

async function getAddressHistory({ base_url, chainid, address, startblock, startts, api_key, bInternal = false, getUrl, getOptions, retry_count = 0 }) {
	const unlock = await mutex.lock(base_url);
	const retry = async (msg) => {
		unlock(msg);
		retry_count++;
		return await getAddressHistory({ base_url, chainid, address, startblock, startts, api_key, bInternal, getUrl, getOptions, retry_count });
	};
	const requestWithUnlock = async (url) => {
		try {
			return await request(url, getOptions ? getOptions() : {});
		}
		catch (e) {
			console.log(`request ${url} failed`, e);
			unlock();
			throw e;
		}
	};
	await waitBetweenRequests(base_url, !!api_key);
	if (startts && !startblock) {
		const defaultGetUrl = () => {
			let url = `${base_url}/api?chainid=${chainid}&module=block&action=getblocknobytime&timestamp=${startts}&closest=after`;
			if (api_key)
				url += `&apikey=${api_key}`;
			return url;
		};
		const resp = await requestWithUnlock(getUrl ? getUrl('block-by-ts', startts) : defaultGetUrl());
		last_req_ts[base_url] = Date.now();
		if (!getUrl && resp.message === 'NOTOK' && retry_count < 10)
			return await retry(`got "${resp.result}", will retry`);
		startblock = getUrl ? resp : resp.result;
		if (!startblock) {
			unlock();
			throw Error(`no block number from ${base_url} for ${startts}: ${JSON.stringify(resp)}`);
		}
		await waitBetweenRequests(base_url);
	}
	const defaultGetUrl = () => {
		const action = bInternal ? 'txlistinternal' : 'txlist';
		let url = `${base_url}/api?chainid=${chainid}&module=account&action=${action}&address=${address}`;
		if (startblock)
			url += `&startblock=${startblock}`;
		if (api_key)
			url += `&apikey=${api_key}`;
		return url;
	};
	const resp = await requestWithUnlock(getUrl ? getUrl('account-history', { address, bInternal, startblock }) : defaultGetUrl());
	last_req_ts[base_url] = Date.now();
	if (!getUrl && resp.message === 'NOTOK' && retry_count < 10)
		return await retry(`got "${resp.result}", will retry`);
	unlock();
	const history = getUrl ? resp : resp.result;
	if (!Array.isArray(history))
		throw Error(`no history from ${base_url} for ${address}: ${JSON.stringify(resp)}`);
	return history;
}

async function getAddressBlocks({ base_url, chainid, address, startblock, startts, api_key, getUrl, getOptions, count = 0 }) {
	try {
		const ext_history = await getAddressHistory({ base_url, chainid, address, startblock, startts, api_key, bInternal: false, getUrl, getOptions });
		const int_history = await getAddressHistory({ base_url, chainid, address, startblock, startts, api_key, bInternal: true, getUrl, getOptions });
		const history = ext_history.concat(int_history);
		let blocks = _.uniq(history.map(tx => parseInt(tx.blockNumber)));
		if (startblock) {
			const initLen = blocks.length;
			blocks = blocks.filter(b => b >= startblock); // kava explorer seems to ignore startblock and return the entire history
			console.log(`${address} txs since ${startblock}: ${initLen} before filtering, ${blocks.length} after filtering`);
		}
		blocks.sort();
		return blocks;
	}
	catch (e) {
		console.log(`getAddressBlocks ${base_url} failed`, e);
		if (count > 5)
			throw e;
		console.log(`will retry getAddressBlocks ${base_url} in 60 sec`);
		await wait(60 * 1000);
		count++;
		return await getAddressBlocks({ base_url, address, startblock, startts, api_key, getUrl, getOptions, count });
	}
}

async function test() {
	const blocks = await getAddressBlocks({ base_url: 'https://api.bscscan.com', address: '0x91C79A253481bAa22E7E481f6509E70e5E6A883F' });
	console.log(blocks);
	process.exit();
}
//test();

exports.getAddressBlocks = getAddressBlocks;
