/** Single source of truth for reverse-proxy trust. */
const rawTrustProxy = process.env.TRUST_PROXY ?? '0';
const parsedTrustProxy = Number(rawTrustProxy);

if (!Number.isInteger(parsedTrustProxy) || parsedTrustProxy < 0) {
  throw new Error('TRUST_PROXY must be a non-negative integer hop count');
}

module.exports = { TRUST_PROXY_HOPS: parsedTrustProxy };
