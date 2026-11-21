const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export interface LoginPageOptions {
  action: string;
  requestId: string;
  clientName?: string;
  redirectUri: string;
  immichUrl: string;
  email?: string;
  error?: string;
  keyName?: string;
}

export function renderLoginPage(o: LoginPageOptions): string {
  const destination = new URL(o.redirectUri).host;
  const app = o.clientName ? `${escape(o.clientName)} (${escape(destination)})` : escape(destination);
  const keyName = escape(o.keyName ?? 'Claude (immich-mcp)');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to Immich</title>
<style>
  :root { color-scheme: light dark; --accent: #4250af; }
  @media (prefers-color-scheme: dark) { :root { --accent: #adcbfa; } }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: Canvas; color: CanvasText; }
  main { width: min(26rem, 100% - 2rem); padding: 2rem; border-radius: 1rem;
         border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; }
  .muted { opacity: .75; font-size: .9rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; margin-top: .3rem; font: inherit;
          border-radius: .5rem; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
  button { margin-top: 1.5rem; width: 100%; padding: .7rem; font: inherit; font-weight: 600; border: 0;
           border-radius: .5rem; background: var(--accent); color: Canvas; cursor: pointer; }
  .error { padding: .6rem .8rem; border-radius: .5rem; background: color-mix(in srgb, red 15%, transparent); }
</style>
</head>
<body>
<main>
  <h1>Sign in to Immich</h1>
  <p><strong>${app}</strong> is asking to use <strong>${escape(new URL(o.immichUrl).host)}</strong> as you:
     find and view your photos, and edit descriptions, tags, ratings, dates, places and people.
     It cannot delete anything.</p>
  ${o.error ? `<p class="error" role="alert">${escape(o.error)}</p>` : ''}
  <form method="post" action="${escape(o.action)}">
    <input type="hidden" name="request_id" value="${escape(o.requestId)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escape(o.email ?? '')}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in and allow</button>
  </form>
  <p class="muted">Your password goes to Immich once and is not stored. Signing in creates an API key named
     “${keyName}” in your Immich account; delete it under Account Settings → API Keys to end this access.</p>
</main>
</body>
</html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:30rem;padding:0 1rem}</style>
</head><body><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
}
