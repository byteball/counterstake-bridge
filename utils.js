"use strict";
const mutex = require('ocore/mutex.js');

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
	);
}

exports.asyncCallWithTimeout = asyncCallWithTimeout;
exports.wait = wait;
exports.watchForDeadlock = watchForDeadlock;
exports.getVersion = getVersion;
exports.isRateLimitError = isRateLimitError;
