"use strict";
const fetch = require('node-fetch');
const mutex = require('ocore/mutex.js');
const { wait } = require('./utils.js');

const PORTAL_BASE_URL = 'https://portal.sqd.dev'; // free public Portal, see https://docs.sqd.dev

// chainid -> SQD portal dataset slug, see https://docs.sqd.dev/en/data/networks/evm for the full list
const datasets = {
	1: 'ethereum-mainnet',
	56: 'binance-mainnet',
	97: 'binance-testnet',
	137: 'polygon-mainnet',
};

let last_req_ts = {};

async function waitBetweenRequests(dataset) {
	const timeout = 550; // the free public portal is rate-limited to 20 requests per 10 sec
	const passed = last_req_ts[dataset] ? Date.now() - last_req_ts[dataset] : Infinity;
	if (passed < timeout) {
		console.log(`will wait for ${timeout - passed} ms between sqd portal requests on ${dataset}`);
		await wait(timeout - passed);
	}
}

// low-level fetch, serialized and rate-limited per dataset, returns the raw (unparsed) response
async function portalRequest(dataset, url, options) {
	const unlock = await mutex.lock('sqd-' + dataset);
	await waitBetweenRequests(dataset);
	let response;
	try {
		response = await fetch(url, options);
	}
	catch (e) {
		last_req_ts[dataset] = Date.now();
		unlock();
		console.log(`request ${url} failed`, e);
		throw e;
	}
	last_req_ts[dataset] = Date.now();
	unlock();
	return response;
}

async function getBlockByTimestamp(dataset, ts) {
	const response = await portalRequest(dataset, `${PORTAL_BASE_URL}/datasets/${dataset}/timestamps/${ts}/block`);
	if (response.status === 404)
		throw Error(`sqd dataset ${dataset} has no block at or after ts ${ts} yet`);
	if (!response.ok)
		throw Error(`sqd getBlockByTimestamp ${dataset} ${ts} failed: ${response.status} ${await response.text()}`);
	const { block_number } = await response.json();
	if (!Number.isInteger(block_number))
		throw Error(`no block number from sqd dataset ${dataset} for ts ${ts}`);
	return block_number;
}

// streams the logs emitted by `address` (like etherscan's getLogs) from fromBlock up to toBlock
// and returns the sorted list of unique block numbers they appeared in.
// Uses /finalized-stream (rather than /stream) so that we never have to deal with reorgs (no parentBlockHash tracking needed).
async function getAddressLogBlocks({ dataset, address, fromBlock, toBlock, retry_count = 0 }) {
	const blocks = new Set();
	let cursor = fromBlock || 0;
	const lc_address = address.toLowerCase();
	const body = {
		type: 'evm',
		fields: {
			block: { number: true },
			log: { address: true, transactionHash: true },
		},
		logs: [{ address: [address] }],
	};
	while (toBlock === undefined || cursor <= toBlock) {
		const response = await portalRequest(dataset, `${PORTAL_BASE_URL}/datasets/${dataset}/finalized-stream`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...body, fromBlock: cursor, ...(toBlock !== undefined && { toBlock }) }),
		});
		if (response.status === 204) // range is above the dataset's finalized head, nothing more to fetch
			break;
		if (!response.ok) {
			const text = await response.text();
			let error;
			try { ({ error } = JSON.parse(text)); } catch (e) { }
			// rate_limit_error/availability_error are transient (e.g. "overloaded"), retry with backoff regardless of the HTTP status used.
			// Only *consecutive* failures count against the cap (reset below on success), so a long scan that occasionally
			// hits congestion keeps making progress instead of blowing the whole scan and restarting from fromBlock again.
			if (error && (error.type === 'rate_limit_error' || error.type === 'availability_error')) {
				if (++retry_count > 10)
					throw Error(`too many consecutive retries on sqd dataset ${dataset} after ${error.type} (${error.code})`);
				const retry_after = parseInt(response.headers.get('retry-after')) || Math.min(60, 5 * 2 ** (retry_count - 1));
				console.log(`sqd ${error.type} (${error.code}) on dataset ${dataset}, will wait ${retry_after} sec (consecutive retry ${retry_count})`);
				await wait(retry_after * 1000);
				continue;
			}
			throw Error(`sqd finalized-stream ${dataset} from ${cursor} failed: ${response.status} ${text}`);
		}
		retry_count = 0;
		const text = await response.text();
		console.log(`sqd response text for dataset ${dataset} address ${address} from ${cursor}:\n${text}`);
		const lines = text.trim().split('\n').filter(Boolean);
		if (lines.length === 0)
			break;
		let last_block = cursor - 1;
		for (const line of lines) {
			const block = JSON.parse(line);
			// don't trust the server-side filter blindly: boundary blocks are always included even without a match,
			// and (block.logs || []) might in principle contain logs from other addresses, so re-check address here
			if (Array.isArray(block.logs) && block.logs.some(log => log.address && log.address.toLowerCase() === lc_address))
				blocks.add(block.header.number);
			last_block = block.header.number;
		}
		if (last_block < cursor) // safety net, shouldn't normally happen
			break;
		cursor = last_block + 1;
		console.log(`sqd scan of ${address} on ${dataset}: now at block ${cursor}, ${blocks.size} matches so far`);
	}
	return Array.from(blocks);
}

async function getAddressBlocks({ dataset, chainid, address, startblock, startts, endblock, count = 0 }) {
	dataset = dataset || datasets[chainid];
	if (!dataset)
		throw Error(`no sqd dataset known for chain ${chainid}`);
	try {
		if (startts && !startblock)
			startblock = await getBlockByTimestamp(dataset, startts);
		// don't chase the last few minutes before the live head: there, /finalized-stream batches collapse to
		// just 1-3 blocks per request (vs thousands further back), so an open-ended scan can crawl for a very
		// long time without ever finishing. Only apply this fallback margin if the caller didn't already give us
		// an explicit endblock (e.g. evm-chain.js's top_available_block) - that's a well-defined, usually much
		// closer target, and capping it further here would silently leave an unscanned gap before it.
		let toBlock = endblock;
		if (toBlock === undefined) {
			const now = Math.floor(Date.now() / 1000);
			try {
				toBlock = await getBlockByTimestamp(dataset, now);
			}
			catch (e) {
				console.log(`sqd couldn't resolve a recent toBlock for dataset ${dataset}, will scan unbounded`, e);
			}
		}
		let blocks = await getAddressLogBlocks({ dataset, address, fromBlock: startblock, toBlock });
		console.log(`sqd history for ${address} on ${dataset}: ${blocks.join(',')}`);
		if (startblock) {
			const initLen = blocks.length;
			blocks = blocks.filter(b => b >= startblock);
			console.log(`${address} txs since ${startblock}: ${initLen} before filtering, ${blocks.length} after filtering`);
		}
		blocks.sort((a, b) => a - b);
		return blocks;
	}
	catch (e) {
		console.log(`getAddressBlocks sqd ${dataset} failed`, e);
		if (count > 5)
			throw e;
		console.log(`will retry getAddressBlocks sqd ${dataset} in 60 sec`);
		await wait(60 * 1000);
		count++;
		return await getAddressBlocks({ dataset, chainid, address, startblock, startts, endblock, count });
	}
}

async function test() {
	const blocks = await getAddressBlocks({ chainid: 56, address: '0x91C79A253481bAa22E7E481f6509E70e5E6A883F' });
	console.log(blocks);
	process.exit();
}
//test();

exports.getAddressBlocks = getAddressBlocks;
