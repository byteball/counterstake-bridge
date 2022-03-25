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

exports.wait = wait;
exports.watchForDeadlock = watchForDeadlock;
