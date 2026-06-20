// tableView.test.cjs — the low-fid viewer state-machine. Pure logic, synthetic
// observations where codes DO appear (the live stream reads '?' until templates
// seed, but the FORMAT is testable now). Verifies: last-good per slot, '?' for
// unread, hard reset on hand boundary, and that it NEVER withholds.
const { test } = require('node:test');
const assert = require('node:assert');
const TV = require('./tableView.js');

// a settled-observation stub
function card(code) { return { status: 'read', code }; }
function unread() { return { status: 'no-read' }; }
function absent() { return { status: 'absent' }; }
function num(v) { return v == null ? { status: 'no-read' } : { status: 'read', value: v }; }
function confirmed(o) {
  o = o || {};
  const stacks = {}, bets = {};
  for (const s of TV.SEATS) { stacks[s] = num(o.stacks && o.stacks[s]); bets[s] = num(o.bets && o.bets[s]); }
  return {
    stacks, bets,
    board: { value: o.board || [] },
    heroHole: { value: o.hero || [] },
    pot: num(o.pot),
    button: o.button ? { status: 'read', seat: o.button } : { status: 'no-read' },
  };
}

test('thinFromConfirmed: read codes, ? for present-unread, drops absent', () => {
  const thin = TV.thinFromConfirmed(confirmed({
    board: [card('Kd'), unread(), card('3c'), absent(), absent()],
    hero: [card('As'), unread()],
    pot: 12.5, stacks: { BC: 100, TR: 80 }, bets: { TR: 3 }, button: 'TC',
  }), { heroToAct: true, street: 'flop', heroBet: 0 });
  assert.deepStrictEqual(thin.board, ['Kd', '?', '3c']);     // absent dropped, unread → ?
  assert.deepStrictEqual(thin.hero, ['As', '?']);
  assert.strictEqual(thin.pot, 12.5);
  assert.strictEqual(thin.button, 'TC');
  assert.strictEqual(thin.seats.BC.stack, 100);
  assert.strictEqual(thin.seats.TR.bet, 3);
  assert.strictEqual(thin.seats.BC.bet, 0);                  // hero bet = known action (extra.heroBet)
  assert.strictEqual(thin.heroToAct, true);
});

test('button unread → null (Gate-D shows ?, never fabricated)', () => {
  const thin = TV.thinFromConfirmed(confirmed({ board: [card('2h')], button: null }), {});
  assert.strictEqual(thin.button, null);
});

test('TableView holds LAST-GOOD per slot through a missed frame', () => {
  const tv = new TV.TableView();
  tv.update(TV.thinFromConfirmed(confirmed({ board: [card('Kd'), card('9h'), card('3c')] }), { street: 'flop' }), false);
  // next frame: detector misses the 9h (reads ? there) — must NOT lose it
  tv.update(TV.thinFromConfirmed(confirmed({ board: [card('Kd'), unread(), card('3c')] }), {}), false);
  assert.deepStrictEqual(tv.view().board.slice(0, 3), ['Kd', '9h', '3c']);
  // turn arrives — 4th slot fills, first three persist
  tv.update(TV.thinFromConfirmed(confirmed({ board: [card('Kd'), card('9h'), card('3c'), card('7s')] }), { street: 'turn' }), false);
  assert.deepStrictEqual(tv.view().board.slice(0, 4), ['Kd', '9h', '3c', '7s']);
  assert.strictEqual(tv.view().street, 'turn');
});

test('hard reset on hand boundary; ? for never-read slots; hand count++', () => {
  const tv = new TV.TableView();
  tv.update(TV.thinFromConfirmed(confirmed({ board: [card('Kd'), card('9h'), card('3c')], pot: 9 }), {}), false);
  assert.strictEqual(tv.view().hand, 0);
  tv.update(TV.thinFromConfirmed(confirmed({ board: [], pot: 1.5 }), {}), true); // boundary
  const v = tv.view();
  assert.strictEqual(v.hand, 1);
  assert.deepStrictEqual(v.board, ['?', '?', '?', '?', '?']); // reset
  assert.strictEqual(v.pot, 1.5);
});

test('hero-shy: shows the cards it can, ? for the shy one — never withholds', () => {
  const tv = new TV.TableView();
  // front read, rear shy (no-read) — the viewer shows As + ?, unlike the assembler
  tv.update(TV.thinFromConfirmed(confirmed({ hero: [card('As'), unread()] }), {}), false);
  assert.deepStrictEqual(tv.view().hero, ['As', '?']);
});
