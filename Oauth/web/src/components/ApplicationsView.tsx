import React, { useState } from 'react';
import { Plus, Copy, Check, Eye, EyeOff, Trash2, Play, AlertCircle } from 'lucide-react';
import type { Locale, OAuthApplication } from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface ApplicationsViewProps {
  locale: Locale;
  applications: OAuthApplication[];
  onCreateApp: (payload: { name: string; description: string; redirectUris: string }) => Promise<void>;
  onDeleteApp: (id: string) => Promise<void>;
  onTestAppFlow: (clientId: string) => void;
}

export function ApplicationsView({
  locale,
  applications,
  onCreateApp,
  onDeleteApp,
  onTestAppFlow,
}: ApplicationsViewProps) {
  const t = TRANSLATIONS[locale];
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirectUris, setRedirectUris] = useState('http://localhost:4000/callback\nhttps://app.company.com/auth/callback');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Application name is required.');
      return;
    }
    setCreating(true);
    try {
      await onCreateApp({ name: name.trim(), description: description.trim(), redirectUris });
      setName('');
      setDescription('');
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create application');
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy(key: string, val: string) {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.appsTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.appsSubtitle}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span>{t.createApp}</span>
        </button>
      </div>

      {/* Create Application Panel */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-app-name" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t.appName}
              </label>
              <input
                id="new-app-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CRM Web Console"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label htmlFor="new-app-desc" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Description
              </label>
              <input
                id="new-app-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description for team members"
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div>
            <label htmlFor="new-app-uris" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {t.redirectUris}
            </label>
            <textarea
              id="new-app-uris"
              rows={3}
              required
              value={redirectUris}
              onChange={(e) => setRedirectUris(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          {error && (
            <div role="alert" className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-60"
            >
              {creating ? '...' : t.createApp}
            </button>
          </div>
        </form>
      )}

      {/* Applications Data Table */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {applications.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">No applications registered yet.</p>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-4 px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-medium"
            >
              {t.createApp}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                  <th className="py-3 px-5">{t.appName}</th>
                  <th className="py-3 px-5">{t.clientId}</th>
                  <th className="py-3 px-5">{t.clientSecret}</th>
                  <th className="py-3 px-5">Redirect URIs</th>
                  <th className="py-3 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
                {applications.map((app) => {
                  const revealed = Boolean(revealedSecrets[app.id]);
                  return (
                    <tr
                      key={app.id}
                      className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <td className="py-3.5 px-5 align-top">
                        <div className="font-medium text-slate-900 dark:text-white text-sm">{app.name}</div>
                        {app.description && (
                          <div className="mt-0.5 text-slate-500 dark:text-slate-400 max-w-xs">
                            {app.description}
                          </div>
                        )}
                      </td>

                      <td className="py-3.5 px-5 align-top">
                        <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
                          <span>{app.clientId}</span>
                          <button
                            type="button"
                            aria-label={`Copy Client ID for ${app.name}`}
                            onClick={() => handleCopy(`cid_${app.id}`, app.clientId)}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
                          >
                            {copiedId === `cid_${app.id}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>

                      <td className="py-3.5 px-5 align-top">
                        <div className="flex items-center gap-1.5 font-mono text-slate-700 dark:text-slate-300">
                          <span>{revealed ? app.clientSecret : `${app.clientSecret.slice(0, 7)}••••••••`}</span>
                          <button
                            type="button"
                            aria-label={`Toggle secret visibility for ${app.name}`}
                            onClick={() =>
                              setRevealedSecrets((prev) => ({ ...prev, [app.id]: !prev[app.id] }))
                            }
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
                          >
                            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            aria-label={`Copy Client Secret for ${app.name}`}
                            onClick={() => handleCopy(`sec_${app.id}`, app.clientSecret)}
                            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
                          >
                            {copiedId === `sec_${app.id}` ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>

                      <td className="py-3.5 px-5 align-top">
                        <div className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                          {app.redirectUris.map((uri) => (
                            <div key={uri} className="truncate max-w-[240px]">
                              {uri}
                            </div>
                          ))}
                        </div>
                      </td>

                      <td className="py-3.5 px-5 align-top text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onTestAppFlow(app.clientId)}
                            className="px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 font-medium inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Play className="w-3 h-3" />
                            <span>{t.testOidcFlow}</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${app.name}`}
                            onClick={() => onDeleteApp(app.id)}
                            className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
