// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "./Governance.sol";
import "./VotedValue.sol";


contract VotedValueAddress is VotedValue {

	function(address) external validationCallback;
	function(address) external commitCallback;

	address public leader;
	address public current_value;

	// mapping(who => value)
	mapping(address => address) public choices;

	// mapping(value => votes)
	mapping(address => uint) public votesByValue;

	// mapping(value => mapping(who => votes))
	mapping(address => mapping(address => uint)) public votesByValueAddress;

	constructor() VotedValue(Governance(address(0))) {}

	// constructor(Governance _governance, address initial_value, function(address) external _validationCallback, function(address) external _commitCallback) VotedValue(_governance) {
	// 	leader = initial_value;
	// 	current_value = initial_value;
	// 	validationCallback = _validationCallback;
	// 	commitCallback = _commitCallback;
	// }

	function init(Governance _governance, address initial_value, function(address) external _validationCallback, function(address) external _commitCallback) external {
		require(address(governance) == address(0), "already initialized");
		governance = _governance;
		leader = initial_value;
		current_value = initial_value;
		validationCallback = _validationCallback;
		commitCallback = _commitCallback;
	}

	function vote(address value) nonReentrant external {
		_vote(value);
	}

	function voteAndDeposit(address value, uint amount) nonReentrant payable external {
		governance.deposit{value: msg.value}(msg.sender, amount);
		_vote(value);
	}

	function _vote(address value) private {
		validationCallback(value);
		address prev_choice = choices[msg.sender];
		bool hadVote = hasVote[msg.sender];
		if (prev_choice == leader)
			checkVoteChangeLock();

		// first, remove votes from the previous choice
		if (hadVote)
			removeVote(prev_choice);

		// then, add them to the new choice
		uint balance = governance.balances(msg.sender);
		require(balance > 0, "no balance");
		votesByValue[value] += balance;
		votesByValueAddress[value][msg.sender] = balance;
		choices[msg.sender] = value;
		hasVote[msg.sender] = true;

		// check if the leader has just changed
		if (votesByValue[value] > votesByValue[leader]){
			leader = value;
			challenging_period_start_ts = block.timestamp;
		}
	}

	function unvote() external {
		if (!hasVote[msg.sender])
			return;
		address prev_choice = choices[msg.sender];
		if (prev_choice == leader)
			checkVoteChangeLock();
		
		removeVote(prev_choice);
		delete choices[msg.sender];
		delete hasVote[msg.sender];
	}

	function removeVote(address value) internal {
		votesByValue[value] -= votesByValueAddress[value][msg.sender];
		votesByValueAddress[value][msg.sender] = 0;
	}

	function commit() nonReentrant external {
		require(leader != current_value, "already equal to leader");
		checkChallengingPeriodExpiry();
		current_value = leader;
		commitCallback(leader);
	}
}

