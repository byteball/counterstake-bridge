require('@openzeppelin/test-helpers/configure')({
	provider: 'http://localhost:7545',
});

const Export = artifacts.require("Export");
const Governance = artifacts.require("Governance");
const VotedValueUint = artifacts.require("VotedValueUint");
const VotedValueUintArray = artifacts.require("VotedValueUintArray");
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


contract("Governance for exporting ETH", async accounts => {
	const aliceAccount = accounts[0]
	const bobAccount = accounts[1]
	const charlieAccount = accounts[2]

	let instance, governance, ratioVotedValue, counterstakeCoefVotedValue, largeThresholdVotedValue, challengingPeriodsVotedValue, largeChallengingPeriodsVotedValue;
	
	before(async () => {
		let factory = await CounterstakeFactory.deployed();
		console.log('Factory address', factory.address);

		let res = await debug(factory.createExport("Obyte", "OTKN", constants.ZERO_ADDRESS, 150, 100, ether('100'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]));
		console.log('create result', res)
		instance = await Export.at(res.logs[0].args.contractAddress);
		console.log('ETH export address', instance.address);

		// shortcuts for overloaded functions
		instance.getClaimById = instance.methods['getClaim(string)'];
		instance.getClaimByNum = instance.methods['getClaim(uint256)'];

		governance = await Governance.at(await instance.governance());
		console.log('governance address', governance.address);
		expect(await governance.votingTokenAddress()).to.be.equal(constants.ZERO_ADDRESS);
		expect(await governance.governedContractAddress()).to.be.equal(instance.address);

		ratioVotedValue = await VotedValueUint.at(await governance.votedValuesMap('ratio100'));
		console.log('ratio100 voted value address', ratioVotedValue.address);

		counterstakeCoefVotedValue = await VotedValueUint.at(await governance.votedValuesMap('counterstake_coef100'));
		console.log('counterstake_coef100 voted value address', counterstakeCoefVotedValue.address);

		largeThresholdVotedValue = await VotedValueUint.at(await governance.votedValuesMap('large_threshold'));
		console.log('large_threshold voted value address', largeThresholdVotedValue.address);

		challengingPeriodsVotedValue = await VotedValueUintArray.at(await governance.votedValuesMap('challenging_periods'));
		console.log('challenging_periods voted value address', challengingPeriodsVotedValue.address);

		largeChallengingPeriodsVotedValue = await VotedValueUintArray.at(await governance.votedValuesMap('large_challenging_periods'));
		console.log('large_challenging_periods voted value address', largeChallengingPeriodsVotedValue.address);

		governance.deposit = governance.methods['deposit(uint256)'];
		governance.withdrawAll = governance.methods['withdraw()'];
		governance.withdrawAmount = governance.methods['withdraw(uint256)'];
	});


	it("alice suggests decreasing the counterstake coef to 0.9 and fails", async () => {
		let promise = counterstakeCoefVotedValue.voteAndDeposit(new BN(90), ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "bad counterstake coef");
	});

	it("alice suggests increasing the ratio to 1.2", async () => {
		const old_value = (await instance.settings()).ratio100;
		expect(old_value).to.be.bignumber.equal(new BN(100));

		const new_value = new BN(120);
		const votes_amount = ether('10');
		let res = await ratioVotedValue.voteAndDeposit(new_value, votes_amount, { value: votes_amount, from: aliceAccount });
		expect(await ratioVotedValue.choices(aliceAccount)).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.votesByValue(new_value)).to.be.bignumber.equal(votes_amount);
		expect(await ratioVotedValue.votesByValueAddress(new_value, aliceAccount)).to.be.bignumber.equal(votes_amount);
		expect(await ratioVotedValue.leader()).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.current_value()).to.be.bignumber.equal(old_value);
		expect(await ratioVotedValue.hasVote(aliceAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(votes_amount);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(bn0);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(votes_amount);
		expect(await balance.current(ratioVotedValue.address)).to.be.bignumber.equal(bn0);
	})

	it("alice suggests decreasing the counterstake coef to 1 and fails", async () => {
		let promise = counterstakeCoefVotedValue.voteAndDeposit(new BN(100), ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "bad counterstake coef");
	});

	it("alice suggests increasing the counterstake coef over 640 and fails", async () => {
		let promise = counterstakeCoefVotedValue.vote(new BN(64000), { from: aliceAccount });
		await expectRevert(promise, "bad counterstake coef");
	});

	it("alice suggests increasing the ratio over 640 and fails", async () => {
		let promise = ratioVotedValue.voteAndDeposit(new BN(64000), ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "bad ratio");
	});

	// it("alice suggests setting large threshold to 0 and fails", async () => {
	// 	let promise = largeThresholdVotedValue.voteAndDeposit(bn0, { value: ether('10'), from: aliceAccount });
	// 	await expectRevert(promise, "bad large threshold");
	// });

	it("alice suggests setting challenging periods that get shorter and fails", async () => {
		let promise = challengingPeriodsVotedValue.voteAndDeposit([new BN(3600), new BN(1800)], ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "subsequent periods cannot get shorter");
	});

	it("alice suggests setting too long challenging periods and fails", async () => {
		let promise = largeChallengingPeriodsVotedValue.voteAndDeposit([new BN(3600), new BN(3 * 365 * 24 * 3600 + 1)], ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "some periods are longer than 3 years");
	});

	it("alice suggests setting empty challenging periods and fails", async () => {
		let promise = largeChallengingPeriodsVotedValue.voteAndDeposit([], ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "empty periods");
	});

	it("alice tries to commit too early and fails", async () => {
		let promise = ratioVotedValue.commit({ from: aliceAccount });
		await expectRevert(promise, "challenging period not expired yet");
	});

	it("alice tries to withdraw too early and fails", async () => {
		let promise = governance.withdrawAll({ from: aliceAccount });
		await expectRevert(promise, "some votes not removed yet");
	});

	it("alice suggests another ratio while her value is already the leader and fails", async () => {
		let promise = ratioVotedValue.voteAndDeposit(new BN(130), ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "you cannot change your vote yet");
	});

	it("alice tries to untie her vote while her value is already the leader and fails", async () => {
		let promise = ratioVotedValue.unvote({ from: aliceAccount });
		await expectRevert(promise, "you cannot change your vote yet");
	});

	it("bob tries to withdraw despite having no balance and fails", async () => {
		let promise = governance.withdrawAll({ from: bobAccount });
		await expectRevert(promise, "zero withdrawal requested");
	});

	it("bob tries to withdraw a specific amount despite having no balance and fails", async () => {
		let promise = governance.withdrawAmount(ether('1'), { from: bobAccount });
		await expectRevert(promise, "not enough balance");
	});

	it("bob waits and commits ratio = 1.2", async () => {
		await time.increase(10 * 24 * 3600);
		const old_value = (await instance.settings()).ratio100;
		expect(old_value).to.be.bignumber.equal(new BN(100));

		const new_value = new BN(120);
		const votes_amount = ether('10');
		let res = await ratioVotedValue.commit({ from: bobAccount });
		expect(await ratioVotedValue.choices(aliceAccount)).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.votesByValue(new_value)).to.be.bignumber.equal(votes_amount);
		expect(await ratioVotedValue.votesByValueAddress(new_value, aliceAccount)).to.be.bignumber.equal(votes_amount);
		expect(await ratioVotedValue.leader()).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.current_value()).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.hasVote(aliceAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(votes_amount);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(bn0);

		// updated in the governed contract itself
		expect((await instance.settings()).ratio100).to.be.bignumber.equal(new_value);
	})

	it("alice tries to withdraw too early again and fails", async () => {
		let promise = governance.withdrawAll({ from: aliceAccount });
		await expectRevert(promise, "some votes not removed yet");
	});

	it("alice suggests another ratio while her value is already the leader again and fails", async () => {
		let promise = ratioVotedValue.voteAndDeposit(new BN(130), ether('10'), { value: ether('10'), from: aliceAccount });
		await expectRevert(promise, "you cannot change your vote yet");
	});

	it("alice tries to untie her vote while her value is already the leader again and fails", async () => {
		let promise = ratioVotedValue.unvote({ from: aliceAccount });
		await expectRevert(promise, "you cannot change your vote yet");
	});

	it("alice waits and unties her vote", async () => {
		await time.increase(30 * 24 * 3600);

		const new_value = new BN(120);
		const votes_amount = ether('10');
		let res = await ratioVotedValue.unvote({ from: aliceAccount });
		expect(await ratioVotedValue.choices(aliceAccount)).to.be.bignumber.equal(bn0);
		expect(await ratioVotedValue.votesByValue(new_value)).to.be.bignumber.equal(bn0);
		expect(await ratioVotedValue.votesByValueAddress(new_value, aliceAccount)).to.be.bignumber.equal(bn0);
		expect(await ratioVotedValue.leader()).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.current_value()).to.be.bignumber.equal(new_value);
		expect(await ratioVotedValue.hasVote(aliceAccount)).to.be.false;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(votes_amount);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(bn0);

		// updated in the governed contract itself
		expect((await instance.settings()).ratio100).to.be.bignumber.equal(new_value);
	})

	it("alice withdraws successfully", async () => {
		let balance_before = await balance.current(aliceAccount);
		const votes_amount = ether('10');
		let res = await governance.withdrawAll({ from: aliceAccount });
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(bn0);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(bn0);

		// check the balance
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(aliceAccount);
		console.log('balance after withdrawal', balance_after.toString())
		expect(balance_before.sub(gasCost).add(votes_amount)).to.be.bignumber.equal(balance_after);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(bn0);
	})

	it("failed claim: low stake because of the new ratio", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const stake = ether('4.01')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let promise = instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
		await expectRevert(promise, "the stake is too small");
	});

	it("start a claim", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const stake = ether('4.8') // amount * 1.2
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		console.log('ts', ts)
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
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(1)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);
	});

	it("Episode 2: alice suggests new challenging periods", async () => {
		this.old_value = await Promise.all([0, 1, 2, 3].map(async n => (await instance.getChallengingPeriod(n, false)).toNumber()));
		expect(this.old_value).to.be.deep.equal([12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]);

		this.alices_value = [15 * 3600, 4 * 24 * 3600, 10 * 24 * 3600, 60 * 24 * 3600];
		const votes_amount = ether('6');
		const key = await challengingPeriodsVotedValue.getKey(this.alices_value);
		let res = await challengingPeriodsVotedValue.voteAndDeposit(this.alices_value, votes_amount, { value: votes_amount, from: aliceAccount });
		const alicesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(aliceAccount, n)).toNumber()));
		expect(alicesChoice).to.be.deep.equal(this.alices_value);
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(votes_amount);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, aliceAccount)).to.be.bignumber.equal(votes_amount);
		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.alices_value);
		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.old_value);
		expect(await challengingPeriodsVotedValue.hasVote(aliceAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(votes_amount);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(bn0);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(votes_amount);
		expect(await balance.current(challengingPeriodsVotedValue.address)).to.be.bignumber.equal(bn0);

		this.alice_votes = votes_amount;
	});

	it("bob suggests other challenging periods", async () => {
		this.bobs_value = [16 * 3600, 5 * 24 * 3600, 11 * 24 * 3600, 66 * 24 * 3600];
		const votes_amount = ether('5');
		const key = await challengingPeriodsVotedValue.getKey(this.bobs_value);
		let res = await challengingPeriodsVotedValue.voteAndDeposit(this.bobs_value, votes_amount, { value: votes_amount, from: bobAccount });
		const alicesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(aliceAccount, n)).toNumber()));
		expect(alicesChoice).to.be.deep.equal(this.alices_value);
		const bobsChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(bobAccount, n)).toNumber()));
		expect(bobsChoice).to.be.deep.equal(this.bobs_value);
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(votes_amount);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, bobAccount)).to.be.bignumber.equal(votes_amount);
		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.alices_value);
		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.old_value);
		expect(await challengingPeriodsVotedValue.hasVote(bobAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(votes_amount);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(votes_amount.add(this.alice_votes));
		expect(await balance.current(challengingPeriodsVotedValue.address)).to.be.bignumber.equal(bn0);

		this.bob_votes = votes_amount;
	});

	it("bob changes his mind and makes another suggestion", async () => {
		const old_bobs_value = this.bobs_value;
		this.bobs_value = [17 * 3600, 6 * 24 * 3600, 12 * 24 * 3600, 68 * 24 * 3600];
		const votes_amount = ether('2');
		this.bob_votes = this.bob_votes.add(votes_amount);
		const old_key = await challengingPeriodsVotedValue.getKey(old_bobs_value);
		const key = await challengingPeriodsVotedValue.getKey(this.bobs_value);
		let res = await challengingPeriodsVotedValue.voteAndDeposit(this.bobs_value, votes_amount, { value: votes_amount, from: bobAccount });
		
		const alicesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(aliceAccount, n)).toNumber()));
		expect(alicesChoice).to.be.deep.equal(this.alices_value);
		const bobsChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(bobAccount, n)).toNumber()));
		expect(bobsChoice).to.be.deep.equal(this.bobs_value);
		
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(this.bob_votes);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, bobAccount)).to.be.bignumber.equal(this.bob_votes);
		
		expect(await challengingPeriodsVotedValue.votesByValue(old_key)).to.be.bignumber.equal(bn0);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(old_key, bobAccount)).to.be.bignumber.equal(bn0);
		
		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.bobs_value);

		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.old_value);
		
		expect(await challengingPeriodsVotedValue.hasVote(bobAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(this.bob_votes);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(this.bob_votes.add(this.alice_votes));
		expect(await balance.current(challengingPeriodsVotedValue.address)).to.be.bignumber.equal(bn0);
	});

	it("alice deposits more but her vote weight doesn't change", async () => {
		this.alices_value = [15 * 3600, 4 * 24 * 3600, 10 * 24 * 3600, 60 * 24 * 3600];
		const new_votes_amount = ether('4');
		const key = await challengingPeriodsVotedValue.getKey(this.alices_value);

		let res = await governance.deposit(new_votes_amount, { value: new_votes_amount, from: aliceAccount });

		const alicesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(aliceAccount, n)).toNumber()));
		expect(alicesChoice).to.be.deep.equal(this.alices_value);
		
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(this.alice_votes);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, aliceAccount)).to.be.bignumber.equal(this.alice_votes);

		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.bobs_value);
		
		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.old_value);
		
		this.alice_votes = this.alice_votes.add(new_votes_amount);

		expect(await challengingPeriodsVotedValue.hasVote(aliceAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(this.bob_votes);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(this.alice_votes.add(this.bob_votes));
		expect(await balance.current(challengingPeriodsVotedValue.address)).to.be.bignumber.equal(bn0);

	});

	it("alice votes again and her weight updates", async () => {
		const key = await challengingPeriodsVotedValue.getKey(this.alices_value);

		let res = await challengingPeriodsVotedValue.vote(this.alices_value, { from: aliceAccount });

		const alicesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(aliceAccount, n)).toNumber()));
		expect(alicesChoice).to.be.deep.equal(this.alices_value);
		
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(this.alice_votes);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, aliceAccount)).to.be.bignumber.equal(this.alice_votes);

		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.alices_value);
		
		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.old_value);
		
		expect(await challengingPeriodsVotedValue.hasVote(aliceAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(this.bob_votes);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(this.alice_votes.add(this.bob_votes));
		expect(await balance.current(challengingPeriodsVotedValue.address)).to.be.bignumber.equal(bn0);

		// alice: 6 + 4 = 10
		// bob: 5 + 2 = 7

	});

	it("charlie supports bob", async () => {
		this.charlie_votes = ether('4');
		const key = await challengingPeriodsVotedValue.getKey(this.bobs_value);
		let res = await challengingPeriodsVotedValue.voteAndDeposit(this.bobs_value, this.charlie_votes, { value: this.charlie_votes, from: charlieAccount });
		
		const alicesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(aliceAccount, n)).toNumber()));
		expect(alicesChoice).to.be.deep.equal(this.alices_value);
		const bobsChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(bobAccount, n)).toNumber()));
		expect(bobsChoice).to.be.deep.equal(this.bobs_value);
		const charliesChoice = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.choices(charlieAccount, n)).toNumber()));
		expect(charliesChoice).to.be.deep.equal(this.bobs_value);
		
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(this.bob_votes.add(this.charlie_votes));
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, bobAccount)).to.be.bignumber.equal(this.bob_votes);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, charlieAccount)).to.be.bignumber.equal(this.charlie_votes);
		
		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.bobs_value);

		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.old_value);
		
		expect(await challengingPeriodsVotedValue.hasVote(charlieAccount)).to.be.true;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);
		expect(await governance.balances(bobAccount)).to.be.bignumber.equal(this.bob_votes);
		expect(await governance.balances(charlieAccount)).to.be.bignumber.equal(this.charlie_votes);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(this.bob_votes.add(this.alice_votes).add(this.charlie_votes));
		expect(await balance.current(challengingPeriodsVotedValue.address)).to.be.bignumber.equal(bn0);
	});

	it("alice waits and commits the bobs value", async () => {
		await time.increase(10 * 24 * 3600);
		let res = await challengingPeriodsVotedValue.commit({ from: aliceAccount });

		const leader = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.leader(n)).toNumber()));
		expect(leader).to.be.deep.equal(this.bobs_value);

		const current_value = await Promise.all([0, 1, 2, 3].map(async n => (await challengingPeriodsVotedValue.current_value(n)).toNumber()));
		expect(current_value).to.be.deep.equal(this.bobs_value);

		// updated in the governed contract itself
		const new_value = await Promise.all([0, 1, 2, 3].map(async n => (await instance.getChallengingPeriod(n, false)).toNumber()));
		expect(new_value).to.be.deep.equal(this.bobs_value);
	})

	it("alice unties her vote without waiting since she lost", async () => {

		let res = await challengingPeriodsVotedValue.unvote({ from: aliceAccount });

		await expectRevert(challengingPeriodsVotedValue.choices(aliceAccount, 0), "revert");

		const key = await challengingPeriodsVotedValue.getKey(this.alices_value);
		expect(await challengingPeriodsVotedValue.votesByValue(key)).to.be.bignumber.equal(bn0);
		expect(await challengingPeriodsVotedValue.votesByValueAddress(key, aliceAccount)).to.be.bignumber.equal(bn0);

		expect(await ratioVotedValue.hasVote(aliceAccount)).to.be.false;
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);
	})

	it("alice tries to withdraw too much and fails", async () => {
		let promise = governance.withdrawAmount(ether('10.01'), { from: aliceAccount });
		await expectRevert(promise, "not enough balance");
	});

	it("alice withdraws successfully", async () => {
		let balance_before = await balance.current(aliceAccount);
		const amount = ether('8');
		this.alice_votes = this.alice_votes.sub(amount);
		let res = await governance.withdrawAmount(amount, { from: aliceAccount });
		expect(await governance.balances(aliceAccount)).to.be.bignumber.equal(this.alice_votes);

		// check the balance
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(aliceAccount);
		console.log('balance after withdrawal', balance_after.toString())
		expect(balance_before.sub(gasCost).add(amount)).to.be.bignumber.equal(balance_after);

		expect(await balance.current(governance.address)).to.be.bignumber.equal(this.bob_votes.add(this.alice_votes).add(this.charlie_votes));
	})


});
