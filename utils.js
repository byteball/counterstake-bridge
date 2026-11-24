"use strict";
const mutex = require('ocore/mutex.js');
const string_utils = require('ocore/string_utils.js');
const { createDecimal } = require('ocore/formula/common.js');

let watchedKeys = {};

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function die(msg) {
	throw Error(msg);
}

async function checkForDeadlock(key) {
	const t = setTimeout(die, 10 * 60 * 1000, `possible deadlock on ${key}`);
	const unlock = await mutex.lock(key);
	unlock();
	clearTimeout(t);
}

function watchForDeadlock(key) {
	if (watchedKeys[key])
		return console.log('already watching for deadlock on ' + key);
	watchedKeys[key] = true;
	setInterval(() => checkForDeadlock(key), 10 * 60 * 1000);
}

function getVersion(versions, aa) {
	for (let v in versions)
		if (versions[v] === aa)
			return v;
	return null;
}

async function asyncCallWithTimeout(asyncPromise, timeLimit = 60000) {
	let timeoutHandle;

	const timeoutPromise = new Promise((_resolve, reject) => {
		timeoutHandle = setTimeout(
			() => reject(new Error(`async call timeout limit ${timeLimit} reached`)),
			timeLimit
		);
	});

	return Promise.race([asyncPromise, timeoutPromise]).then(result => {
		clearTimeout(timeoutHandle);
		return result;
	});
}

function isRateLimitError(errMsg) {
	return (
		errMsg.includes("Your app has exceeded its compute units per second capacity")
		||
		errMsg.includes("rate-limit")
		||
		errMsg.includes("rate limit")
		||
		errMsg.includes("project ID request rate exceeded")
		||
		errMsg.includes("Too Many Requests")
		||
		errMsg.includes("Rate limited")
		||
		errMsg.includes("RequestRateLimitExceeded")
	);
}

// deterministic failures that won't go away on retry
const nonRetryableErrorCodes = ['CALL_EXCEPTION', 'INVALID_ARGUMENT', 'MISSING_ARGUMENT', 'UNEXPECTED_ARGUMENT', 'NUMERIC_FAULT'];

// for idempotent read calls only, never for sending transactions
async function retryRpc(f, { name = 'rpc call', attempts = 10, retryNull = false } = {}) {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await f();
			if (res != null || !retryNull || attempt >= attempts)
				return res;
			console.log(`${name} returned nothing, attempt ${attempt}, will retry`);
		}
		catch (e) {
			if (attempt >= attempts || nonRetryableErrorCodes.includes(e && e.code))
				throw e;
			console.log(`${name} attempt ${attempt} failed, will retry`, e);
		}
		await wait(1000 * attempt);
	}
}

// mirrors how Oscript's || stringifies operands in claim_hash: objects (incl. arrays) become "true". Buffers are malformed EVM strings, stored as BLOBs
function safeToString(value) {
	if (typeof value === 'string' || Buffer.isBuffer(value))
		return value;
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value);
	return 'true';
}

exports.asyncCallWithTimeout = asyncCallWithTimeout;
exports.wait = wait;
exports.watchForDeadlock = watchForDeadlock;
exports.getVersion = getVersion;
exports.isRateLimitError = isRateLimitError;
exports.retryRpc = retryRpc;
exports.safeToString = safeToString;

// old AAs didn't check that amount, reward and txts are integers: they can be objects, whose conversion throws
// converts like Oscript does when reading a scalar from trigger.data: numeric strings become numbers rounded to 15 significant digits
function toNumberOrNaN(value) {
	if (typeof value === 'number' || typeof value === 'string' && string_utils.toNumber(value) !== null)
		return createDecimal(value).toNumber();
	return NaN;
}

exports.toNumberOrNaN = toNumberOrNaN;
