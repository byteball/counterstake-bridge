// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./ERC20.sol";
import "./IOracle.sol";
import "./Counterstake.sol";
import "./VotedValueAddress.sol";
import "./CounterstakeLibrary.sol";
import "./IERC20WithSymbol.sol";


contract Import is ERC20, Counterstake {

	using SafeERC20 for IERC20;

	event NewRepatriation(address sender_address, uint amount, uint reward, string home_address, string data);

	address public oracleAddress;

	// min price of imported asset in terms of stake asset, to protect against malicious oracles
	// The price is multiplied by 1e20
	uint public min_price20;

	string public home_network;
	string public home_asset;

	bytes32 private constant base_hash = keccak256(abi.encodePacked("base"));
	bytes32 private constant zx_hash = keccak256(abi.encodePacked("0x0000000000000000000000000000000000000000"));


	constructor (string memory _home_network, string memory _home_asset, string memory __name, string memory __symbol, address stakeTokenAddr, address oracleAddr, uint16 _counterstake_coef100, uint16 _ratio100, uint _large_threshold, uint[] memory _challenging_periods, uint[] memory _large_challenging_periods) 
	Counterstake(stakeTokenAddr, _counterstake_coef100, _ratio100, _large_threshold, _challenging_periods, _large_challenging_periods) 
	ERC20(__name, __symbol)
	{
		initImport(_home_network, _home_asset, __name, __symbol, oracleAddr);
	}

	function initImport(string memory _home_network, string memory _home_asset, string memory __name, string memory __symbol, address oracleAddr) public
	{
		require(address(governance) == address(0), "already initialized");
		oracleAddress = oracleAddr;
		home_network = _home_network;
		home_asset = _home_asset;
		name = __name;
		symbol = __symbol;
		validateOracle(oracleAddr);
	}

	function setupGovernance(GovernanceFactory governanceFactory, VotedValueFactory votedValueFactory) override virtual public {
		super.setupGovernance(governanceFactory, votedValueFactory);
		governance.addVotedValue("oracleAddress", votedValueFactory.createVotedValueAddress(governance, oracleAddress, this.validateOracle, this.setOracle));
		governance.addVotedValue("min_price20", votedValueFactory.createVotedValueUint(governance, min_price20, this.validateMinPrice, this.setMinPrice));
	}

	function getOraclePrice(address oracleAddr) view private returns (uint, uint) {
		bytes32 home_asset_hash = keccak256(abi.encodePacked(home_asset));
		return IOracle(oracleAddr).getPrice(
			home_asset_hash == base_hash || home_asset_hash == zx_hash ? home_network : home_asset, 
			settings.tokenAddress == address(0) ? "_NATIVE_" : IERC20WithSymbol(settings.tokenAddress).symbol()
		);
	}

	function validateOracle(address oracleAddr) view public {
		require(CounterstakeLibrary.isContract(oracleAddr), "bad oracle");
		(uint num, uint den) = getOraclePrice(oracleAddr);
		require(num > 0 || den > 0, "no price from oracle");
	}

	function setOracle(address oracleAddr) onlyVotedValueContract external {
		oracleAddress = oracleAddr;
	}

	function validateMinPrice(uint _min_price20) pure external {
		// anything goes
	}

	function setMinPrice(uint _min_price20) onlyVotedValueContract external {
		min_price20 = _min_price20;
	}


	// repatriate
	function transferToHomeChain(string memory home_address, string memory data, uint amount, uint reward) external {
		_burn(msg.sender, amount);
		emit NewRepatriation(msg.sender, amount, reward, home_address, data);
	}

	function getRequiredStake(uint amount) public view override returns (uint) {
		(uint num, uint den) = getOraclePrice(oracleAddress);
		require(num > 0, "price num must be positive");
		require(den > 0, "price den must be positive");
		uint stake_in_image_asset = amount * settings.ratio100 / 100;
		return Math.max(Math.max(stake_in_image_asset * num / den, stake_in_image_asset * min_price20 / 1e20), settings.min_stake);
	}


	function sendWithdrawals(address payable to_address, uint paid_claimed_amount, uint won_stake) internal override {
		if (paid_claimed_amount > 0){
			_mint(to_address, paid_claimed_amount);
		}
		if (settings.tokenAddress == address(0))
			to_address.transfer(won_stake);
		else
			IERC20(settings.tokenAddress).safeTransfer(to_address, won_stake);
	}

	function receiveMoneyInClaim(uint stake, uint paid_amount) internal override {
		if (paid_amount > 0)
			_burn(msg.sender, paid_amount);
		receiveStakeAsset(stake);
	}

	function sendToClaimRecipient(address payable to_address, uint paid_amount) internal override {
		_mint(to_address, paid_amount);
	}

}
