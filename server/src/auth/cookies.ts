export const SESSION_COOKIE_NAME = 'attendance_session';

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export function buildSessionCookieOptions(appBaseUrl: string, ttlHours: number): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: appBaseUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: ttlHours * 60 * 60,
  };
}
