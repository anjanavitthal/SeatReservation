'use strict';
const { openDb, seed } = require('./db');
const { createApp } = require('./app');

const db = openDb();
seed(db);
const port = Number(process.env.PORT || 3000);
createApp({ db }).listen(port, () => console.log(`Bus seat booking running at http://localhost:${port}`));
