// Where to go after signing in: the page someone was sent to /login from (a
// shared poll link, Poster Mode…). Kept in sessionStorage as well as router
// state, because SSO sign-in leaves the app and comes back to "/".
const KEY = 'marquee-return-to';

// Only paths on this site — never "//other.host" or a full URL.
function safePath(path: unknown): string | null {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/login')
    ? path
    : null;
}

export function rememberReturnTo(path: string) {
  try {
    if (safePath(path)) sessionStorage.setItem(KEY, path);
  } catch {
    // storage unavailable (private mode): sign-in still works, it just lands on Home
  }
}

export function peekReturnTo(): string | null {
  try {
    return safePath(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function clearReturnTo() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
