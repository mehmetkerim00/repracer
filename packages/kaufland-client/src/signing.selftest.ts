// Тестовый вектор из официальной документации (https://sellerapi.kaufland.com/?page=rest-api#signing-requests).
// Запуск: node --experimental-strip-types packages/kaufland-client/src/signing.selftest.ts
import assert from 'node:assert/strict';
import { signKauflandRequest, verifyKauflandSignature } from './signing.ts';

const vector = {
  method: 'POST',
  uri: 'https://sellerapi.kaufland.com/v2/units/',
  body: '',
  timestamp: 1411055926,
  secretKey: 'a7d0cb1da1ddbc86c96ee5fedd341b7d8ebfbb2f5c83cfe0909f4e57f05dd403',
};
const expected = 'da0b65f51c0716c1d3fa658b7eaf710583630a762a98c9af8e9b392bd9df2e2a';

assert.equal(signKauflandRequest(vector), expected);
assert.equal(verifyKauflandSignature(vector, expected.toUpperCase()), true);
assert.equal(verifyKauflandSignature({ ...vector, body: '{}' }, expected), false);
console.log('kaufland signing self-test: OK (hex matches documented vector)');
