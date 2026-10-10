'use strict';

const crypto = require('node:crypto');
module.exports = (contents) => crypto.createHash('sha256').update(contents, 'utf8').digest('hex');
