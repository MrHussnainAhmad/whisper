function createOriginPolicy(rawValue, nodeEnv) {
  const production = nodeEnv === 'production';
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (production && (!raw || raw === '*')) {
    throw new Error('CORS_ORIGIN must be an explicit comma-separated allow-list in production');
  }

  const allowAny = !production && (!raw || raw === '*');
  const allowed = new Set(
    raw.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin && origin !== '*')
  );

  return {
    values: [...allowed],
    allows(origin) {
      if (!origin) return true;
      return allowAny || allowed.has(origin);
    },
  };
}

module.exports = { createOriginPolicy };
