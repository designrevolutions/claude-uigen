// auth.ts handles session management via HTTP-only JWT cookies.
// "server-only" is a Next.js guard that causes a build error if this module is
// accidentally imported in a Client Component, preventing the JWT secret from
// leaking to the browser bundle.
import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

// TextEncoder converts the secret string to Uint8Array, which is what the jose
// library's HMAC functions expect.  The fallback value is intentionally weak
// and only suitable for local development — production deployments must set
// JWT_SECRET to a cryptographically random value.
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "development-secret-key"
);

const COOKIE_NAME = "auth-token";

export interface SessionPayload {
  userId: string;
  email: string;
  expiresAt: Date;
}

// Creates a signed JWT and persists it as an HTTP-only cookie.
// Both the JWT `exp` claim and the cookie `expires` attribute are set to 7 days
// so the two expiry mechanisms stay in sync — the JWT expiry is enforced by
// jwtVerify() on the server, while the cookie expiry removes it from the browser.
export async function createSession(userId: string, email: string) {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const session: SessionPayload = { userId, email, expiresAt };

  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .setIssuedAt()
    .sign(JWT_SECRET);

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    // httpOnly prevents JavaScript from reading the cookie, mitigating XSS
    // attacks that would otherwise be able to steal the session token.
    httpOnly: true,
    // secure is only required in production because localhost doesn't use HTTPS.
    secure: process.env.NODE_ENV === "production",
    // sameSite: "lax" blocks the cookie on cross-site POST requests (CSRF) while
    // still allowing it on top-level navigations (e.g. clicking a link).
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

// Reads and verifies the session cookie from the Next.js cookies() store
// (used inside Server Components and Route Handlers).
// Returns null instead of throwing on verification failure so callers can
// treat an invalid/expired token the same as a missing one.
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as SessionPayload;
  } catch (error) {
    // jwtVerify throws on expiry, bad signature, and malformed tokens.
    // All of these are treated as "not authenticated".
    return null;
  }
}

export async function deleteSession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

// verifySession reads from the NextRequest object directly, which is required
// in middleware where the Next.js cookies() helper is not available.
// Functionally identical to getSession() but works in the Edge Runtime.
export async function verifySession(
  request: NextRequest
): Promise<SessionPayload | null> {
  const token = request.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as unknown as SessionPayload;
  } catch (error) {
    return null;
  }
}
