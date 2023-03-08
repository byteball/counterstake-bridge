CREATE TABLE IF NOT EXISTS bridges (
	bridge_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	home_network VARCHAR(10) NOT NULL,
	home_asset VARCHAR(50) NOT NULL,
	home_asset_decimals TINYINT NULL,
	home_symbol VARCHAR(20) NULL,
	export_aa VARCHAR(50) NULL UNIQUE,
	export_assistant_aa VARCHAR(50) NULL UNIQUE,
	foreign_network VARCHAR(10) NOT NULL,
	foreign_asset VARCHAR(50) NOT NULL UNIQUE,
	foreign_asset_decimals TINYINT NULL,
	foreign_symbol VARCHAR(20) NULL,
	stake_asset VARCHAR(50) NULL,
	import_aa VARCHAR(50) NULL UNIQUE,
	import_assistant_aa VARCHAR(50) NULL UNIQUE,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	e_v VARCHAR(6) NOT NULL DEFAULT 'v1', -- export version of ABI/AA
	i_v VARCHAR(6) NOT NULL DEFAULT 'v1', -- import version
	ea_v VARCHAR(6) NOT NULL DEFAULT 'v1', -- export assistant version
	ia_v VARCHAR(6) NOT NULL DEFAULT 'v1' -- import assistant version
);
-- query separator

CREATE TABLE IF NOT EXISTS pooled_assistants (
	assistant_aa VARCHAR(50) NOT NULL PRIMARY KEY,
	bridge_id INT NOT NULL,
	bridge_aa VARCHAR(50) NOT NULL,
	network VARCHAR(10) NOT NULL,
	side CHAR(6) NOT NULL, -- export or import
	manager VARCHAR(50) NOT NULL,
	shares_asset VARCHAR(50) NOT NULL,
	shares_symbol VARCHAR(20) NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`version` VARCHAR(6) NOT NULL DEFAULT 'v1',
	FOREIGN KEY (bridge_id) REFERENCES bridges(bridge_id)
);
-- query separator
CREATE INDEX IF NOT EXISTS assistantByBridgeId ON pooled_assistants(bridge_id);
-- query separator
CREATE INDEX IF NOT EXISTS assistantByBridgeAA ON pooled_assistants(bridge_aa);
-- query separator
CREATE INDEX IF NOT EXISTS assistantByManager ON pooled_assistants(manager);
-- query separator

-- via Export AA on the home network
-- via Import AA on the foreign network
CREATE TABLE IF NOT EXISTS transfers (
	transfer_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	bridge_id INT NOT NULL,
	type CHAR(12) NOT NULL, -- expatriation or repatriation
	amount VARCHAR(78) NOT NULL, -- enough capacity for 2**256
	reward VARCHAR(78) NOT NULL, -- enough capacity for 2**256
	sender_address VARCHAR(50) NULL,
	dest_address VARCHAR(50) NOT NULL,
	data TEXT NOT NULL, -- empty string if none
	txid VARCHAR(66) NOT NULL, -- with 0x
	txts INT NOT NULL,
	is_confirmed TINYINT NULL DEFAULT 1,
	is_bad TINYINT NOT NULL DEFAULT 0,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (txid, bridge_id, amount, reward, sender_address, dest_address, data, is_confirmed), -- txts not included as it might change after reorg
	FOREIGN KEY (bridge_id) REFERENCES bridges(bridge_id)
);
-- query separator
CREATE INDEX IF NOT EXISTS transferByBridge ON transfers(bridge_id);
-- query separator

-- via Import AA on the foreign network
-- via Export AA on the home network
CREATE TABLE IF NOT EXISTS claims (
--	claim_id VARCHAR(200) NOT NULL PRIMARY KEY,
	claim_num INTEGER NOT NULL,
	bridge_id INT NOT NULL,
	type CHAR(12) NOT NULL, -- expatriation or repatriation
	amount VARCHAR(78) NOT NULL, -- enough capacity for 2**256
	reward VARCHAR(78) NOT NULL, -- enough capacity for 2**256
	sender_address VARCHAR(50) NULL,
	dest_address VARCHAR(50) NOT NULL,
	claimant_address VARCHAR(50) NOT NULL,
	data TEXT NOT NULL, -- empty string if none
	txid VARCHAR(66) NOT NULL,
	txts INT NOT NULL,
	transfer_id INT NULL UNIQUE, -- if valid
	claim_txid VARCHAR(66) NOT NULL, -- including 0x
	my_stake VARCHAR(78) NOT NULL DEFAULT '0',
	is_finished TINYINT NOT NULL DEFAULT 0,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (claim_num, bridge_id, type),
	UNIQUE (txid, txts, amount, reward, sender_address, dest_address, data, type, bridge_id),
	FOREIGN KEY (bridge_id) REFERENCES bridges(bridge_id),
	FOREIGN KEY (transfer_id) REFERENCES transfers(transfer_id)
);
-- query separator
CREATE INDEX IF NOT EXISTS claimsByBridge ON claims(bridge_id);
-- query separator
CREATE INDEX IF NOT EXISTS claimsByDestAddress ON claims(dest_address);
-- query separator
CREATE INDEX IF NOT EXISTS claimsByClaimantAddress ON claims(claimant_address);
-- query separator
CREATE INDEX IF NOT EXISTS claimsByTransferId ON claims(transfer_id);
-- query separator
CREATE INDEX IF NOT EXISTS claimsByFinished ON claims(is_finished);
-- query separator
CREATE INDEX IF NOT EXISTS claimsByCreationDate ON claims(creation_date);
-- query separator

CREATE TABLE IF NOT EXISTS challenges (
	challenge_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
--	claim_id VARCHAR(200) NOT NULL,
	claim_num INTEGER NOT NULL,
	bridge_id INT NOT NULL,
	type CHAR(12) NOT NULL, -- expatriation or repatriation
	address VARCHAR(50) NOT NULL,
	stake_on VARCHAR(3) NOT NULL, -- yes or no
	stake VARCHAR(78) NOT NULL,
	challenge_txid VARCHAR(66) NOT NULL, -- including 0x
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (challenge_txid, bridge_id),
	FOREIGN KEY (claim_num, bridge_id, type) REFERENCES claims(claim_num, bridge_id, type),
	FOREIGN KEY (bridge_id) REFERENCES bridges(bridge_id)
);
-- query separator
CREATE INDEX IF NOT EXISTS challengesByClaimNum ON challenges(claim_num);
-- query separator
CREATE INDEX IF NOT EXISTS challengesByBridge ON challenges(bridge_id);
-- query separator
CREATE INDEX IF NOT EXISTS challengesByAddress ON challenges(address);
-- query separator

CREATE TABLE IF NOT EXISTS last_blocks (
	network VARCHAR(10) NOT NULL PRIMARY KEY,
	last_block INT NOT NULL DEFAULT 0
);
-- query separator
-- INSERT OR IGNORE INTO last_blocks (network, last_block) VALUES ('Ethereum', 12013400);
INSERT OR IGNORE INTO last_blocks (network, last_block) VALUES ('Ethereum', 8600000);
-- query separator
INSERT OR IGNORE INTO last_blocks (network, last_block) VALUES ('BSC', 0);
-- query separator
INSERT OR IGNORE INTO last_blocks (network, last_block) VALUES ('Polygon', 0);
-- query separator
INSERT OR IGNORE INTO last_blocks (network, last_block) VALUES ('Kava', 0);
