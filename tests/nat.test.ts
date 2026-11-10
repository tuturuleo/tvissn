import test from "node:test";
import assert from "node:assert/strict";
import { judgeNat } from "../extension/src/nat";

test("judgeNat: no server-reflexive candidates means no public address", () => {
  assert.equal(judgeNat([]), "no-public-address");
});

test("judgeNat: a single STUN server cannot reveal a symmetric NAT", () => {
  assert.equal(judgeNat([{ address: "203.0.113.5", port: 40000, server: "stun.a.test" }]), "likely-ok");
});

test("judgeNat: two servers seeing the same address and port mean an endpoint-independent mapping", () => {
  const mapped = [
    { address: "203.0.113.5", port: 40000, server: "stun.a.test" },
    { address: "203.0.113.5", port: 40000, server: "stun.b.test" },
  ];
  assert.equal(judgeNat(mapped), "likely-ok");
});

test("judgeNat: two servers seeing different ports for one address mean a symmetric NAT", () => {
  const mapped = [
    { address: "203.0.113.5", port: 40000, server: "stun.a.test" },
    { address: "203.0.113.5", port: 40001, server: "stun.b.test" },
  ];
  assert.equal(judgeNat(mapped), "symmetric");
});

test("judgeNat: two candidates from the same server are not treated as symmetric", () => {
  const mapped = [
    { address: "203.0.113.5", port: 40000, server: "stun.a.test" },
    { address: "203.0.113.5", port: 40001, server: "stun.a.test" },
  ];
  assert.notEqual(judgeNat(mapped), "symmetric");
});
