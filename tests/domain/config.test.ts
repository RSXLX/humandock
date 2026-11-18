import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMode, validateBindHost } from '../../apps/api/src/config.js';
test('unknown mode cannot bypass the local-demo loopback guard',()=>{
  for(const value of ['production','ME','Demo','demo ','']) assert.throws(()=>parseMode(value),/APP_MODE/);
  assert.equal(parseMode(undefined),'demo');
  assert.throws(()=>validateBindHost(parseMode('demo'),'0.0.0.0'),/loopback/);
  assert.doesNotThrow(()=>validateBindHost(parseMode('demo'),'127.0.0.1'));
});
