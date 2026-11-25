import React, { useEffect, useState } from 'react';
import { Folder, FileCode2, Download, Copy, Check } from 'lucide-react';
import type { Locale, RepoFileNode } from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface RepoExportViewProps {
  locale: Locale;
  onDownloadZip: () => void;
  downloadingZip: boolean;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: RepoFileNode;
  depth: number;
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  if (node.type === 'dir') {
    return (
      <div>
        <div
          style={{ paddingLeft: `${depth * 14 + 12}px` }}
          className="py-1.5 pr-3 flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300"
        >
          <Folder className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="truncate font-mono">{node.name}/</span>
        </div>
        {node.children?.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  const active = selectedPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      style={{ paddingLeft: `${depth * 14 + 12}px` }}
      className={`w-full py-1.5 pr-3 text-left flex items-center justify-between gap-2 text-xs font-mono transition-colors ${
        active
          ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-medium'
          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/40'
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <FileCode2 className="w-3.5 h-3.5 shrink-0 opacity-75" />
        <span className="truncate">{node.name}</span>
      </span>
      {typeof node.size === 'number' && (
        <span className="text-[10px] text-slate-400 tabular-nums shrink-0">
          {(node.size / 1024).toFixed(1)}k
        </span>
      )}
    </button>
  );
}

export function RepoExportView({ locale, onDownloadZip, downloadingZip }: RepoExportViewProps) {
  const t = TRANSLATIONS[locale];
  const [tree, setTree] = useState<RepoFileNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>('Oauth/Dockerfile');
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/repo/tree')
      .then((r) => r.json())
      .then((data) => setTree(data.tree || []))
      .catch(() => setTree([]));
  }, []);

  useEffect(() => {
    if (!selectedPath) return;
    setLoading(true);
    fetch(`/api/repo/file?path=${encodeURIComponent(selectedPath)}`)
      .then((r) => r.json())
      .then((data) => setFileContent(data.content || ''))
      .catch(() => setFileContent('// Unable to read file'))
      .finally(() => setLoading(false));
  }, [selectedPath]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.repoTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.repoSubtitle}
          </p>
        </div>

        <button
          type="button"
          onClick={onDownloadZip}
          disabled={downloadingZip}
          className="min-h-[42px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors disabled:opacity-60"
        >
          <Download className="w-4 h-4" />
          <span>{downloadingZip ? t.downloadingZip : t.downloadAllZip} (wimotek-Oauth-complete.zip)</span>
        </button>
      </div>

      {/* Isolation Legend */}
      <div className="grid grid-cols-1 md:grid-cols-3 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#111827] divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-800 text-xs">
        <div className="p-4">
          <div className="font-mono font-semibold text-slate-900 dark:text-white">Oauth/</div>
          <p className="mt-1 text-slate-600 dark:text-slate-400">
            Production Go single-binary core, embedded React SPA, non-root Dockerfile, and 5-language SDKs.
          </p>
        </div>
        <div className="p-4">
          <div className="font-mono font-semibold text-slate-900 dark:text-white">dev/</div>
          <p className="mt-1 text-slate-600 dark:text-slate-400">
            Strictly isolated sandbox compose stack (MySQL 8, Redis 7, local Mock Business App).
          </p>
        </div>
        <div className="p-4">
          <div className="font-mono font-semibold text-slate-900 dark:text-white">.github/workflows/</div>
          <p className="mt-1 text-slate-600 dark:text-slate-400">
            Multi-arch (linux/amd64, linux/arm64) release pipeline pushing to Docker Hub &amp; GHCR.
          </p>
        </div>
      </div>

      {/* File Explorer + Source Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#111827] overflow-hidden min-h-[520px]">
        <aside className="lg:col-span-4 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 py-3 overflow-y-auto max-h-[580px]">
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          ))}
        </aside>

        <div className="lg:col-span-8 flex flex-col min-w-0">
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-900/40">
            <span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
              {selectedPath}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? t.copied : t.copyCode}</span>
            </button>
          </div>
          <pre className="flex-1 p-5 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/40 dark:bg-[#0B0F19] overflow-auto max-h-[530px] leading-relaxed">
            {loading ? 'Loading source...' : fileContent}
          </pre>
        </div>
      </div>
    </div>
  );
}
