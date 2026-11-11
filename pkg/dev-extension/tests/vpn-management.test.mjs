// The shared VPN's answers to OpenVPN's management interface: password, then a separate code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  managementStep, newSession, readCrv1, mgmtQuote,
} from '../vpn-management.mjs';

const b64 = (s) => Buffer.from(s).toString('base64');

test('quoting: quotes and backslashes are escaped, so a password cannot end the command', () => {
  assert.equal(mgmtQuote('pa"ss\\word'), '"pa\\"ss\\\\word"');
});

test('the ECM shape: password, a CRV1 challenge, then the code - and the code is used once', () => {
  const s = newSession({ username: 'torchiaf', password: 'secret', otp: '123456' });
  let r = managementStep('>HOLD:Waiting for hold release:0', s);

  assert.deepEqual(r.send, ['hold release']);
  r = managementStep('>PASSWORD:Need \'Auth\' username/password', s);
  assert.deepEqual(r.send, ['username "Auth" "torchiaf"', 'password "Auth" "secret"']);
  r = managementStep(`>PASSWORD:Verification Failed: 'Auth' ['CRV1:R,E:abc123:${ b64('torchiaf') }:Enter your OTP code']`, s);
  assert.equal(r.state.phase, 'challenge');
  assert.equal(r.state.note, 'Enter your OTP code');
  assert.equal(r.end, false);
  r = managementStep('>PASSWORD:Need \'Auth\' username/password', s);
  assert.deepEqual(r.send, ['username "Auth" "torchiaf"', 'password "Auth" "CRV1::abc123::123456"']);
  r = managementStep('>STATE:1731300000,CONNECTED,SUCCESS,10.8.0.6,91.193.113.211,1194,,', s, 'T');
  assert.deepEqual(r.state, {
    phase: 'connected', since: 'T', address: '10.8.0.6', server: '91.193.113.211', note: '',
  });
  // The daily kick: asked again, nothing unused to give.
  r = managementStep('>PASSWORD:Need \'Auth\' username/password', s, 'T2');
  assert.equal(r.state.phase, 'need-login');
  assert.equal(r.end, true);
  assert.deepEqual(r.send, []);
});

test('a challenge with no code to give stops and asks for a login', () => {
  const s = newSession({ username: 'u', password: 'p' });

  managementStep('>PASSWORD:Need \'Auth\' username/password', s);
  const r = managementStep(`>PASSWORD:Verification Failed: 'Auth' ['CRV1:R,E:st:${ b64('u') }:OTP?']`, s);

  assert.equal(r.state.phase, 'need-login');
  assert.equal(r.end, true);
});

test('a static challenge is answered with SCRV1 in one go', () => {
  const s = newSession({ username: 'u', password: 'p', otp: '999' });
  const r = managementStep('>PASSWORD:Need \'Auth\' username/password SC:1,Enter code', s);

  assert.deepEqual(r.send, ['username "Auth" "u"', `password "Auth" "SCRV1:${ b64('p') }:${ b64('999') }"`]);
});

test('a refusal without a challenge is a failed login', () => {
  const s = newSession({ username: 'u', password: 'p', otp: '1' });

  managementStep('>PASSWORD:Need \'Auth\' username/password', s);
  const r = managementStep('>PASSWORD:Verification Failed: \'Auth\'', s);

  assert.equal(r.state.phase, 'failed');
  assert.equal(r.end, true);
});

test('states map to phases; FATAL ends it', () => {
  const s = newSession();

  assert.equal(managementStep('>STATE:1,RECONNECTING,ping-restart,,', s).state.phase, 'reconnecting');
  assert.equal(managementStep('>STATE:1,AUTH,,,', s).state.phase, 'connecting');
  const fatal = managementStep('>FATAL:Cannot open TUN/TAP dev /dev/net/tun', s);

  assert.equal(fatal.state.phase, 'failed');
  assert.equal(fatal.end, true);
  assert.deepEqual(managementStep('>INFO:OpenVPN Management Interface Version 5', s), { send: [], state: null, end: false });
});

test('readCrv1 decodes the username and keeps the prompt', () => {
  assert.deepEqual(readCrv1(`CRV1:R,E:s1:${ b64('me@x') }:Your code: `), {
    flags: 'R,E', state: 's1', user: 'me@x', prompt: 'Your code:', echo: true,
  });
  assert.equal(readCrv1('nothing here'), null);
});
