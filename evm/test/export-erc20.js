require('@openzeppelin/test-helpers/configure')({
	provider: 'http://localhost:7545',
});

const Export = artifacts.require("Export");
//const Token = artifacts.require("Token");
const Token = artifacts.require("BadToken");
const GovernanceFactory = artifacts.require("GovernanceFactory");
const VotedValueFactory = artifacts.require("VotedValueFactory");
const CounterstakeFactory = artifacts.require("CounterstakeFactory");
const { BN, balance, ether, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
//const { web3 } = require('@openzeppelin/test-helpers/src/setup');

const { ethers } = require("ethers");
const exportJson = require('../build/contracts/Export.json');

const chai = require('chai');
// Enable and inject BN dependency
//chai.use(require('chai-bn')(BN));
const expect = chai.expect;

function bn2string(in_obj) {
	let obj = Array.isArray(in_obj) ? [] : {};
	for (let key in in_obj) {
		const v = in_obj[key];
		obj[key] = BN.isBN(v) ? v.toString() : v;
	}
	return obj;
}

function removeNumericKeys(obj) {
	let new_obj = {};
	for (let key in obj) {
		if (!key.match(/^\d+$/))
			new_obj[key] = obj[key];
	}
	return new_obj;
}


const bn0 = new BN(0);
const bn1 = new BN(1);
const no = bn0;
const yes = bn1;
const a0 = "0x0000000000000000000000000000000000000000";

const empty_claim = {
	amount: ether('0'),
//	reward: ether('0'),
	recipient_address: a0,
	claimant_address: a0,
	sender_address: '',
	data: '',
//	txid: '',
	txts: bn0,
	yes_stake: ether('0'),
	no_stake: ether('0'),
	current_outcome: no,
	is_large: false,
	period_number: bn0,
	ts: bn0,
	expiry_ts: bn0,
//	challenging_target: ether('0'),
	withdrawn: false,
	finished: false,
};

const provider = new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545"); // ganache



contract("Exporting an ERC20 token", async accounts => {
	const aliceAccount = accounts[0]
	const bobAccount = accounts[1]
	const charlieAccount = accounts[2]

	let instance, master;
	let token;
	let exportContract;
	
	before(async () => {
		let factory = await CounterstakeFactory.deployed();
		console.log('Factory address', factory.address);

		token = await Token.new("Exportable token", "TKN");
		console.log('ERC20 token address', token.address);

		await token.mint(aliceAccount, ether('200'), { from: bobAccount });
		expect(await token.balanceOf(aliceAccount)).to.be.bignumber.equal(ether('200'));

		await token.mint(bobAccount, ether('150'), { from: bobAccount });
		expect(await token.balanceOf(bobAccount)).to.be.bignumber.equal(ether('150'));

		await token.mint(charlieAccount, ether('100'), { from: bobAccount });
		expect(await token.balanceOf(charlieAccount)).to.be.bignumber.equal(ether('100'));

		const governanceFactory = await GovernanceFactory.deployed();
		const votedValueFactory = await VotedValueFactory.deployed();

	//	instance = await Export.new("Obyte", "OTKN", token.address, 150, 100, ether('100'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]);
	//	let res = await instance.setupGovernance(governanceFactory.address, votedValueFactory.address, {gas: 15.9e6});
	//	console.log('setupGovernance res', res)
		let res = await debug(factory.createExport("Obyte", "OTKN", token.address, 150, 100, ether('100'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], { from: aliceAccount }));
		console.log('create result', res)
		instance = await Export.at(res.logs[0].args.contractAddress);
		console.log('OTKN export address', instance.address);

		// test ethers events
		exportContract = new ethers.Contract(res.logs[0].args.contractAddress, exportJson.abi, provider);
	//	console.log('==== exportContract', exportContract)
	//	throw 12;
		exportContract.on('NewExpatriation', (sender_address, amount, reward, foreign_address, data, event) => {
			console.log('==== NewExpatriation event', sender_address, amount.toString(), reward.toString(), foreign_address, data, event);
		});
		exportContract.on('NewClaim', (claim_num, author_address, sender_address, recipient_address, txid, txts, amount, reward, stake, data, expiry_ts, event) => {
			console.log('=== NewClaim event', claim_num.toString(), author_address, sender_address, recipient_address, txid, txts, amount.toString(), reward.toString(), stake.toString(), data, expiry_ts, event)
		})
		exportContract.on('NewChallenge', (claim_num, author_address, stake, outcome, current_outcome, yes_stake, no_stake, expiry_ts, challenging_target, event) => {
			console.log('=== NewChallenge event', claim_num.toString(), author_address, stake.toString(), outcome, current_outcome, yes_stake.toString(), no_stake.toString(), expiry_ts, challenging_target.toString(), event)
		})
		exportContract.on('FinishedClaim', (claim_num, outcome, event) => {
			console.log('=== FinishedClaim event', claim_num.toString(), outcome, event)
		})


		// check that master's storage is intact
		master = await Export.deployed();
		let master_settings = await master.settings();
	//	console.log('master settings', master_settings);
		removeNumericKeys(master_settings);
		expect(master_settings.counterstake_coef100).to.be.bignumber.equal(new BN(160));

		let settings = await instance.settings();
	//	console.log('instance settings', settings);
		removeNumericKeys(settings);
		expect(settings.counterstake_coef100).to.be.bignumber.equal(new BN(150));


		await token.approve(instance.address, ether('80'), { from: aliceAccount });
		expect(await token.allowance(aliceAccount, instance.address)).to.be.bignumber.equal(ether('80'));

		await token.approve(instance.address, ether('60'), { from: bobAccount });
		expect(await token.allowance(bobAccount, instance.address)).to.be.bignumber.equal(ether('60'));

		await token.approve(instance.address, ether('50'), { from: charlieAccount });
		expect(await token.allowance(charlieAccount, instance.address)).to.be.bignumber.equal(ether('50'));

		// shortcuts for overloaded functions
		instance.challengeById = instance.methods['challenge(string,uint8,uint256)'];
		instance.challengeByNum = instance.methods['challenge(uint256,uint8,uint256)'];
		instance.getClaimById = instance.methods['getClaim(string)'];
		instance.getClaimByNum = instance.methods['getClaim(uint256)'];
		instance.withdrawById = instance.methods['withdraw(string)'];
		instance.withdrawByNum = instance.methods['withdraw(uint256)'];
	});


	it("start expatriation", async () => {
		const amount = ether('8')
		const reward = bn0
		const foreign_address = "ADDR"
		const data = '{"max_fee":1}'
		let res = await instance.transferToForeignChain(foreign_address, data, amount, reward, { from: aliceAccount });
	//	console.log('res', res);
		let event = res.logs[0];
	//	console.log('event', event);
		expectEvent(res, 'NewExpatriation', { foreign_address, data, sender_address: aliceAccount, amount, reward });
		console.log('start expatriation res', res)
		assert.equal(event.event, 'NewExpatriation');
		expect(event.args.foreign_address).to.equal("ADDR");
		expect(event.args.sender_address).to.equal(aliceAccount);
		expect(event.args.amount).to.be.bignumber.equal(amount);
		let bal = await token.balanceOf(instance.address);
		expect(bal).to.be.bignumber.equal(amount);
	});

	it("failed expatriation: with ETH", async () => {
		let promise = instance.transferToForeignChain("ADDR", "", ether('4'), ether('0'), { value: ether('4'), from: aliceAccount });
		await expectRevert(promise, "don't send ETH");
	});

	it("failed claim: low stake", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const stake = ether('3')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let promise = instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { from: aliceAccount });
		await expectRevert(promise, "the stake is too small");
	});

	it("start a claim", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { from: aliceAccount });
		console.log('claim res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: aliceAccount,
			claimant_address: aliceAccount,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(1)
		this.txts = txts
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		let ethers_claim = await exportContract['getClaim(string)'](claim_id);
		console.log('ethers_claim', ethers_claim);
		claim = removeNumericKeys(claim);
		console.log('claim', claim);
	/*	for (let key in expected_claim) {
		//	console.log(key);
			if (BN.isBN(claim[key]))
				expect(claim[key]).to.deep.bignumber.equal(expected_claim[key])
			else
				expect(claim[key]).to.deep.equal(expected_claim[key])
		}*/
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);
		expect(await instance.claim_nums(this.claim_id)).to.be.bignumber.equal(this.claim_num);
		expect(await instance.last_claim_num()).to.be.bignumber.equal(this.claim_num);
		expect(bn2string(await instance.getOngoingClaimNums())).to.be.deep.equal(['1']);

		// check that master contract's storage is intact
		let master_claim = await master.methods['getClaim(string)'](claim_id);
		master_claim = removeNumericKeys(master_claim);
		expect(bn2string(master_claim)).to.deep.equal(bn2string(empty_claim));
		expect(await master.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(bn0);
	});

	it("failed claim: same txid again", async () => {
		const txid = 'transid';
		const amount = ether('4')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let promise = instance.claim(txid, this.txts, amount, reward, stake, sender_address, a0, data, { from: aliceAccount });
		await expectRevert(promise, "this transfer has already been claimed");
	});

	it("failed challenge: same outcome", async () => {
		const stake = ether('4')
		let promise = instance.challengeById(this.claim_id, yes, stake, { from: bobAccount });
		await expectRevert(promise, "this outcome is already current");
	});

	it("failed challenge: nonexistent claim", async () => {
		const stake = ether('4')
		let promise = instance.challengeById('nonexistentclaim', yes, stake, { from: bobAccount });
		await expectRevert(promise, "no such claim");
	});

	it("challenge", async () => {
		const stake = ether('1');
		const outcome = no;
		const res = await debug(instance.challengeById(this.claim_id, outcome, stake, { from: bobAccount }));
		console.log('challenge res', res)
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: bobAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: stake, challenging_target: this.challenging_target });
		this.claim.no_stake = stake;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(stake);
	});

	it("failed withdraw: too early", async () => {
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "challenging period is still ongoing");
	});

	it("failed withdraw: non-owner", async () => {
		await time.increase(12 * 3600);
		let promise = instance.withdrawById(this.claim_id, { from: bobAccount });
		await expectRevert(promise, "you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn");
	});

	it("failed challenge: expired", async () => {
		const stake = ether('4')
		let promise = instance.challengeById(this.claim_id, no, stake, { from: bobAccount });
		await expectRevert(promise, "the challenging period has expired");
	});

	it("withdraw", async () => {
		let balance_before = await token.balanceOf(aliceAccount);
		console.log('balance before withdrawal', balance_before.toString())

		let res = await instance.withdrawById(this.claim_id, { from: aliceAccount });
		console.log('withdraw res', res)

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await token.balanceOf(aliceAccount);
		console.log('balance after withdrawal', balance_after.toString())
		expect(balance_before.add(ether('9'))).to.be.bignumber.equal(balance_after); // 4+4+1

		this.claim.withdrawn = true;
		this.claim.finished = true;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(ether('1'));
		expect(bn2string(await instance.getOngoingClaimNums())).to.be.deep.equal([]);
	});

	it("failed withdraw: already withdrawn", async () => {
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "already withdrawn");
	});

	it("failed challenge after withdraw", async () => {
		const stake = ether('4')
		let promise = instance.challengeById(this.claim_id, no, stake, { from: bobAccount });
		await expectRevert(promise, "the challenging period has expired");
	});

	it("failed claim: same txid again after finished", async () => {
		const txid = 'transid';
		const amount = ether('4')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let promise = instance.claim(txid, this.txts, amount, reward, stake, sender_address, a0, data, { from: aliceAccount });
		await expectRevert(promise, "this transfer has already been claimed");
	});

	it("new claim", async () => {
		const alice_balance_before = await token.balanceOf(aliceAccount)
		const bob_balance_before = await token.balanceOf(bobAccount)
		const txid = 'transid2';
		const amount = ether('4')
		const txts = Math.floor(Date.now()/1000)
		const stake = ether('4')
		const sender_address = "SENDER2"
		const data = '{"max_fee":2}'
		const reward = ether('0.04')
		const paid_amount = amount.sub(reward)
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, bobAccount, data, { from: aliceAccount });
		console.log('new claim res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: bobAccount,
			claimant_address: aliceAccount,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, bobAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(2)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: bobAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);
		expect(await instance.claim_nums(this.claim_id)).to.be.bignumber.equal(this.claim_num);
		expect(await instance.last_claim_num()).to.be.bignumber.equal(this.claim_num);
		expect(bn2string(await instance.getOngoingClaimNums())).to.be.deep.equal(['2']);

		const alice_balance_after = await token.balanceOf(aliceAccount)
		const bob_balance_after = await token.balanceOf(bobAccount)
		expect(alice_balance_before.sub(paid_amount).sub(stake)).to.be.bignumber.eq(alice_balance_after)
		expect(bob_balance_before.add(paid_amount)).to.be.bignumber.eq(bob_balance_after)
	});

	it("challenge by bob, outcome unchanged", async () => {
		await time.increase(3600);
		const stake = ether('3.5');
		const outcome = no;
		const res = await debug(instance.challengeById(this.claim_id, outcome, stake, { from: bobAccount }));
		console.log('bobs challenge res', res)
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: bobAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: stake });
		this.claim.no_stake = stake;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(stake);
	});

	it("challenge by charlie, outcome changed", async () => {
		await time.increase(3600);
		let balance_before = await token.balanceOf(charlieAccount);
		const stake = ether('5.5'); // need 6 total, got 9 total, 3 excess
		const outcome = no;
		const res = await debug(instance.challengeById(this.claim_id, outcome, stake, { from: charlieAccount }));
		console.log('charlies challenge res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.claim.expiry_ts = new BN(ts + 3 * 24 * 3600);
		this.claim.period_number = bn1;
		this.claim.current_outcome = no;
		this.claim.no_stake = this.claim.no_stake.add(ether('2.5')); // 2.5 accepted, 3 excess
		this.challenging_target = this.challenging_target.mul(new BN(150)).div(new BN(100));
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: charlieAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: this.claim.no_stake, challenging_target: this.challenging_target });
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(ether('2.5'));

		// check the balance
		let balance_after = await token.balanceOf(charlieAccount);
		expect(balance_before.sub(stake).add(ether('3'))).to.be.bignumber.equal(balance_after); // -5+2
	});

	it("failed withdraw by alice: you lost", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn");
	});

	it("withdraw by bob", async () => {
		let balance_before = await token.balanceOf(bobAccount);

		let res = await instance.withdrawById(this.claim_id, { from: bobAccount });
		console.log('bobs withdraw res', res)

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await token.balanceOf(bobAccount);
		let reward = ether('10').mul(ether('3.5')).div(ether('6'));
		console.log('bobs reward', reward.toString())
		expect(balance_before.add(reward)).to.be.bignumber.equal(balance_after); // 3.5/6*(4+6)

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(ether('4'));
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(ether('2.5'));
	});

	it("withdraw by charlie", async () => {
		let balance_before = await token.balanceOf(charlieAccount);

		let res = await instance.withdrawById(this.claim_id, { from: charlieAccount });
		console.log('charlies withdraw res', res)

		expectEvent.notEmitted(res, 'FinishedClaim');

		// check the balance
		let balance_after = await token.balanceOf(charlieAccount);
		let reward = ether('10').mul(ether('2.5')).div(ether('6'));
		console.log('charlies reward', reward.toString())
		expect(balance_before.add(reward)).to.be.bignumber.equal(balance_after); // 2.5/6*(4+6)

		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(ether('4'));
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(bn0);
	});

	it("failed repeated withdraw by charlie", async () => {
		let promise = instance.withdrawById(this.claim_id, { from: charlieAccount });
		await expectRevert(promise, "you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn");
	});


});
