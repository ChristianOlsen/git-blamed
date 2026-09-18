import assert from "node:assert/strict";
import test from "node:test";
import { BackendError } from "./backend-errors.ts";
import { assertSameOrigin } from "./request-origin.ts";

test("requests use the browser-facing host without environment configuration", () => {
  for (const [origin, host] of [
    ["http://127.0.0.1:3102", "127.0.0.1:3102"],
    ["http://localhost:3000", "localhost:3000"],
    ["https://party.example", "party.example"],
  ]) {
    assert.doesNotThrow(() => assertSameOrigin(new Headers({ origin, host })));
  }
});

test("missing, malformed, foreign and cross-site origins are rejected", () => {
  const invalidHeaders: Record<string, string>[] = [
    {},
    { host: "localhost:3000" },
    { origin: "null", host: "localhost:3000" },
    { origin: "https://other.example", host: "party.example" },
    { origin: "https://party.example", host: "party.example:3000" },
    { origin: "https://party.example/path", host: "party.example" },
    { origin: "https://party.example/", host: "party.example" },
    { origin: "ftp://party.example", host: "party.example" },
    {
      origin: "https://party.example",
      host: "party.example",
      "sec-fetch-site": "cross-site",
    },
    {
      origin: "https://party.example",
      host: "internal:3000",
      "x-forwarded-host": "party.example",
    },
  ];
  for (const headers of invalidHeaders) {
    assert.throws(() => assertSameOrigin(new Headers(headers)), BackendError);
  }
});
