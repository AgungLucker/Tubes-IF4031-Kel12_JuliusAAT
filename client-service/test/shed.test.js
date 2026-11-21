import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createShedder, prioritize } from '../src/shed.js';

const cfg = { lapanganClientId: 'lapangan-client', internalClientId: 'internal-client' };
const res = () => Object.assign(new EventEmitter(), { set() {} });
const request = (clientId) => {
  const req = { auth: { clientId } };
  prioritize(cfg)(req, null, () => {});
  return req;
};
// returns { admitted, response } for one request; the response is kept open until finish()
function arrive(shedder, clientId) {
  const req = request(clientId), r = res();
  let err = null, admitted = false;
  shedder.admit(req, r, (e) => { if (e) err = e; else admitted = true; });
  return { admitted, err, finish: () => r.emit('finish') };
}

test('priority comes from the client identity', () => {
  assert.equal(request('lapangan-client').priority, 'high');
  assert.equal(request('internal-client').priority, 'high');
  assert.equal(request('media-client').priority, 'low');
});

test('overload: Media is shed first, Tim Lapangan keeps being served', () => {
  const s = createShedder({ maxInflight: 10, mediaShare: 0.6 }); // Media up to 6 in flight, total 10
  const media = Array.from({ length: 20 }, () => arrive(s, 'media-client'));
  assert.equal(media.filter((m) => m.admitted).length, 6, 'Media is capped at 60% of the budget');
  assert.ok(media.filter((m) => !m.admitted).every((m) => m.err.status === 429), 'the rest got a controlled 429');

  const field = Array.from({ length: 4 }, () => arrive(s, 'lapangan-client'));
  assert.ok(field.every((f) => f.admitted), 'the reserved 40% is still available to Tim Lapangan');

  const extra = arrive(s, 'lapangan-client');
  assert.equal(extra.err.status, 429, 'only when the WHOLE budget is used is Tim Lapangan refused too');
  assert.deepEqual(s.stats().shed, { high: 1, low: 14 });
});

test('capacity is returned when a response finishes or the client disconnects', () => {
  const s = createShedder({ maxInflight: 2, mediaShare: 1 });
  const a = arrive(s, 'media-client'), b = arrive(s, 'media-client');
  assert.equal(arrive(s, 'media-client').err.status, 429);
  a.finish();
  assert.ok(arrive(s, 'media-client').admitted, 'a slot freed by finish');
  b.finish(); b.finish(); // a double release must not free two slots
  assert.equal(s.stats().inflight, 1);
});
