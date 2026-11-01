import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Config } from '../config.js';
import type { User } from '../domain/types.js';
import { HttpError } from '../errors.js';

const keyFor = (secret: string) => new TextEncoder().encode(secret);

export interface TokenClaims {
  sub: string;
  role: string;
  country: string;
}

/** Signs a token the way the customer's identity provider would. Used by `npm run token` and the tests. */
export async function signToken(auth: Config['auth'], claims: TokenClaims, expiresIn: string | number = '1h'): Promise<string> {
  return new SignJWT({ role: claims.role, country: claims.country })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(auth.issuer)
    .setAudience(auth.audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(keyFor(auth.secret));
}

/** Layer 1: signature, issuer, audience and expiry are all checked; role and country come only from here. */
export async function authenticate(auth: Config['auth'], authorizationHeader: string | undefined): Promise<User> {
  const match = /^Bearer (.+)$/i.exec(authorizationHeader ?? '');
  if (!match) throw new HttpError(401, 'unauthenticated', 'Missing bearer token');
  const token = match[1]!;

  try {
    const { payload } = await jwtVerify(token, keyFor(auth.secret), {
      issuer: auth.issuer,
      audience: auth.audience,
      algorithms: ['HS256'],
    });
    const { sub, role, country } = payload;
    if (typeof sub !== 'string' || typeof role !== 'string' || typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) {
      throw new HttpError(401, 'invalid_token', 'Token is missing the sub, role or country claim');
    }
    return { id: sub, role, country, token };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const expired = error instanceof joseErrors.JWTExpired;
    throw new HttpError(401, 'invalid_token', expired ? 'Token has expired' : 'Token is not valid for this service');
  }
}
