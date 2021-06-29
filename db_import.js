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
}

exports.initDB = initDB;
