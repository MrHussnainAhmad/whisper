/** Single source of truth for reverse-proxy trust. */
const rawTrustProxy = process.env.TRUST_PROXY ?? '0';
const parsedTrustProxy = Number(rawTrustProxy);
const proxyaddr = require('proxy-addr');

if (!Number.isInteger(parsedTrustProxy) || parsedTrustProxy < 0) {
  throw new Error('TRUST_PROXY must be a non-negative integer hop count');
}

const cidrs = (process.env.TRUST_PROXY_CIDRS || '').split(',').map((value) => value.trim()).filter(Boolean);
if (parsedTrustProxy > 0 && cidrs.length === 0) {
  throw new Error('TRUST_PROXY_CIDRS must explicitly identify trusted proxies when TRUST_PROXY is enabled');
}
const trustedAddress = cidrs.length ? proxyaddr.compile(cidrs) : () => false;
const trustProxy = (address, index) => index < parsedTrustProxy && trustedAddress(address);
module.exports = { TRUST_PROXY_HOPS: parsedTrustProxy, trustProxy };
