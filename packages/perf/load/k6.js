/* global __ENV, open */
// k6 version of the perf:load mix. Same mix.json and fixtures as the Node runner.
//   k6 run -e API_ORIGIN=http://localhost:8787 -e WEB_ORIGIN=http://localhost:5173 \
//     --vus 10 --duration 30s packages/perf/load/k6.js
// Start the API against the perf database first (see packages/perf/src/server.ts).

import { check } from 'k6';
import http from 'k6/http';

const mix = JSON.parse(open('./mix.json'));
const fixtures = JSON.parse(open('../../../.perf/fixtures.json'));
const API = __ENV.API_ORIGIN || 'http://localhost:8787';
const WEB = __ENV.WEB_ORIGIN || 'http://localhost:5173';

// Only these request names are held to the p95 budget (same set as the Node runner).
const GATED = ['list', 'search', 'detail', 'timeline'];

export const options = {
  thresholds: { http_req_failed: ['rate==0'], 'http_req_duration{gated:true}': ['p(95)<150'] },
};

function lookup(path) {
  const value = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), fixtures);
  if (value === undefined) throw new Error(`unknown placeholder {${path}}`);
  return value;
}

function fill(text, iteration) {
  const rotated = text.replace(/\{rotate:([^}]+)\}/g, (_m, keys) => {
    const list = keys.split('|');
    return `{${list[iteration % list.length]}}`;
  });
  return rotated.replace(/\{([A-Za-z0-9_.]+)\}/g, (_m, p) => encodeURIComponent(lookup(p)));
}

function fillBody(value) {
  if (value && typeof value === 'object' && value.$fixture) return lookup(value.$fixture);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillBody(v)]));
  }
  return value;
}

function pick() {
  const total = mix.scenarios.reduce((s, c) => s + c.weight, 0);
  let roll = Math.random() * total;
  for (const s of mix.scenarios) {
    roll -= s.weight;
    if (roll < 0) return s;
  }
  return mix.scenarios[0];
}

export function setup() {
  // Sign in once; the cookie jar of each VU is seeded from this cookie.
  const res = http.post(
    `${API}/api/auth/sign-in/email`,
    JSON.stringify({ email: fixtures.ownerA.email, password: fixtures.ownerA.password }),
    { headers: { 'content-type': 'application/json', origin: WEB } },
  );
  const cookies = res.cookies;
  return Object.keys(cookies)
    .map((name) => `${name}=${cookies[name][0].value}`)
    .join('; ');
}

export default function (cookie) {
  const scenario = pick();
  const requests = scenario.requests.map((r) => {
    const params = {
      headers: { origin: WEB, cookie },
      tags: { gated: String(GATED.includes(r.name)) },
    };
    const url = `${API}${fill(r.path, __ITER)}`;
    if (r.body === undefined) return [r.method, url, null, params];
    params.headers['content-type'] = 'application/json';
    return [r.method, url, JSON.stringify(fillBody(r.body)), params];
  });
  const responses = http.batch(requests);
  for (const res of responses)
    check(res, { 'status is 2xx': (x) => x.status >= 200 && x.status < 300 });
}
