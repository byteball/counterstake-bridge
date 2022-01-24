// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./Counterstake.sol";


contract Export is Counterstake {

	using SafeERC20 for IERC20;

	event NewExpatriation(address sender_address, uint amount, int reward, string foreign_address, string data);

	string public foreign_network;
	string public foreign_asset;

	constructor (string memory _foreign_network, string memory _foreign_asset, address _tokenAddr, uint16 _counterstake_coef100, uint16 _ratio100, uint _large_threshold, uint[] memory _challenging_periods, uint[] memory _large_challenging_periods)
	Counterstake(_tokenAddr, _counterstake_coef100, _ratio100, _large_threshold, _challenging_periods, _large_challenging_periods)
	{
		foreign_network = _foreign_network;
		foreign_asset = _foreign_asset;
	}

	function initExport(string memory _foreign_network, string memory _foreign_asset) public
	{
		require(address(governance) == address(0), "already initialized");
		foreign_network = _foreign_network;
		foreign_asset = _foreign_asset;
	}

	function setupGovernance(GovernanceFactory governanceFactory, VotedValueFactory votedValueFactory) external {
		setupCounterstakeGovernance(governanceFactory, votedValueFactory, settings.tokenAddress);
	}


	function transferToForeignChain(string memory foreign_address, string memory data, uint amount, int reward) payable nonReentrant external {
		receiveStakeAsset(amount);
		if (reward >= 0)
			require(uint(reward) < amount, "reward too big");
		emit NewExpatriation(msg.sender, amount, reward, foreign_address, data);
	}


	function getRequiredStake(uint amount) public view override returns (uint) {
		return Math.max(amount * settings.ratio100 / 100, settings.min_stake);
	}


	function sendWithdrawals(address payable to_address, uint paid_claimed_amount, uint won_stake) internal override {
		uint total = won_stake + paid_claimed_amount;
		if (settings.tokenAddress == address(0)) {
			to_address.transfer(total);
		}
		else {
			IERC20(settings.tokenAddress).safeTransfer(to_address, total);
		}
	}

	function receiveMoneyInClaim(uint stake, uint paid_amount) internal override {
		receiveStakeAsset(stake + paid_amount);
	}

	function sendToClaimRecipient(address payable to_address, uint paid_amount) internal override {
		if (settings.tokenAddress == address(0)) {
			to_address.transfer(paid_amount);
		}
		else {
			IERC20(settings.tokenAddress).safeTransfer(to_address, paid_amount);
		}
	}

}
