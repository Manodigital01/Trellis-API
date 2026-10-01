export const SNAPSHOT_REDACTED_FIELDS: ReadonlyArray<string> = [
  'password', 'passwordHash', 'hashedPassword', 'secret', 'privateKey',
  'signingKey', 'apiKey', 'accessToken', 'refreshToken', 'authToken',
  'jwtSecret', 'salt', 'mnemonic', 'seedPhrase', 'walletSecret', 'pin',
];

export const REDACTED_PLACEHOLDER = '[REDACTED]';
export const SNAPSHOT_HASH_ALGORITHM = 'sha256';
export const SNAPSHOT_HMAC_ALGORITHM = 'sha256';
export const SNAPSHOT_MAX_RECORDS = 10_000;
export const SNAPSHOT_SIGNING_KEY = 'SNAPSHOT_SIGNING_KEY';
