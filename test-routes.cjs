/* Exhaustive backend route + validation tests. Requires: server on :4000, seeded DB.
 * Devnet tiers: I > $10 · II > $100 · III > $1,000 (mockUsd test hook drives tiers). */
const { ethers } = require("ethers");
const { io } = require("../frontend/node_modules/socket.io-client");

const BASE = "http://127.0.0.1:4000";
let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (extra ? " :: " + extra : ""));
    console.log("  FAIL:", name, extra);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

const msg = (c, a, n) => `6FIGS.XYZ login\n${c}:${a}\nnonce: ${n}`;
const ok2xx = (s) => s === 200 || s === 201;
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d, res));
function sock(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token } });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(new Error("connect: " + e.message)));
    setTimeout(() => reject(new Error("connect timeout")), 10000);
  });
}

(async () => {
  console.log("-- tiers + wallet/auth --");
  let r = await req("GET", "/tiers");
  check("tiers public", r.status === 200 && r.data.chainMode === "devnet", JSON.stringify(r.data));
  check("tiers devnet thresholds", JSON.stringify(r.data.tiers) === JSON.stringify([
    { name: "TIER I", min: 10 }, { name: "TIER II", min: 100 }, { name: "TIER III", min: 1000 },
  ]), JSON.stringify(r.data.tiers));

  r = await req("POST", "/wallet/nonce", { body: {} });
  check("nonce missing params 400", r.status === 400, r.status);
  r = await req("POST", "/wallet/nonce", { body: { chain: "EVM", address: "nope" } });
  check("nonce bad EVM addr 400", r.status === 400, r.status);
  r = await req("POST", "/wallet/nonce", { body: { chain: "DOGE", address: "x" } });
  check("nonce bad chain 400", r.status === 400, r.status);
  r = await req("POST", "/wallet/nonce", { body: { chain: "BTC", address: "bc1p1234567890123456789012345678901234" } });
  check("nonce taproot rejected 400", r.status === 400, r.status);

  // Real EVM signature flow (nonces are single-use: fresh nonce per attempt)
  const w = ethers.Wallet.createRandom();
  const freshNonce = async () =>
    (await req("POST", "/wallet/nonce", { body: { chain: "EVM", address: w.address } })).data.nonce;
  r = await req("POST", "/wallet/nonce", { body: { chain: "EVM", address: w.address } });
  check("nonce ok 2xx", ok2xx(r.status) && !!r.data.nonce, r.status);
  const n1 = r.data.nonce;
  await w.signMessage(msg("EVM", w.address.toLowerCase(), n1));
  r = await req("POST", "/wallet/verify", { body: { chain: "EVM", address: w.address, nonce: n1, signature: "0xdead" } });
  check("verify malformed sig 401", r.status === 401, r.status);
  const n2 = await freshNonce();
  const sig2 = await w.signMessage(msg("EVM", w.address.toLowerCase(), n2));
  r = await req("POST", "/wallet/verify", { body: { chain: "EVM", address: w.address, nonce: "bad", signature: sig2 } });
  check("verify wrong nonce 401", r.status === 401, r.status);
  const n3 = await freshNonce();
  const sig3 = await w.signMessage(msg("EVM", w.address.toLowerCase(), n3));
  r = await req("POST", "/wallet/verify", { body: { chain: "EVM", address: w.address, nonce: n3, signature: sig3 } });
  check("verify real sig 2xx", ok2xx(r.status) && !!r.data.token, r.status);
  const tokenA = r.data.token;
  const userA = r.data.user.id;
  r = await req("POST", "/wallet/verify", { body: { chain: "EVM", address: w.address, nonce: n3, signature: sig3 } });
  check("verify replay nonce 401", r.status === 401, r.status);

  // SOL bad sigs (mock-signature path removed)
  const solAddr = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const solNonce1 = (await req("POST", "/wallet/nonce", { body: { chain: "SOL", address: solAddr } })).data.nonce;
  r = await req("POST", "/wallet/verify", { body: { chain: "SOL", address: solAddr, nonce: solNonce1, signature: "!!!not-base58!!!" } });
  check("verify bad SOL sig 401", r.status === 401, r.status);
  const solNonce2 = (await req("POST", "/wallet/nonce", { body: { chain: "SOL", address: solAddr } })).data.nonce;
  r = await req("POST", "/wallet/verify", { body: { chain: "SOL", address: solAddr, nonce: solNonce2, signature: "3yMApq" } });
  check("verify short SOL sig 401", r.status === 401, r.status);

  // Users: A EVM 200k→III, B SOL 600k→III, C BTC 5→none, D EVM 50→I
  async function mockUser(chain, address, mock) {
    const link = await req("POST", "/wallet/link", { body: { chain, address } });
    const token = link.data.token;
    const me = await req("GET", "/wallet/user", { token });
    await req("PATCH", `/wallet/${me.data[0].id}/mock`, { token, body: { value: mock } });
    const elig = await req("POST", "/eligibility/check", { token });
    return { token, userId: link.data.user.id, elig: elig.data };
  }
  const B = await mockUser("SOL", "8xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsV", 600000);
  check("B tier III (devnet)", B.elig.tier === "TIER III", JSON.stringify(B.elig));
  const C = await mockUser("BTC", "bc1qtest0000000000000000000000000000000000", 5);
  check("C no tier", C.elig.tier === null, JSON.stringify(C.elig));
  const D = await mockUser("EVM", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", 50);
  check("D tier I (devnet)", D.elig.tier === "TIER I", JSON.stringify(D.elig));
  const meA = await req("GET", "/wallet/user", { token: tokenA });
  await req("PATCH", `/wallet/${meA.data[0].id}/mock`, { token: tokenA, body: { value: 200000 } });
  const eligA = await req("POST", "/eligibility/check", { token: tokenA });
  check("A tier III (devnet)", eligA.data.tier === "TIER III", JSON.stringify(eligA.data));
  check("eligibility has balances", Array.isArray(eligA.data.balances) && eligA.data.balances[0].usd === 200000, JSON.stringify(eligA.data));

  r = await req("GET", "/wallet/user");
  check("wallet/user unauth 401", r.status === 401, r.status);
  r = await req("GET", "/wallet/user", { token: "junk" });
  check("wallet/user bad token 401", r.status === 401, r.status);
  r = await req("POST", "/wallet/link", { token: B.token, body: { chain: "EVM", address: w.address } });
  check("link wallet owned elsewhere 400", r.status === 400, r.status);
  r = await req("POST", "/wallet/link", { body: { chain: "EVM", address: "0x123" } });
  check("link bad address 400", r.status === 400, r.status);
  r = await req("PATCH", `/wallet/${meA.data[0].id}/mock`, { token: B.token, body: { value: 5 } });
  check("mock another user's wallet 404", r.status === 404, r.status);
  r = await req("PATCH", `/wallet/${meA.data[0].id}/mock`, { token: tokenA, body: { value: -5 } });
  check("mock negative 400", r.status === 400, r.status);
  r = await req("DELETE", `/wallet/${meA.data[0].id}`, { token: B.token });
  check("delete another user's wallet 404", r.status === 404, r.status);
  const meC = await req("GET", "/wallet/user", { token: C.token });
  r = await req("DELETE", `/wallet/${meC.data[0].id}`, { token: C.token });
  check("delete last wallet 400", r.status === 400, r.status);

  console.log("-- eligibility/profile/play gating --");
  r = await req("GET", "/eligibility/user");
  check("eligibility unauth 401", r.status === 401, r.status);
  r = await req("GET", "/play/online");
  check("online unauth 401 (no guest reads)", r.status === 401, r.status);
  r = await req("POST", "/play/queue", { token: C.token });
  check("queue unverified 403", r.status === 403, r.status);
  r = await req("POST", "/play/challenge", { token: B.token, body: { userId: B.userId } });
  check("challenge self 400", r.status === 400, r.status);
  r = await req("POST", "/play/challenge", { token: B.token, body: {} });
  check("challenge missing userId 400", r.status === 400, r.status);
  r = await req("POST", "/play/challenge", { token: B.token, body: { userId: "cm00000000000000000000000" } });
  check("challenge unknown user 400", r.status === 400, r.status);
  r = await req("POST", "/play/challenge", { token: B.token, body: { userId: C.userId } });
  check("challenge unverified user 400", r.status === 400, r.status);
  r = await req("PATCH", "/profile/user", { token: B.token, body: { visMode: "PUBLIC" } });
  check("profile bad visMode 400", r.status === 400, r.status);
  r = await req("PATCH", "/profile/user", { token: B.token, body: { handle: "ab" } });
  check("profile short handle 400", r.status === 400, r.status);
  r = await req("PATCH", "/profile/user", { token: B.token, body: { handle: "bad handle!" } });
  check("profile bad chars handle 400", r.status === 400, r.status);
  r = await req("PATCH", "/profile/user", { token: B.token, body: { handle: "tester_two", visMode: "CATEGORIES" } });
  check("profile valid update 200", r.status === 200 && r.data.handle === "tester_two", r.status);
  r = await req("PATCH", "/profile/user", { token: D.token, body: { handle: "tester_two" } });
  check("profile dup handle 409", r.status === 409, r.status);

  r = await req("GET", "/play/online?filter=TIER I", { token: tokenA });
  check("online filter TIER I", r.status === 200 && r.data.every((p) => p.tier === "TIER I"), r.status);
  r = await req("GET", "/play/online?q=tester", { token: tokenA });
  check("online search", r.data.some((p) => p.handle === "tester_two"), JSON.stringify(r.data).slice(0, 120));
  check("online no isBot field", r.data.every((p) => !("isBot" in p)), "");
  check("online flags present", r.data.every((p) => typeof p.online === "boolean"), "");

  console.log("-- games --");
  const ch = await req("POST", "/play/challenge", { token: tokenA, body: { userId: B.userId } });
  check("challenge ok", ok2xx(ch.status) && ch.data.youAre === "X", ch.status);
  const gameId = ch.data.gameId;
  r = await req("GET", "/games/nope-not-an-id", { token: tokenA });
  check("game bad id 404", r.status === 404, r.status);
  r = await req("GET", `/games/${gameId}`, { token: C.token });
  check("game non-participant 403", r.status === 403, r.status);
  check("game opponent has no isBot", !("isBot" in (ch.data.opponent ?? {})), "");
  r = await req("POST", `/games/${gameId}/rematch`, { token: C.token, body: {} });
  check("rematch non-participant 403", r.status === 403, r.status);

  const sA = await sock(tokenA);
  const sB = await sock(B.token);
  await emit(sA, "joinGame", { gameId });
  await emit(sB, "joinGame", { gameId });
  let mv = await emit(sB, "makeMove", { gameId, index: 0 });
  check("move out of turn rejected", !!mv.error, JSON.stringify(mv));
  mv = await emit(sA, "makeMove", { gameId, index: 0 });
  check("X move ok", mv.ok && mv.state.board === "X........", JSON.stringify(mv));
  mv = await emit(sA, "makeMove", { gameId, index: 0 });
  check("occupied cell rejected", !!mv.error, JSON.stringify(mv));
  mv = await emit(sA, "makeMove", { gameId, index: 9 });
  check("off-board index rejected", !!mv.error, JSON.stringify(mv));
  await emit(sB, "makeMove", { gameId, index: 3 });
  await emit(sA, "makeMove", { gameId, index: 1 });
  await emit(sB, "makeMove", { gameId, index: 4 });
  mv = await emit(sA, "makeMove", { gameId, index: 2 });
  check("X wins top row", mv.ok && mv.state.winner === "X" && mv.state.status === "done", JSON.stringify(mv));
  mv = await emit(sB, "makeMove", { gameId, index: 5 });
  check("move after done rejected", !!mv.error, JSON.stringify(mv));
  const rm = await emit(sA, "rematch", { gameId });
  check("rematch resets", rm.ok && rm.state.board === "........." && rm.state.status === "open", JSON.stringify(rm));

  console.log("-- rooms (1v1, paginated) --");
  r = await req("POST", "/rooms", { token: tokenA, body: { name: "ab" } });
  check("room short name 400", r.status === 400, r.status);
  r = await req("POST", "/rooms", { token: tokenA, body: { name: "Valid Name", accessType: "nope" } });
  check("room bad access 400", r.status === 400, r.status);
  r = await req("POST", "/rooms", { token: tokenA, body: { name: "Valid Name", accessType: "tier", minTier: "TIER IX" } });
  check("room bad minTier 400", r.status === 400, r.status);
  r = await req("POST", "/rooms", { token: tokenA, body: { name: "Valid Name", accessType: "invite", inviteCode: "abc" } });
  check("room short code 400", r.status === 400, r.status);
  r = await req("POST", "/rooms", { body: { name: "Valid Name", accessType: "tier", minTier: "TIER I" } });
  check("room unauth 401", r.status === 401, r.status);
  r = await req("GET", "/rooms");
  check("rooms unauth 401 (no guest reads)", r.status === 401, r.status);
  const t3 = await req("POST", "/rooms", { token: tokenA, body: { name: "Whale Den", accessType: "tier", minTier: "TIER III" } });
  check("room create 201", t3.status === 201, t3.status);
  r = await req("POST", `/rooms/${t3.data.id}/join`, { token: D.token, body: {} });
  check("tier room under-tier 403", r.status === 403, r.status);
  const inv = await req("POST", "/rooms", { token: tokenA, body: { name: "Secret Pair", accessType: "invite", inviteCode: "PAIR99" } });
  check("invite create returns code once", inv.status === 201 && inv.data.inviteCode === "PAIR99", JSON.stringify(inv.data));
  const list = await req("GET", "/rooms?limit=50", { token: tokenA });
  check("room list paginated shape", Array.isArray(list.data.items) && typeof list.data.total === "number", JSON.stringify(list.data).slice(0, 120));
  check("room list leaks no code", JSON.stringify(list.data).toUpperCase().indexOf("PAIR99") === -1, "");
  check("room list has isMember", list.data.items.every((x) => typeof x.isMember === "boolean"), "");
  const ownT3 = list.data.items.find((x) => x.id === t3.data.id);
  check("creator isMember true", ownT3?.isMember === true, JSON.stringify(ownT3));
  r = await req("GET", "/rooms/cm00000000000000000000000/meta", { token: B.token });
  check("meta missing room 404", r.status === 404, r.status);
  r = await req("GET", `/rooms/${t3.data.id}/meta`, { token: B.token });
  check("meta non-member", r.status === 200 && r.data.isMember === false && r.data.name === "Whale Den", JSON.stringify(r.data));
  check("meta no code leak", !("inviteCode" in r.data) && !("inviteCodeHash" in r.data), "");
  r = await req("GET", "/rooms?limit=1&page=1", { token: tokenA });
  check("rooms limit=1", r.data.items.length === 1 && r.data.limit === 1 && r.data.page === 1, JSON.stringify(r.data));
  r = await req("GET", "/rooms?limit=200", { token: tokenA });
  check("rooms limit clamped ≤50", r.data.limit <= 50, JSON.stringify(r.data.limit));
  r = await req("GET", "/rooms?access=invite", { token: tokenA });
  check("rooms access filter", r.data.items.every((x) => x.accessType === "invite"), "");
  r = await req("GET", "/rooms?q=whale", { token: tokenA });
  check("rooms search", r.data.items.some((x) => x.name === "Whale Den"), "");
  r = await req("GET", "/rooms?sort=name&order=asc", { token: tokenA });
  const names = r.data.items.map((x) => x.name.toLowerCase());
  check("rooms sort name asc", names.every((v, i) => i === 0 || names[i - 1] <= v), names.join(","));
  r = await req("POST", `/rooms/${inv.data.id}/join`, { token: B.token, body: { code: "WRONG" } });
  check("invite wrong code 403", r.status === 403, r.status);
  r = await req("POST", `/rooms/${inv.data.id}/join`, { token: B.token, body: { code: "pair99" } });
  check("invite code case-insensitive 2xx", ok2xx(r.status), r.status);
  r = await req("POST", `/rooms/${inv.data.id}/join`, { token: D.token, body: { code: "PAIR99" } });
  check("full 1v1 room 403", r.status === 403, r.status);
  r = await req("POST", `/rooms/${inv.data.id}/join`, { token: tokenA, body: { code: "TOTALLY-WRONG" } });
  check("member rejoin idempotent (already inside, no re-prompt)", ok2xx(r.status), r.status);
  const listB = await req("GET", "/rooms?limit=50", { token: B.token });
  const bT3 = listB.data.items.find((x) => x.id === t3.data.id);
  check("list isMember false for non-member", !!bT3 && bT3.isMember === false, JSON.stringify(bT3));
  const bInv = listB.data.items.find((x) => x.id === inv.data.id);
  check("list isMember true after join", !!bInv && bInv.isMember === true, JSON.stringify(bInv));
  r = await req("GET", `/rooms/${inv.data.id}/meta`, { token: B.token });
  check("meta member after join", r.status === 200 && r.data.isMember === true, JSON.stringify(r.data));
  r = await req("POST", "/rooms/cm00000000000000000000000/join", { token: B.token, body: {} });
  check("join missing room 404", r.status === 404, r.status);
  r = await req("GET", `/rooms/${t3.data.id}/members`, { token: B.token });
  check("members non-member 403", r.status === 403, r.status);
  r = await req("GET", `/rooms/${inv.data.id}/members`, { token: B.token });
  check("members no isBot field", r.data.every((m) => !("isBot" in m)), "");
  r = await req("GET", `/rooms/${t3.data.id}/game`, { token: tokenA });
  check("room game solo 400 (waiting peer)", r.status === 400, r.status);
  r = await req("GET", `/rooms/${inv.data.id}/game`, { token: B.token });
  check("room game ok", r.status === 200 && !!r.data.gameId, JSON.stringify(r.data));
  r = await req("GET", `/rooms/${inv.data.id}/game`, { token: D.token });
  check("room game non-member 403", r.status === 403, r.status);

  console.log("-- chat/tokens/presence --");
  r = await req("GET", "/chat/nope/xyz", { token: B.token });
  check("chat bad scope 400", r.status === 400, r.status);
  r = await req("GET", `/chat/room/${t3.data.id}`, { token: B.token });
  check("room history non-member 403", r.status === 403, r.status);
  r = await req("GET", `/chat/room/${inv.data.id}?cursor=not-a-date`, { token: B.token });
  check("history bad cursor 400", r.status === 400, r.status);
  r = await req("GET", `/chat/room/${inv.data.id}?limit=1000`, { token: B.token });
  check("history limit capped", r.status === 200 && r.data.items.length <= 100, r.status);
  r = await req("GET", "/chat/tokens/xyznotreal123", { token: B.token });
  check("token unknown symbol", r.status === 200 && r.data.card.status === "unknown", JSON.stringify(r.data));
  r = await req("GET", "/chat/tokens/btc", { token: B.token });
  check("token lowercase ok", r.status === 200 && (r.data.card.status === "live" || r.data.card.status === "stale"), JSON.stringify(r.data));
  check("token has no holders field", !("holders" in r.data.card), JSON.stringify(r.data.card));

  // B is provably not a member of Whale Den (members check above 403s)
  const bad = await emit(sB, "sendMessage", { scope: "room", scopeId: t3.data.id, body: "hi" });
  check("WS send non-member room rejected", !!bad.error, JSON.stringify(bad));
  const badDm = await emit(sB, "sendMessage", { scope: "dm", scopeId: "cm00000000000000000000000", body: "hi" });
  check("WS send to someone else's dm rejected", !!badDm.error, JSON.stringify(badDm));
  const empty = await emit(sA, "sendMessage", { scope: "dm", scopeId: ch.data.matchId, body: "   " });
  check("WS empty message rejected", !!empty.error, JSON.stringify(empty));
  const badScope = await emit(sA, "joinScope", { scope: "zzz", scopeId: "x" });
  check("WS bad scope rejected", !!badScope.error, JSON.stringify(badScope));
  const ok = await emit(sA, "sendMessage", { scope: "dm", scopeId: ch.data.matchId, body: "gg $ETH" });
  check("WS dm send ok + tickers", ok.ok && JSON.stringify(ok.tickers).includes("ETH"), JSON.stringify(ok));
  sA.disconnect();
  sB.disconnect();

  const online = await req("GET", "/play/online", { token: B.token });
  check("online flags present", online.data.every((p) => typeof p.online === "boolean"), "");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("FAILURES:\n- " + failures.join("\n- "));
    process.exit(1);
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
