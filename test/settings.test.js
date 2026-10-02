'use strict';

const assert = require('assert');
const { describeZone } = require('../lib/roon-service');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const picked = (name) => ({ output_id: 'o1', name });
const zone = (displayName, outputCount) => ({
  display_name: displayName,
  outputs: Array.from({ length: outputCount }, (_, i) => ({ output_id: `o${i + 1}` }))
});

console.log('describeZone');

check('nothing chosen yet', () => {
  assert.strictEqual(describeZone(null, null), 'Party zone');
});

check('no Core to resolve against', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), null), 'Party zone — "Kitchen" is not available');
});

check('lone endpoint, same name -> no noise', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), zone('Kitchen', 1)), 'Party zone');
});

check('grouped endpoint names the group and its size', () => {
  assert.strictEqual(
    describeZone(picked('Kitchen'), zone('Kitchen + Living Room + Study', 3)),
    'Party zone — plays to Kitchen + Living Room + Study (3 endpoints)'
  );
});

check('lone endpoint whose zone is named differently', () => {
  assert.strictEqual(
    describeZone(picked('Study Pi'), zone('Study', 1)),
    'Party zone — plays to Study'
  );
});

check('a very long group name is clipped', () => {
  const long = 'Kitchen + Living Room + Study + Bedroom + Bathroom + Garage + Garden';
  const out = describeZone(picked('Kitchen'), zone(long, 7));
  assert.ok(out.includes('…'), `expected clipping, got: ${out}`);
  assert.ok(out.length < long.length + 30, `too long: ${out}`);
  assert.ok(out.endsWith('(7 endpoints)'), out);
});

check('an unnamed zone does not produce a stray dash', () => {
  assert.strictEqual(describeZone(picked('Kitchen'), zone('', 1)), 'Party zone');
});

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
