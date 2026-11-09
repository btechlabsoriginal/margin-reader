import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError } from './api';
import type { Article, Collection, FullArticle, TagsResponse } from './types';
import './styles.css';

type View = 'inbox' | 'archive' | `tag:${string}`;
type Font = 'literary' | 'modern';
type Theme = 'paper' | 'night' | 'white';
type Preference = { font: Font; theme: Theme; size: number };

const defaultPreference: Preference = { font: 'literary', theme: 'paper', size: 19 };

function initialPreference(): Preference {
  try {
    return { ...defaultPreference, ...JSON.parse(localStorage.getItem('margin.preferences') ?? '{}') };
  } catch {
    return defaultPreference;
  }
}

function elapsed(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(timestamp);
}

function mark(text: string, offsets: Array<[number, number]> = []): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of offsets) {
    if (start < cursor || end <= start || end > text.length) continue;
    parts.push(text.slice(cursor, start));
    parts.push(<mark key={`${start}:${end}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts;
}

function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/session', { method: 'POST', body: JSON.stringify({ password }) });
      onUnlock();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  return <main className="lock-shell">
    <form className="lock-card" onSubmit={submit}>
      <div className="brand-symbol">m<span>.</span></div>
      <div className="eyebrow">YOUR READING SPACE</div>
      <h1>Welcome back.</h1>
      <p>Everything you saved, exactly where you left it.</p>
      <label htmlFor="password">Password</label>
      <input id="password" autoFocus type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter your password" required />
      {error && <div className="form-error">{error}</div>}
      <button className="primary wide" disabled={busy}>{busy ? 'Unlocking…' : 'Open my library'}</button>
    </form>
  </main>;
}

function Icon({ name, size = 18 }: { name: 'search' | 'plus' | 'tray' | 'archive' | 'arrow' | 'trash' | 'check' | 'external' | 'refresh' | 'lock' | 'tag' | 'close'; size?: number }) {
  const paths: Record<typeof name, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    tray: <><path d="M4 4h16v16H4zM4 14h5l2 3h2l2-3h5"/></>,
    archive: <><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/></>,
    arrow: <path d="M5 12h14m-7-7 7 7-7 7"/>,
    trash: <><path d="M4 7h16M10 4h4m-8 3 1 13h10l1-13M10 11v6m4-6v6"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    external: <><path d="M13 5h6v6M19 5l-9 9"/><path d="M19 14v5H5V5h5"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    tag: <><path d="M4 4h8l8 8-8 8-8-8z"/><circle cx="9" cy="9" r="1"/></>,
    close: <path d="M5 5l14 14M19 5 5 19"/>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" aria-hidden="true">{paths[name]}</svg>;
}

function App() {
  const [session, setSession] = useState<'loading' | 'locked' | 'ready'>('loading');
  const [view, setView] = useState<View>('inbox');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [articles, setArticles] = useState<Article[]>([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<TagsResponse['items']>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<FullArticle | null>(null);
  const [showReader, setShowReader] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newTags, setNewTags] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [preferences, setPreferences] = useState(initialPreference);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const requestNumber = useRef(0);

  useEffect(() => {
    api('/api/session').then(() => setSession('ready')).catch(() => setSession('locked'));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(query.trim()), 180);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => {
    localStorage.setItem('margin.preferences', JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        setShowSave(true);
      }
      if (event.key === 'Escape') {
        setShowSave(false);
        setShowReader(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const refresh = useCallback(async () => {
    if (session !== 'ready') return;
    const number = ++requestNumber.current;
    const path = search
      ? `/api/search?q=${encodeURIComponent(search)}&limit=60&archived=${view === 'archive' ? 1 : 0}`
      : `/api/articles?limit=60&archived=${view === 'archive' ? 1 : 0}${view.startsWith('tag:') ? `&tag=${encodeURIComponent(view.slice(4))}` : ''}`;
    try {
      const [collection, tagResult] = await Promise.all([api<Collection>(path), api<TagsResponse>('/api/tags')]);
      if (number !== requestNumber.current) return;
      setArticles(collection.items);
      setTotal(collection.total);
      setTags(tagResult.items);
      setSelectedId(old => old !== null && collection.items.some(article => article.id === old) ? old : collection.items[0]?.id ?? null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) setSession('locked');
      else setNotice(reason instanceof Error ? reason.message : 'Could not refresh library');
    } finally {
      setLoading(false);
    }
  }, [session, search, view]);

  useEffect(() => {
    if (session !== 'ready') return;
    setLoading(true);
    void refresh();
    const interval = window.setInterval(refresh, 4500);
    return () => window.clearInterval(interval);
  }, [refresh, session]);

  const selectedVersion = articles.find(article => article.id === selectedId)?.updatedAt ?? 0;

  useEffect(() => {
    if (selectedId === null || session !== 'ready') {
      setSelected(null);
      return;
    }
    let alive = true;
    api<FullArticle>(`/api/articles/${selectedId}`).then(article => {
      if (alive) setSelected(article);
    }).catch(() => { if (alive) setSelected(null); });
    return () => { alive = false; };
  }, [selectedId, selectedVersion, session]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ article: Article; duplicate: boolean }>('/api/articles', {
        method: 'POST', body: JSON.stringify({ url: newUrl, tags: newTags.split(',').map(item => item.trim()).filter(Boolean) })
      });
      setShowSave(false);
      setNewUrl('');
      setNewTags('');
      setView('inbox');
      setQuery('');
      setSearch('');
      setSelectedId(result.article.id);
      setNotice(result.duplicate ? 'Already saved — opened the existing copy.' : 'Saved. Fetching the article now.');
      void refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not save link');
    } finally {
      setSaving(false);
    }
  }

  async function update(id: number, patch: { archived?: boolean; tags?: string[] }) {
    try {
      await api(`/api/articles/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setNotice(patch.archived === true ? 'Moved to archive.' : patch.archived === false ? 'Returned to inbox.' : 'Tags updated.');
      void refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not update article');
    }
  }

  async function remove(id: number) {
    if (!window.confirm('Delete this saved article? This cannot be undone.')) return;
    try {
      await api(`/api/articles/${id}`, { method: 'DELETE' });
      setSelectedId(null);
      setNotice('Article deleted.');
      void refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not delete article');
    }
  }

  async function retry(id: number) {
    try {
      await api(`/api/articles/${id}/retry`, { method: 'POST' });
      setNotice('Trying again.');
      void refresh();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not retry');
    }
  }

  async function signOut() {
    try {
      await api('/api/session', { method: 'DELETE' });
      setSession('locked');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not sign out');
    }
  }

  if (session === 'loading') return <div className="boot">margin<span>.</span></div>;
  if (session === 'locked') return <LockScreen onUnlock={() => setSession('ready')} />;

  const viewTitle = search ? 'Search results' : view === 'archive' ? 'Archive' : view.startsWith('tag:') ? `# ${view.slice(4)}` : 'Your library';
  const picked = selected && selected.id === selectedId ? selected : null;

  return <div className={`app-shell theme-${preferences.theme}`}>
    <aside className="sidebar">
      <div className="identity"><div className="brand-symbol">m<span>.</span></div><div className="brand-name">margin<span>.</span><small>READ IT LATER, BEAUTIFULLY</small></div></div>
      <button className="primary add-button" onClick={() => setShowSave(true)}><Icon name="plus" /> Save a link <span className="shortcut">⌘ S</span></button>
      <div className="nav-section-title">LIBRARY</div>
      <nav aria-label="Library">
        <button className={`nav-item ${view === 'inbox' ? 'active' : ''}`} onClick={() => { setView('inbox'); setQuery(''); setShowReader(false); }}><Icon name="tray" /> Inbox</button>
        <button className={`nav-item ${view === 'archive' ? 'active' : ''}`} onClick={() => { setView('archive'); setQuery(''); setShowReader(false); }}><Icon name="archive" /> Archive</button>
      </nav>
      <div className="nav-section-title tags-heading">YOUR TAGS <span>{tags.length}</span></div>
      <nav className="tag-navigation" aria-label="Tags">
        {tags.map(tag => <button key={tag.name} className={`nav-item ${view === `tag:${tag.name}` ? 'active' : ''}`} onClick={() => { setView(`tag:${tag.name}`); setQuery(''); setShowReader(false); }}><span className="tag-dot" /> <span className="truncate">{tag.name}</span><span className="tag-count">{tag.count}</span></button>)}
        {tags.length === 0 && <p className="sidebar-hint">Organise your saves with tags.</p>}
      </nav>
      <div className="sidebar-footer"><div className="sidebar-quote">“The more that you read,<br/>the more things you will know.”</div><div className="sidebar-footer-row"><span>YOUR PRIVATE LIBRARY</span><button className="icon-button" title="Sign out" onClick={signOut}><Icon name="lock" size={16}/></button></div></div>
    </aside>

    <section className={`collection-panel ${showReader ? 'mobile-hidden' : ''}`}>
      <header className="collection-header">
        <div className="breadcrumb">LIBRARY <span>/</span> {viewTitle.toUpperCase()}</div>
        <h1>{viewTitle}<span className="total-count">{total}</span></h1>
        <div className="search-holder"><Icon name="search" size={18}/><input ref={searchInput} aria-label="Search saved articles" placeholder="Search everything you've saved" value={query} onChange={event => setQuery(event.target.value)} /><kbd>⌘ K</kbd></div>
      </header>
      <div className="collection-label"><span>{search ? `MATCHING “${search}”` : 'SAVED STORIES'}</span><span>{loading ? 'LOADING' : `${total} ITEMS`}</span></div>
      <div className="article-list">
        {articles.map(article => <button key={article.id} className={`article-card ${article.id === selectedId ? 'chosen' : ''}`} onClick={() => { setSelectedId(article.id); setShowReader(true); }}>
          <div className="article-topline"><span className="site-name">{article.site}</span><span>{elapsed(article.createdAt)}</span></div>
          <h2>{mark(article.title, article.titleOffsets)}</h2>
          <p>{mark(article.snippet ?? article.excerpt, article.snippetOffsets)}</p>
          <div className="article-card-foot"><span>{article.author || (article.status === 'ready' ? 'Saved article' : article.status === 'failed' ? 'Unavailable' : 'Fetching content…')}</span><div>{article.tags.slice(0, 2).map(tag => <span className="small-tag" key={tag}>{tag}</span>)}{article.status === 'processing' && <span className="status-dot" />}</div></div>
        </button>)}
        {articles.length === 0 && <div className="empty-list"><span className="empty-ornament">✳</span><h3>{search ? 'Nothing matches yet.' : view === 'archive' ? 'Your archive is empty.' : 'A little room to think.'}</h3><p>{search ? 'Try another word or a shorter phrase.' : 'Save something worth returning to. Your next great read belongs here.'}</p>{!search && <button className="secondary" onClick={() => setShowSave(true)}>Save your first link <Icon name="arrow" size={16}/></button>}</div>}
      </div>
    </section>

    <main className={`reader-panel ${!showReader ? 'mobile-hidden' : ''}`}>
      {picked ? <>
        <div className="reader-toolbar"><button className="mobile-back" onClick={() => setShowReader(false)}>← Library</button><div className="reader-location">YOUR READING SPACE <span> / </span> {picked.site.toUpperCase()}</div><div className="toolbar-actions"><a className="icon-button" href={picked.url} target="_blank" rel="noopener noreferrer" title="Open original"><Icon name="external"/></a><button className="icon-button" title={picked.archived ? 'Unarchive' : 'Archive'} onClick={() => void update(picked.id, { archived: !picked.archived })}><Icon name="archive"/></button><button className="icon-button danger" title="Delete" onClick={() => void remove(picked.id)}><Icon name="trash"/></button></div></div>
        <div className="reader-scroll"><div className="reading-wrap">
          <div className="reader-kicker"><span className="dot" /> {picked.site} <span className="kicker-line" /></div>
          <h1 className="reading-title">{picked.title}</h1>
          <div className="byline"><span>{picked.author || 'Author not listed'}</span>{picked.publishedAt && <><span className="separator">·</span><time dateTime={picked.publishedAt}>{new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(picked.publishedAt))}</time></>}</div>
          <div className="reading-rule"><span>✦</span></div>
          {picked.status === 'ready' ? <div className={`reading-content font-${preferences.font}`} style={{ fontSize: preferences.size }} dangerouslySetInnerHTML={{ __html: picked.contentHtml }} />
            : <div className="reading-pending"><div className="pending-art">{picked.status === 'failed' ? '!' : '↻'}</div><h3>{picked.status === 'failed' ? 'This article couldn’t be fetched.' : 'Making this page readable.'}</h3><p>{picked.error || (picked.status === 'pending' ? 'Your article is in the queue. It will appear here automatically.' : 'Extracting the story, removing the clutter.')}</p>{picked.status === 'failed' && <button className="secondary" onClick={() => void retry(picked.id)}><Icon name="refresh" size={17}/> Try again</button>}</div>}
          <div className="reader-tags"><div className="reader-tags-caption">FILED UNDER</div><div className="tag-line">{picked.tags.map(tag => <span key={tag} className="reader-tag"># {tag}<button type="button" aria-label={`Remove ${tag} tag`} title={`Remove ${tag} tag`} onClick={() => void update(picked.id, { tags: picked.tags.filter(name => name !== tag) })}>×</button></span>)}<form onSubmit={event => { event.preventDefault(); const input = tagInput.trim(); if (input) void update(picked.id, { tags: [...picked.tags, input] }); setTagInput(''); }}><input value={tagInput} maxLength={32} aria-label="Add tag" onChange={event => setTagInput(event.target.value)} placeholder="+ Add a tag" /></form></div></div>
        </div></div>
        <div className="reader-bottom"><span>THE PLEASURE OF READING, MINUS THE NOISE</span><div className="reading-settings"><button className={preferences.font === 'literary' ? 'selected-setting' : ''} onClick={() => setPreferences(current => ({ ...current, font: 'literary' }))} title="Serif font">Aa</button><button className={preferences.font === 'modern' ? 'selected-setting' : ''} onClick={() => setPreferences(current => ({ ...current, font: 'modern' }))} title="Sans-serif font">Ag</button><span className="control-divider"/><button title="Decrease font size" onClick={() => setPreferences(current => ({ ...current, size: Math.max(15, current.size - 1) }))}>A−</button><button title="Increase font size" onClick={() => setPreferences(current => ({ ...current, size: Math.min(26, current.size + 1) }))}>A+</button><span className="control-divider"/>{(['paper', 'white', 'night'] as const).map(theme => <button key={theme} aria-label={`${theme} theme`} title={`${theme} theme`} className={`theme-swatch swatch-${theme} ${preferences.theme === theme ? 'selected-swatch' : ''}`} onClick={() => setPreferences(current => ({ ...current, theme }))}/>)}</div></div>
      </> : <div className="reader-placeholder"><span className="placeholder-flower">✳</span><h2>A quiet place<br/>for good stories.</h2><p>Select an article to settle in.</p></div>}
    </main>

    {showSave && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShowSave(false); }}><form className="save-modal" onSubmit={save}><button type="button" className="modal-close" aria-label="Close" onClick={() => setShowSave(false)}><Icon name="close"/></button><div className="modal-eyebrow">ADD TO YOUR LIBRARY</div><h2>Something worth keeping?</h2><p>Paste the link. We’ll take care of the clutter.</p><label htmlFor="new-url">Article URL</label><input id="new-url" autoFocus type="url" value={newUrl} onChange={event => setNewUrl(event.target.value)} placeholder="https://example.com/a-good-story" required/><label htmlFor="new-tags">Tags <span>OPTIONAL · SEPARATE WITH COMMAS</span></label><input id="new-tags" value={newTags} onChange={event => setNewTags(event.target.value)} placeholder="design, ideas, essays"/><button className="primary wide" disabled={saving}>{saving ? 'Saving…' : 'Save to Margin'} <Icon name="arrow" size={17}/></button></form></div>}
    {notice && <div role="status" className="toast" onClick={() => setNotice('')}>{notice}<button aria-label="Dismiss"><Icon name="close" size={14}/></button></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
