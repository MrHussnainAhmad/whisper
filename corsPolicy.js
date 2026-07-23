function createOriginPolicy(rawValue, nodeEnv) {
  const production = nodeEnv === 'production';
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';

  if (raw === '*') {
    if (production) {
      throw new Error('CORS_ORIGIN="*" is forbidden in production; leave it empty for native-only access or configure explicit HTTPS browser origins');
    }

    return {
      values: [],
      browserAccessEnabled: true,
      allowsBrowserOrigin: () => true,
      allowsRequestOrigin: (origin) => origin === undefined || (typeof origin === 'string' && origin.length > 0),
    };
  }

  // An omitted value is intentionally fail-closed for browsers while still
  // allowing native clients, which generally do not send an Origin header.
  if (!raw) {
    return {
      values: [],
      browserAccessEnabled: false,
      allowsBrowserOrigin: () => false,
      allowsRequestOrigin: (origin) => origin === undefined,
    };
  }

  const configuredOrigins = raw.split(',').map((origin) => origin.trim());
  if (configuredOrigins.some((origin) => !origin)) {
    throw new Error('CORS_ORIGIN contains an empty entry');
  }

  const allowed = new Set();
  for (const configuredOrigin of configuredOrigins) {
    if (configuredOrigin === '*' || configuredOrigin === 'null') {
      throw new Error(`CORS_ORIGIN contains a forbidden origin: ${configuredOrigin}`);
    }

    let parsed;
    try {
      parsed = new URL(configuredOrigin);
    } catch {
      throw new Error(`CORS_ORIGIN contains an invalid origin: ${configuredOrigin}`);
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(`CORS_ORIGIN must contain origins only (scheme, host, and optional port): ${configuredOrigin}`);
    }

    if (production && parsed.protocol !== 'https:') {
      throw new Error(`CORS_ORIGIN must use HTTPS in production: ${configuredOrigin}`);
    }

    allowed.add(parsed.origin);
  }

  return {
    values: [...allowed],
    browserAccessEnabled: allowed.size > 0,
    allowsBrowserOrigin: (origin) => typeof origin === 'string' && allowed.has(origin),
    allowsRequestOrigin: (origin) => origin === undefined || (typeof origin === 'string' && allowed.has(origin)),
  };
}

module.exports = { createOriginPolicy };
