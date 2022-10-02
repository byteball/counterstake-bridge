/*jslint node: true */
'use strict';
const fs = require('fs');
const db = require('ocore/db.js');

async function initDB(){
	const db_sql = fs.readFileSync(__dirname + '/db.sql', 'utf8');
	const queries = db_sql.split('-- query separator');

	for (let sql of queries) {
		if (sql)
			await db.query(sql);
	}

	let rows = await db.query("SELECT name FROM pragma_table_info('bridges')");
	if (!rows.find(r => r.name === 'e_v')) {
		await db.query(`ALTER TABLE bridges ADD COLUMN e_v VARCHAR(6) NOT NULL DEFAULT 'v1'`);
		await db.query(`ALTER TABLE bridges ADD COLUMN i_v VARCHAR(6) NOT NULL DEFAULT 'v1'`);
		await db.query(`ALTER TABLE bridges ADD COLUMN ea_v VARCHAR(6) NOT NULL DEFAULT 'v1'`);
		await db.query(`ALTER TABLE bridges ADD COLUMN ia_v VARCHAR(6) NOT NULL DEFAULT 'v1'`);
	}

	rows = await db.query("SELECT name FROM pragma_table_info('pooled_assistants')");
	if (!rows.find(r => r.name === 'version')) {
		await db.query("ALTER TABLE pooled_assistants ADD COLUMN `version` VARCHAR(6) NOT NULL DEFAULT 'v1'");
	}

	rows = await db.query("SELECT name FROM pragma_table_info('transfers')");
	if (!rows.find(r => r.name === 'is_bad')) {
		await db.query("ALTER TABLE transfers ADD COLUMN is_bad TINYINT NOT NULL DEFAULT 0");
	}

}

exports.initDB = initDB;
