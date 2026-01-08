// utils/tokenManager.js
const utilities = require("../utils/utilities.pricing");

// How early to refresh before actual expiry (handles clock skew/network jitter)
const SKEW_SECONDS = parseInt(process.env.TOKEN_SKEW_SEC || "60", 10);

// Optional hard fallback if the token has no exp (shouldn't happen with JWTs)
const FALLBACK_TTL_SECONDS = parseInt(process.env.TOKEN_FALLBACK_TTL || "600", 10); // 10 min

let cachedToken = null;      // string
let tokenExpiryMs = 0;       // number (epoch ms)
let refreshingPromise = null;

// Safe JWT decode (no external dep)
function decodeJwtPayload(token) {
  try {
    const base64Url = token.split(".")[1];
    const json = Buffer.from(base64Url, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isExpiringSoon() {
  const nowMs = Date.now();
  // Refresh if we are past (exp - skew)
  return !tokenExpiryMs || nowMs >= tokenExpiryMs - SKEW_SECONDS * 1000;
}

async function fetchNewToken() {
  const username = process.env.LL_USERNAME;
  const password = process.env.LL_PASSWORD;
  if (!username || !password) {
    throw new Error("LL_USERNAME/LL_PASSWORD are not set");
  }

  // Your existing util that does the actual login
  const res = await utilities.getAccessToken(username, password);

  // support either { token: "..." } or plain string
  const token = res?.token || res;
  if (!token || typeof token !== "string") {
    throw new Error("getAccessToken did not return a token string");
  }

  // Compute expiry from JWT if present; otherwise fallback TTL
  const payload = decodeJwtPayload(token);
  let expMs;
  if (payload?.exp) {
    expMs = payload.exp * 1000; // exp is in seconds
  } else {
    expMs = Date.now() + FALLBACK_TTL_SECONDS * 1000;
  }

  cachedToken = token;
  tokenExpiryMs = expMs;

  // Optional: log once for visibility
  try {
    console.log(
      `[tokenManager] new token exp ${new Date(expMs).toISOString()} (skew=${SKEW_SECONDS}s)`
    );
  } catch {}

  return token;
}

async function refreshAccessTokenSingleFlight() {
  if (!refreshingPromise) {
    refreshingPromise = (async () => {
      return await fetchNewToken();
    })().finally(() => {
      refreshingPromise = null;
    });
  }
  return refreshingPromise;
}

async function getValidAccessToken() {
  if (!cachedToken || isExpiringSoon()) {
    await refreshAccessTokenSingleFlight();
  }
  return cachedToken;
}

// For 401 handlers: force a refresh then provide the new token
async function forceRefresh() {
  cachedToken = null;
  tokenExpiryMs = 0;
  return refreshAccessTokenSingleFlight();
}

module.exports = { getValidAccessToken, forceRefresh };

