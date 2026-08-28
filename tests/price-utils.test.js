'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmazonPrice } = require('../price-utils');

test('parses structured EUR buy-box data', () => {
  assert.equal(parseAmazonPrice('<div>{"displayPrice":"20,99 €","priceAmount":20.99,"currencySymbol":"€"}</div>'), 20.99);
});

test('parses German labelled price fallback', () => {
  assert.equal(parseAmazonPrice('<span data-pricetopay-label="{priceToPay}"> 1.234,56 € </span>'), 1234.56);
});

test('rejects captcha, missing, and unreasonable prices', () => {
  assert.equal(parseAmazonPrice('<h1>Captcha</h1>{"priceAmount":20.99,"currencySymbol":"€"}'), null);
  assert.equal(parseAmazonPrice('<div>Currently unavailable</div>'), null);
  assert.equal(parseAmazonPrice('{"priceAmount":10000,"currencySymbol":"€"}'), null);
});
