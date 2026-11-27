import { useEffect, useState } from 'react';

interface SetupStatus {
  initialized: boolean;
  locked: boolean;
}

/**
 * Pure Production Frontend Entry (Zero Simulation / Demo Login Code).
 * Connects directly to the embedded Go backend APIs (/api/setup/*, /api/auth/*, /api/links/*, /mcp).
 */
export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [driver, setDriver] = useState<'sqlite3' | 'mysql'>('sqlite3');
  const [dsn, setDsn] = useState('/data/wimotek_url.db');
  const [redisEnabled, setRedisEnabled] = useState(false);
  const [redisAddr, setRedisAddr] = useState('127.0.0.1:6379');
  const [issuerUrl, setIssuerUrl] = useState(window.location.origin);
  const [adminPath, setAdminPath] = useState('/admin');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const isLocalFallback = new URLSearchParams(window.location.search).get('local') === '1';

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((data) => setStatus(data))
      .catch(() => setStatus({ initialized: true, locked: true }));
  }, []);

  useEffect(() => {
    if (status?.initialized && !isLocalFallback) {
      window.location.replace('/api/auth/oauth/login');
    }
  }, [status, isLocalFallback]);

  async function handleTestDb() {
    setFeedback('Testing database connection...');
    const res = await fetch('/api/setup/test-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driver, dsn }),
    });
    const body = await res.json();
    setFeedback(body.ok ? 'Connection succeeded.' : `Connection failed: ${body.error}`);
  }

  async function handleCompleteSetup() {
    setFeedback('Initializing system...');
    const res = await fetch('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        database: { driver, dsn },
        redis: { enabled: redisEnabled, addr: redisAddr, db: 0 },
        issuer_url: issuerUrl,
        admin_path: adminPath,
        admin_email: adminEmail,
        admin_password: adminPassword,
      }),
    });
    const body = await res.json();
    if (res.ok && body.ok) {
      window.location.href = body.admin_path || '/admin';
    } else {
      setFeedback(body.error || 'Setup failed');
    }
  }

  async function handleLocalLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, password: loginPassword }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setLoginError(body.error || 'Login failed');
      return;
    }
    window.location.reload();
  }

  if (!status) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-slate-500">Loading wimotek/url...</div>;
  }

  if (!status.initialized) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
        <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] p-6 space-y-5">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="wimotek/url" className="w-9 h-9" />
            <div>
              <h1 className="text-lg font-semibold">wimotek/url Setup Wizard</h1>
              <p className="text-xs text-slate-500">Initialize database, cache, portal path, and super administrator.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 text-sm">
            <label className="block space-y-1">
              <span className="font-medium">Database Engine</span>
              <select
                value={driver}
                onChange={(e) => {
                  const val = e.target.value as 'sqlite3' | 'mysql';
                  setDriver(val);
                  setDsn(val === 'sqlite3' ? '/data/wimotek_url.db' : 'user:pass@tcp(127.0.0.1:3306)/wimotek_url');
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
              >
                <option value="sqlite3">SQLite3 (WAL + Anti-Deadlock)</option>
                <option value="mysql">MySQL 8.0+</option>
              </select>
            </label>

            <label className="block space-y-1">
              <span className="font-medium">Database DSN</span>
              <input value={dsn} onChange={(e) => setDsn(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono text-xs" />
            </label>

            <button type="button" onClick={handleTestDb} className="justify-self-start px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">
              Test Database Connection
            </button>

            <label className="flex items-center gap-2">
              <input type="checkbox" checked={redisEnabled} onChange={(e) => setRedisEnabled(e.target.checked)} />
              <span>Enable Redis Cache (uncheck to use SQL Cache automatically)</span>
            </label>
            {redisEnabled && (
              <input value={redisAddr} onChange={(e) => setRedisAddr(e.target.value)} placeholder="127.0.0.1:6379" className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono text-xs" />
            )}

            <label className="block space-y-1">
              <span className="font-medium">External Issuer URL</span>
              <input value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
            </label>

            <label className="block space-y-1">
              <span className="font-medium">Protected Admin Path</span>
              <input value={adminPath} onChange={(e) => setAdminPath(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent font-mono text-xs" />
            </label>

            <label className="block space-y-1">
              <span className="font-medium">Super Admin Email</span>
              <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
            </label>

            <label className="block space-y-1">
              <span className="font-medium">Super Admin Password (min 8 chars)</span>
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent" />
            </label>
          </div>

          {feedback && <p className="text-xs text-blue-600 dark:text-blue-400">{feedback}</p>}

          <button type="button" onClick={handleCompleteSetup} className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            Initialize & Lock System
          </button>
        </div>
      </main>
    );
  }

  if (status.initialized && !isLocalFallback) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-500">
        Redirecting directly to wimotek/Oauth...
      </div>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
      <form
        onSubmit={handleLocalLogin}
        className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[10px] p-6 space-y-4"
      >
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="wimotek/url" className="w-9 h-9" />
          <div>
            <h1 className="text-lg font-semibold">wimotek/url</h1>
            <p className="text-xs text-slate-500">Shorten Your URL — Direct Sign In</p>
          </div>
        </div>
        <label className="block space-y-1 text-xs">
          <span className="font-medium">Email</span>
          <input
            type="email"
            required
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="font-medium">Password</span>
          <input
            type="password"
            required
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent"
          />
        </label>
        {loginError && <p className="text-xs text-red-600">{loginError}</p>}
        <button
          type="submit"
          className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium"
        >
          Sign In
        </button>
        <a
          href="/api/auth/oauth/login"
          className="block w-full text-center py-2 px-4 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
        >
          Continue with wimotek/Oauth
        </a>
      </form>
    </main>
  );
}

