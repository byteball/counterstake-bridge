"use strict";
const network = require('ocore/network.js');
const operator = require('aabot/operator.js');

async function start() {
	//await operator.start();
	network.start();
	network.requestFromLightVendor('light/dry_run_aa', {
		address: 'EWPV5JZYOIKDCL6MTNHTWWO327FAEGET',
		trigger: {
			address: 'KUNNTFAD3G55IWXSNKTDRKH222E4DF7R',
			outputs: {
				base: 1e4,
				'S/oCESzEO8G2hvQuI6HsyPr0foLfKwzs+GU73nO9H40=': 100e4
			},
			data: {
				data: {
					oswap_aa: 'MBTF5GG44S3ARJHIZH3DEAB4DGUCHCF6',
					address: '5DR2PSOXOWBMW6FOR3ED6UPU2SBHEYJN',
				}
			}
		}
	}, (ws, req, resp) => {
		console.error(require('util').inspect(resp, {depth:null}));
	});
}


start();
