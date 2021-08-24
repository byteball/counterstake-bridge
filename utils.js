"use strict";

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

exports.wait = wait;
