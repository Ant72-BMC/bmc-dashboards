// --------------------------------------------------
// reconcile-check.js
//
// Lightweight, READ-ONLY reconciliation check.
// Compares live AutoTrader stock counts (per advertiser) against Sanity's
// advert.isActive counts, and writes the result to reconcile-status.json
// for the bmc-dashboards site to render as a tile.
//
// Also surfaces any Sanity "failedSync" documents (added by Elias's write-retry
// fix on 13 July) - queried generically since the exact field schema wasn't
// confirmed, so this reports whatever fields actually exist on each record.
//
// This does NOT write anything to Sanity or AutoTrader - it only reads.
//
// Mirrors the exact logic in bmc-sync/sync.js so the numbers this produces
// always agree with what the real sync considers "live":
//   - isLive(v): lifecycleState === "FORECOURT" || "DUE_IN"
//   - Same auth flow (client credentials -> bearer token, refresh on 401/403)
//   - Same pagination (pageSize 200, loop until empty page)
//
// Required environment variables (set as GitHub Actions secrets):
//   AUTOTRADER_CLIENT_ID
//   AUTOTRADER_CLIENT_SECRET
//   SANITY_READ_TOKEN      (Viewer-only token - never the write token)
//
// Optional (defaults match the BMC project if not set):
//   SANITY_PROJECT_ID   (default: 0d5aee7t)
//   SANITY_DATASET      (default: production)
// --------------------------------------------------

const BASE = "https://api.autotrader.co.uk";

const DEALER_LOCATIONS = {
  "833349": "Brooke",
  "10043362": "Norwich",
};
const ADVERTISER_IDS = Object.keys(DEALER_LOCATIONS);

const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID || "0d5aee7t";
const SANITY_DATASET = process.env.SANITY_DATASET || "production";
const SANITY_API_VERSION = "v2023-10-01";
const SANITY_READ_TOKEN = process.env.SANITY_READ_TOKEN;

const AUTOTRADER_CLIENT_ID = process.env.AUTOTRADER_CLIENT_ID;
const AUTOTRADER_CLIENT_SECRET = process.env.AUTOTRADER_CLIENT_SECRET;

function requireEnv() {
  const missing = [];
  if (!AUTOTRADER_CLIENT_ID) missing.push("AUTOTRADER_CLIENT_ID");
  if (!AUTOTRADER_CLIENT_SECRET) missing.push("AUTOTRADER_CLIENT_SECRET");
  if (!SANITY_READ_TOKEN) missing.push("SANITY_READ_TOKEN");
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

// Same lifecycle filter as sync.js's isLive()
function isLive(v) {
  const s = v?.metadata?.lifecycleState;
  return s === "FORECOURT" || s === "DUE_IN";
}

// --------------------------------------------------
// AutoTrader auth - identical flow to sync.js
// --------------------------------------------------
let currentToken = null;

async function getToken() {
  const res = await fetch(`${BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      key: AUTOTRADER_CLIENT_ID,
      secret: AUTOTRADER_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AutoTrader auth failed: ${res.status} - ${text}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function ensureToken() {
  if (!currentToken) currentToken = await getToken();
  return currentToken;
}

async function authedFetch(url) {
  let token = await ensureToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    currentToken = null;
    token = await ensureToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  return res;
}

// --------------------------------------------------
// Fetch live stock count for one advertiser - same pagination as sync.js
// --------------------------------------------------
async function fetchLiveCountForAdvertiser(advertiserId) {
  let page = 1;
  const pageSize = 200;
  let liveCount = 0;

  while (true) {
    const url = `${BASE}/stock?advertiserId=${advertiserId}&page=${page}&pageSize=${pageSize}`;
    const res = await authedFetch(url);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Stock fetch failed for ${advertiserId}: ${res.status} - ${text}`);
    }

    const json = await res.json();
    const results = json.results || [];

    if (results.length === 0) break;

    liveCount += results.filter(isLive).length;
    page++;
  }

  return liveCount;
}

// --------------------------------------------------
// Sanity - read-only GROQ counts via HTTP API (no @sanity/client dependency needed)
// --------------------------------------------------
async function sanityCount(groqQuery) {
  const url = `https://${SANITY_PROJECT_ID}.api.sanity.io/${SANITY_API_VERSION}/data/query/${SANITY_DATASET}?query=${encodeURIComponent(
    groqQuery
  )}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SANITY_READ_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sanity query failed: ${res.status} - ${text}`);
  }
  const json = await res.json();
  return json.result;
}

// --------------------------------------------------
// Main
// --------------------------------------------------
async function main() {
  const timestamp = new Date().toISOString();
  const result = {
    timestamp,
    ok: false,
    match: null,
    autotraderTotal: null,
    sanityTotal: null,
    byAdvertiser: {},
    failedSyncCount: null,
    failedSyncRecords: [],
    error: null,
  };

  try {
    requireEnv();

    // 1. AutoTrader live counts, per advertiser
    let autotraderTotal = 0;
    const autotraderByAdvertiser = {};
    for (const advertiserId of ADVERTISER_IDS) {
      const count = await fetchLiveCountForAdvertiser(advertiserId);
      autotraderByAdvertiser[advertiserId] = count;
      autotraderTotal += count;
    }

    // 2. Sanity isActive counts - total and per dealerId (matches advertiserId 1:1)
    const sanityTotal = await sanityCount(
      `count(*[_type == "vehicle" && advert.isActive == true])`
    );

    const sanityByAdvertiser = {};
    for (const advertiserId of ADVERTISER_IDS) {
      sanityByAdvertiser[advertiserId] = await sanityCount(
        `count(*[_type == "vehicle" && advert.isActive == true && dealerId == "${advertiserId}"])`
      );
    }

    // 3. Assemble comparison
    for (const advertiserId of ADVERTISER_IDS) {
      const location = DEALER_LOCATIONS[advertiserId];
      const autotraderCount = autotraderByAdvertiser[advertiserId];
      const sanityCountForDealer = sanityByAdvertiser[advertiserId];
      result.byAdvertiser[advertiserId] = {
        location,
        autotrader: autotraderCount,
        sanity: sanityCountForDealer,
        match: autotraderCount === sanityCountForDealer,
        diff: sanityCountForDealer - autotraderCount,
      };
    }

    result.autotraderTotal = autotraderTotal;
    result.sanityTotal = sanityTotal;
    result.match = autotraderTotal === sanityTotal;

    // 4. failedSync records - queried generically (no assumed field names beyond
    // _type == "failedSync", since the exact schema wasn't confirmed with Elias).
    // This surfaces whatever fields actually exist rather than silently returning
    // nothing if a guessed field name is wrong.
    result.failedSyncCount = await sanityCount(`count(*[_type == "failedSync"])`);
    result.failedSyncRecords = await sanityCount(
      `*[_type == "failedSync"] | order(_updatedAt desc) [0...20]`
    );

    result.ok = true;
  } catch (err) {
    result.error = err.message || String(err);
    result.ok = false;
  }

  const fs = await import("fs");
  fs.writeFileSync("reconcile-status.json", JSON.stringify(result, null, 2));

  console.log(JSON.stringify(result, null, 2));

  // Non-zero exit on a genuine check failure (not on a mismatch - a mismatch is
  // useful data for the dashboard, not a broken workflow run)
  if (!result.ok) {
    process.exit(1);
  }
}

main();
