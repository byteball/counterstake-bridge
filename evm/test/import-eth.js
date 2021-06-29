require('@openzeppelin/test-helpers/configure')({
	provider: 'http://localhost:7545',
});

const Import = artifacts.require("Import");
const Oracle = artifacts.require("Oracle");
const CounterstakeFactory = artifacts.require("CounterstakeFactory");
const { BN, balance, ether, expectEvent, expectRevert, time, constants } = require('@openzeppelin/test-helpers');

const chai = require('chai');

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
const a0 = constants.ZERO_ADDRESS;


contract("Importing GBYTE with ETH stakes", async accounts => {
	const aliceAccount = accounts[0]
	const bobAccount = accounts[1]
	const charlieAccount = accounts[2]

	let instance;
	
	before(async () => {
		let factory = await CounterstakeFactory.deployed();
		console.log('Factory address', factory.address);

		const oracle = await Oracle.new();
		console.log('oracle address', oracle.address);
		await oracle.setPrice("Obyte", "_NATIVE_", new BN(30), new BN(1500), { from: aliceAccount });
		const { num, den } = await oracle.getPrice("Obyte", "_NATIVE_", { from: bobAccount });
		expect(num).to.be.bignumber.equal(new BN(30))
		expect(den).to.be.bignumber.equal(new BN(1500))

	//	instance = await Import.new("Obyte", "base", "Imported GBYTE", "GBYTE", a0, oracle.address, 150, 100, ether('100'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]);

		let res = await debug(factory.createImport("Obyte", "base", "Imported GBYTE", "GBYTE", a0, oracle.address, 150, 100, ether('100'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]));
		console.log('create result', res)
		instance = await Import.at(res.logs[0].args.contractAddress);
		console.log('GBYTE import address', instance.address);

		// shortcuts for overloaded functions
		instance.challengeById = instance.methods['challenge(string,uint8,uint256)'];
		instance.challengeByNum = instance.methods['challenge(uint256,uint8,uint256)'];
		instance.getClaimById = instance.methods['getClaim(string)'];
		instance.getClaimByNum = instance.methods['getClaim(uint256)'];
		instance.withdrawById = instance.methods['withdraw(string)'];
		instance.withdrawByNum = instance.methods['withdraw(uint256)'];
	});

	it("failed claim: no ETH sent", async () => {
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let promise = instance.claim("tx", 1e9, ether('7'), reward, ether('7'), sender_address, a0, data, { from: aliceAccount });
		await expectRevert(promise, "wrong amount received");
	});

	it("failed claim: low stake", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('50')
		const stake = ether('0.99')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let promise = instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
		await expectRevert(promise, "the stake is too small");
	});

	it("start a claim", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('50')
		const stake = ether('1')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
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
		this.txts = txts;
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
	//	console.log('claim', claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);
	});

	it("failed claim: same txid again", async () => {
		const txid = 'transid';
		const amount = ether('50')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let promise = instance.claim(txid, this.txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
		await expectRevert(promise, "this transfer has already been claimed");
	});

	it("failed challenge: same outcome", async () => {
		const stake = ether('4')
		let promise = instance.challengeById(this.claim_id, yes, stake, { value: stake, from: bobAccount });
		await expectRevert(promise, "this outcome is already current");
	});

	it("failed challenge: nonexistent claim", async () => {
		const stake = ether('4')
		let promise = instance.challengeById('nonexistentclaim', yes, stake, { value: stake, from: bobAccount });
		await expectRevert(promise, "no such claim");
	});

	it("challenge", async () => {
		const stake = ether('0.5');
		const outcome = no;
		const res = await instance.challengeById(this.claim_id, outcome, stake, { value: stake, from: bobAccount });
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
		let promise = instance.challengeById(this.claim_id, no, stake, { value: stake, from: bobAccount });
		await expectRevert(promise, "the challenging period has expired");
	});

	it("withdraw", async () => {
		let balance_before = await balance.current(aliceAccount);
		console.log('balance before withdrawal', balance_before.toString())

		let res = await instance.withdrawById(this.claim_id, { from: aliceAccount });
		console.log('withdraw res', res)

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance in stake asset
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(aliceAccount);
		console.log('balance after withdrawal', balance_after.toString())
		expect(balance_before.sub(gasCost).add(ether('1.5'))).to.be.bignumber.equal(balance_after); // 1+0.5

		// check the balance in E-GBYTE
		expect(await instance.balanceOf(aliceAccount)).to.be.bignumber.equal(ether('50'))

		this.claim.withdrawn = true;
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(ether('0.5'));
	});

	it("failed withdraw: already withdrawn", async () => {
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "already withdrawn");
	});

	it("failed challenge after withdraw", async () => {
		const stake = ether('4')
		let promise = instance.challengeById(this.claim_id, no, stake, { value: stake, from: bobAccount });
		await expectRevert(promise, "the challenging period has expired");
	});

	it("failed claim: same txid again after finished", async () => {
		const txid = 'transid';
		const amount = ether('50')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let promise = instance.claim(txid, this.txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
		await expectRevert(promise, "this transfer has already been claimed");
	});

	it("Episode 2: new claim", async () => {
		const txid = 'transid2';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('200')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
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
		this.claim_num = new BN(2)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);
	});

	it("challenge by bob, outcome unchanged", async () => {
		await time.increase(3600);
		const stake = ether('3.5');
		const outcome = no;
		const res = await debug(instance.challengeById(this.claim_id, outcome, stake, { value: stake, from: bobAccount }));
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: bobAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: stake });
		this.claim.no_stake = stake;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(stake);
	});

	it("challenge by charlie, outcome changed", async () => {
		await time.increase(3600);
		let balance_before = await balance.current(charlieAccount);
		const stake = ether('5.5'); // need 6 total, got 9 total, 3 excess
		const outcome = no;
		const res = await debug(instance.challengeById(this.claim_id, outcome, stake, { value: stake, from: charlieAccount }));
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
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(charlieAccount);
		expect(balance_before.sub(stake).sub(gasCost).add(ether('3'))).to.be.bignumber.equal(balance_after); // -5+2
	});

	it("failed withdraw by alice: you lost", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn");
	});

	it("withdraw by bob", async () => {
		let balance_before = await balance.current(bobAccount);

		let res = await instance.withdrawById(this.claim_id, { from: bobAccount });
		console.log('withdraw res', res)

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(bobAccount);
		let reward = ether('10').mul(ether('3.5')).div(ether('6'));
		console.log('bobs reward', reward.toString())
		expect(balance_before.sub(gasCost).add(reward)).to.be.bignumber.equal(balance_after); // 3.5/6*(4+6)

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(ether('4'));
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(ether('2.5'));
	});

	it("withdraw by charlie", async () => {
		let balance_before = await balance.current(charlieAccount);

		let res = await instance.withdrawById(this.claim_id, { from: charlieAccount });
		console.log('withdraw res', res)

		expectEvent.notEmitted(res, 'FinishedClaim');

		// check the balance
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(charlieAccount);
		let reward = ether('10').mul(ether('2.5')).div(ether('6'));
		console.log('charlies reward', reward.toString())
		expect(balance_before.sub(gasCost).add(reward)).to.be.bignumber.equal(balance_after); // 2.5/6*(4+6)

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

	it("start repatriation", async () => {
		const supply_before = await instance.totalSupply();
		const amount = ether('8')
		const reward = bn0
		const home_address = "ADDR"
		const data = ""
		let res = await instance.transferToHomeChain(home_address, data, amount, reward, { from: aliceAccount });
	//	console.log('res', res);
		expectEvent(res, 'NewRepatriation', { sender_address: aliceAccount, amount, reward, home_address, data });
		const supply_after = await instance.totalSupply();
		expect(supply_before.sub(amount)).to.be.bignumber.equal(supply_after);
		expect(supply_after).to.be.bignumber.equal(ether('42'));
	});


});
