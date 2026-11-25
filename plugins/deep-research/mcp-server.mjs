#!/usr/bin/env node
/**
 * Atoms Deep Research Plugin — Web Search & Crawler Stdio MCP Server (Zero external dependencies)
 *
 * Capabilities:
 *  - web_search: Optional Tavily / Firecrawl API upgrade, plus built-in zero-key federated search
 *                (Bing RSS + Wikipedia + HackerNews Algolia + GitHub Repos + arXiv).
 *  - web_fetch:  Safe HTTP(S) page fetcher with SSRF guard, HTML-to-Markdown extraction,
 *                and GitHub repo README awareness.
 *  - web_crawl:  Shallow breadth-first crawler (seed URL + high-value subpages).
 *  - extract_links: Fast link discovery for targeted crawling.
 */

const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const FIRECRAWL_API_KEY = (process.env.FIRECRAWL_API_KEY || '').trim();

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 AtomsDeepResearch/1.0';

const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2 MB cap
const DEFAULT_TIMEOUT_MS = 12_000;

const TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the live public web for sources, articles, official docs, GitHub repositories, academic papers, and technical discussions. Supports optional Tavily/Firecrawl keys and built-in multi-source zero-key search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (Chinese or English; use specific keywords and years like 2025/2026 when relevant).',
        },
        maxResults: {
          type: 'integer',
          description: 'Maximum results to return (default 8, max 20).',
          default: 8,
        },
        source: {
          type: 'string',
          enum: ['auto', 'web', 'tech', 'academic', 'github', 'wiki'],
          description:
            'Search channel: "auto" (federated web + wiki + tech), "web" (general search), "tech" (HackerNews + GitHub + web), "academic" (arXiv + wiki), "github" (GitHub repositories), "wiki" (Wikipedia).',
          default: 'auto',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a public HTTP/HTTPS webpage and extract clean Markdown text, title, meta description, and key links. Includes SSRF protection and smart GitHub README extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Public http:// or https:// URL to fetch.',
        },
        maxChars: {
          type: 'integer',
          description: 'Maximum characters of extracted text to return (default 12000, max 24000).',
          default: 12000,
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_crawl',
    description:
      'Shallow breadth-first crawl starting from a seed URL: fetches the seed page, selects high-value links, and crawls up to maxPages pages total (default 4, max 6). Great for official docs or competitor websites.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Seed http:// or https:// URL to start crawling.',
        },
        maxPages: {
          type: 'integer',
          description: 'Total pages to fetch including the seed URL (default 4, max 6).',
          default: 4,
        },
        sameDomainOnly: {
          type: 'boolean',
          description: 'Only follow links on the same domain (default true).',
          default: true,
        },
        maxCharsPerPage: {
          type: 'integer',
          description: 'Max characters per crawled page (default 5000, max 10000).',
          default: 5000,
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'extract_links',
    description:
      'Fetch a public webpage and return its deduplicated links with anchor text so you can decide which subpages are worth deep-fetching.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Public http:// or https:// URL.',
        },
        sameDomainOnly: {
          type: 'boolean',
          description: 'Restrict returned links to the same hostname (default false).',
          default: false,
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of links to return (default 30, max 80).',
          default: 30,
        },
      },
      required: ['url'],
    },
  },
];

// ---------------------------------------------------------------------------
// SSRF & URL Safety
// ---------------------------------------------------------------------------

function isPrivateOrBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  // IPv4 private / loopback / link-local ranges
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  // IPv6 ULA / link-local
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return true;
  }

  return false;
}

function validatePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL protocol "${parsed.protocol}". Only http/https are allowed.`);
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error(`Blocked private or loopback host "${parsed.hostname}" (SSRF protection).`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// HTML / XML Parsing & Markdown Cleaning (Zero Dependencies)
// ---------------------------------------------------------------------------

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og?.[1]) return decodeHtmlEntities(og[1]).trim();
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? stripTags(m[1]) : '';
}

function extractMetaDescription(html) {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeHtmlEntities(m[1]).trim();
  }
  return '';
}

function extractLinksFromHtml(html, baseUrl, sameDomainOnly = false, limit = 40) {
  const base = new URL(baseUrl);
  const seen = new Set();
  const links = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const rawHref = decodeHtmlEntities(match[1]).trim();
    if (!rawHref || /^(javascript:|mailto:|tel:|data:)/i.test(rawHref)) continue;
    let abs;
    try {
      abs = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    if (isPrivateOrBlockedHost(abs.hostname)) continue;
    if (sameDomainOnly && abs.hostname !== base.hostname) continue;
    abs.hash = '';
    const href = abs.toString();
    if (seen.has(href)) continue;
    // Skip binary asset URLs
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|mp4|mp3|zip|tar\.gz|dmg|exe)$/i.test(abs.pathname)) {
      continue;
    }
    const text = stripTags(match[2]).slice(0, 120);
    seen.add(href);
    links.push({ url: href, text: text || abs.pathname });
    if (links.length >= limit) break;
  }
  return links;
}

function htmlToMarkdown(html) {
  let body = String(html || '');
  // Prefer <main> or <article> when substantial
  const articleMatch = body.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (articleMatch?.[1] && articleMatch[1].length > 500) {
    body = articleMatch[1];
  } else {
    const bodyMatch = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch?.[1]) body = bodyMatch[1];
  }

  // Strip non-content containers
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe|nav|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n');

  // Preserve semantic structure
  body = body
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, c) => `\n# ${stripTags(c)}\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, c) => `\n## ${stripTags(c)}\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, c) => `\n### ${stripTags(c)}\n`)
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, (_m, c) => `\n#### ${stripTags(c)}\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c) => `\n\`\`\`\n${stripTags(c)}\n\`\`\`\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `\n- ${stripTags(c)}`)
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, c) => {
      const cells = [...c.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) => stripTags(x[1]));
      return cells.length ? `\n| ${cells.join(' | ')} |` : '';
    })
    .replace(/<(?:p|div|section|blockquote|br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(body);
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchTextSafe(rawUrl, timeoutMs = DEFAULT_TIMEOUT_MS, extraHeaders = {}) {
  const parsed = validatePublicUrl(rawUrl);
  const res = await fetch(parsed.toString(), {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Re-validate final redirected URL against SSRF
  if (res.url) {
    validatePublicUrl(res.url);
  }

  const contentType = res.headers.get('content-type') || '';
  const reader = res.body?.getReader();
  const chunks = [];
  let total = 0;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FETCH_BYTES) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_FETCH_BYTES))));
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
      chunks.push(value);
    }
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const text = buffer.toString('utf8');
  return {
    ok: res.ok,
    status: res.status,
    finalUrl: res.url || parsed.toString(),
    contentType,
    text,
  };
}

// ---------------------------------------------------------------------------
// Search Backends
// ---------------------------------------------------------------------------

async function searchTavily(query, maxResults) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: maxResults,
      search_depth: 'advanced',
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: (r.content || '').slice(0, 450),
    source: 'tavily',
    publishedAt: r.published_date || undefined,
  }));
}

async function searchFirecrawl(query, maxResults) {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({ query, limit: maxResults }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: (r.description || r.markdown || '').slice(0, 450),
    source: 'firecrawl',
  }));
}

async function searchBingRss(query, maxResults) {
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  const host = hasCjk ? 'https://cn.bing.com/search' : 'https://www.bing.com/search';
  const url = `${host}?q=${encodeURIComponent(query)}&format=rss${hasCjk ? '&setlang=zh-CN' : '&setlang=en-US'}`;
  const res = await fetchTextSafe(url, 10_000);
  if (!res.ok) return [];
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(res.text)) !== null) {
    const block = m[1];
    const title = stripTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = decodeHtmlEntities(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
    const desc = stripTags(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '');
    const pubDate = stripTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '');
    if (!link || !/^https?:\/\//i.test(link)) continue;
    items.push({
      title: title || link,
      url: link,
      snippet: desc.slice(0, 400),
      source: 'bing-rss',
      publishedAt: pubDate || undefined,
    });
    if (items.length >= maxResults) break;
  }
  // Filter out off-topic geo-fallback items that share zero query tokens
  const queryTokens = query
    .toLowerCase()
    .split(/[\s,，。？?、/|+-]+/)
    .filter((t) => t.length >= 2);
  if (queryTokens.length > 0) {
    return items.filter((item) => {
      const hay = `${item.title} ${item.snippet} ${item.url}`.toLowerCase();
      return queryTokens.some((tok) => hay.includes(tok));
    });
  }
  return items;
}

async function searchWikipedia(query, maxResults) {
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  const lang = hasCjk ? 'zh' : 'en';
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    query,
  )}&format=json&srlimit=${Math.min(maxResults, 6)}`;
  const res = await fetchTextSafe(url, 10_000);
  if (!res.ok) return [];
  const json = JSON.parse(res.text);
  return (json.query?.search || []).map((item) => ({
    title: `${item.title} — Wikipedia (${lang})`,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    snippet: stripTags(item.snippet || '').slice(0, 400),
    source: `wikipedia-${lang}`,
    publishedAt: item.timestamp ? String(item.timestamp).slice(0, 10) : undefined,
  }));
}

async function searchHackerNews(query, maxResults) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
    query,
  )}&tags=story&hitsPerPage=${Math.min(maxResults, 8)}`;
  const res = await fetchTextSafe(url, 10_000);
  if (!res.ok) return [];
  const json = JSON.parse(res.text);
  return (json.hits || [])
    .filter((h) => h.url || h.objectID)
    .map((h) => ({
      title: h.title || 'Hacker News Discussion',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `Hacker News (${h.points || 0} pts, ${h.num_comments || 0} comments) — HN Thread: https://news.ycombinator.com/item?id=${h.objectID}`,
      source: 'hackernews',
      publishedAt: h.created_at ? String(h.created_at).slice(0, 10) : undefined,
    }));
}

async function searchGitHubRepos(query, maxResults) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query,
  )}&sort=stars&per_page=${Math.min(maxResults, 6)}`;
  const res = await fetchTextSafe(url, 10_000, {
    Accept: 'application/vnd.github+json',
  });
  if (!res.ok) return [];
  const json = JSON.parse(res.text);
  return (json.items || []).map((repo) => ({
    title: `${repo.full_name} (★ ${repo.stargazers_count})`,
    url: repo.html_url,
    snippet: [repo.description || '', repo.language ? `Language: ${repo.language}` : '']
      .filter(Boolean)
      .join(' · ')
      .slice(0, 400),
    source: 'github',
    publishedAt: repo.updated_at ? String(repo.updated_at).slice(0, 10) : undefined,
  }));
}

async function searchArxiv(query, maxResults) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
    query,
  )}&start=0&max_results=${Math.min(maxResults, 6)}`;
  const res = await fetchTextSafe(url, 10_000);
  if (!res.ok) return [];
  const items = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(res.text)) !== null) {
    const block = m[1];
    const title = stripTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const idUrl = stripTags(block.match(/<id>([\s\S]*?)<\/id>/i)?.[1] || '');
    const summary = stripTags(block.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1] || '');
    const published = stripTags(block.match(/<published>([\s\S]*?)<\/published>/i)?.[1] || '').slice(0, 10);
    if (!idUrl) continue;
    items.push({
      title: title || idUrl,
      url: idUrl,
      snippet: summary.slice(0, 400),
      source: 'arxiv',
      publishedAt: published || undefined,
    });
  }
  return items;
}

function deduplicateResults(lists, maxResults) {
  const seen = new Set();
  const merged = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  // Round-robin interleave so every channel gets fair representation
  for (let i = 0; i < maxLen && merged.length < maxResults; i++) {
    for (const list of lists) {
      if (i >= list.length) continue;
      const item = list[i];
      if (!item?.url) continue;
      const key = item.url.replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= maxResults) break;
    }
  }
  return merged;
}

async function runWebSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is required');
  const maxResults = Math.max(1, Math.min(20, Number(args.maxResults || 8)));
  const source = String(args.source || 'auto').toLowerCase();

  // Optional pro providers first when configured & general search requested
  if ((source === 'auto' || source === 'web') && TAVILY_API_KEY) {
    try {
      const results = await searchTavily(query, maxResults);
      if (results.length > 0) {
        return { query, provider: 'tavily', count: results.length, results };
      }
    } catch {
      // fall through to built-in federated search
    }
  }

  if ((source === 'auto' || source === 'web') && FIRECRAWL_API_KEY) {
    try {
      const results = await searchFirecrawl(query, maxResults);
      if (results.length > 0) {
        return { query, provider: 'firecrawl', count: results.length, results };
      }
    } catch {
      // fall through
    }
  }

  const tasks = [];
  if (source === 'web') {
    tasks.push(searchBingRss(query, maxResults));
  } else if (source === 'wiki') {
    tasks.push(searchWikipedia(query, maxResults));
  } else if (source === 'github') {
    tasks.push(searchGitHubRepos(query, maxResults));
  } else if (source === 'academic') {
    tasks.push(searchArxiv(query, maxResults), searchWikipedia(query, Math.ceil(maxResults / 2)));
  } else if (source === 'tech') {
    tasks.push(
      searchHackerNews(query, Math.ceil(maxResults / 2)),
      searchGitHubRepos(query, Math.ceil(maxResults / 2)),
      searchBingRss(query, Math.ceil(maxResults / 2)),
    );
  } else {
    // auto: federated multi-source search (primary tech/encyclopedia/web channels in parallel)
    tasks.push(
      searchWikipedia(query, 4),
      searchHackerNews(query, 4),
      searchGitHubRepos(query, 4),
      searchBingRss(query, maxResults),
    );
  }

  const settled = await Promise.allSettled(tasks);
  const lists = settled
    .filter((s) => s.status === 'fulfilled' && Array.isArray(s.value))
    .map((s) => s.value);

  const results = deduplicateResults(lists, maxResults);
  return {
    query,
    provider: `federated(${source})`,
    count: results.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Web Fetch & Crawl
// ---------------------------------------------------------------------------

async function fetchPageClean(rawUrl, maxChars = 12000) {
  const clampedMax = Math.max(500, Math.min(24000, Number(maxChars || 12000)));
  const parsed = validatePublicUrl(rawUrl);

  // Optional Firecrawl scrape upgrade when API key is configured
  if (FIRECRAWL_API_KEY) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        },
        body: JSON.stringify({ url: parsed.toString(), formats: ['markdown'] }),
        signal: AbortSignal.timeout(18_000),
      });
      if (res.ok) {
        const payload = await res.json();
        const md = payload?.data?.markdown || '';
        if (md.length > 200) {
          return {
            url: parsed.toString(),
            title: payload?.data?.metadata?.title || parsed.hostname,
            description: payload?.data?.metadata?.description || '',
            contentType: 'text/markdown',
            provider: 'firecrawl',
            charCount: md.length,
            truncated: md.length > clampedMax,
            content: md.slice(0, clampedMax),
            links: [],
          };
        }
      }
    } catch {
      // fall back to direct fetch
    }
  }

  // Smart GitHub Repository handler: fetch raw README directly for crystal-clear docs
  const ghRepoMatch = parsed.hostname === 'github.com'
    ? parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
    : null;
  if (ghRepoMatch) {
    const [, owner, repo] = ghRepoMatch;
    for (const branch of ['main', 'master']) {
      for (const readmeName of ['README.md', 'readme.md']) {
        try {
          const rawReadmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${readmeName}`;
          const r = await fetchTextSafe(rawReadmeUrl, 8_000);
          if (r.ok && r.text.trim().length > 100) {
            return {
              url: parsed.toString(),
              title: `${owner}/${repo} — README`,
              description: `GitHub repository ${owner}/${repo} (${branch}/${readmeName})`,
              contentType: 'text/markdown',
              provider: 'github-raw',
              charCount: r.text.length,
              truncated: r.text.length > clampedMax,
              content: r.text.slice(0, clampedMax),
              links: [],
            };
          }
        } catch {
          // try next candidate
        }
      }
    }
  }

  const res = await fetchTextSafe(parsed.toString(), DEFAULT_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${parsed.toString()}`);
  }

  const isHtml = /text\/html|application\/xhtml/i.test(res.contentType) || /<html\b/i.test(res.text.slice(0, 500));
  const title = isHtml ? extractTitle(res.text) : parsed.pathname.split('/').pop() || parsed.hostname;
  const description = isHtml ? extractMetaDescription(res.text) : '';
  const content = isHtml ? htmlToMarkdown(res.text) : res.text.trim();
  const links = isHtml ? extractLinksFromHtml(res.text, res.finalUrl, false, 20) : [];

  return {
    url: res.finalUrl,
    title: title || res.finalUrl,
    description,
    contentType: res.contentType || 'text/plain',
    provider: 'direct-fetch',
    charCount: content.length,
    truncated: content.length > clampedMax,
    content: content.slice(0, clampedMax),
    links,
  };
}

async function runWebCrawl(args) {
  const seedUrl = String(args.url || '').trim();
  if (!seedUrl) throw new Error('url is required');
  const maxPages = Math.max(1, Math.min(6, Number(args.maxPages || 4)));
  const sameDomainOnly = args.sameDomainOnly !== false;
  const maxCharsPerPage = Math.max(1000, Math.min(10000, Number(args.maxCharsPerPage || 5000)));

  const seedParsed = validatePublicUrl(seedUrl);
  const seedPage = await fetchPageClean(seedParsed.toString(), maxCharsPerPage);
  const pages = [
    {
      url: seedPage.url,
      title: seedPage.title,
      description: seedPage.description,
      content: seedPage.content,
    },
  ];

  if (maxPages <= 1) {
    return { seedUrl: seedPage.url, crawledCount: pages.length, pages };
  }

  const visited = new Set([seedPage.url.replace(/\/+$/, '').toLowerCase()]);
  const candidates = (seedPage.links || [])
    .filter((l) => {
      try {
        const u = new URL(l.url);
        if (sameDomainOnly && u.hostname !== seedParsed.hostname) return false;
        const norm = l.url.replace(/\/+$/, '').toLowerCase();
        if (visited.has(norm)) return false;
        // Skip auth/login/legal noise
        if (/\/(login|signin|signup|register|privacy|terms|cookie|cart|checkout)\b/i.test(u.pathname)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, maxPages - 1);

  const subResults = await Promise.allSettled(
    candidates.map(async (c) => {
      visited.add(c.url.replace(/\/+$/, '').toLowerCase());
      const page = await fetchPageClean(c.url, maxCharsPerPage);
      return {
        url: page.url,
        title: page.title,
        description: page.description,
        content: page.content,
      };
    }),
  );

  for (const r of subResults) {
    if (r.status === 'fulfilled') {
      pages.push(r.value);
    }
  }

  return {
    seedUrl: seedPage.url,
    crawledCount: pages.length,
    pages,
  };
}

async function runExtractLinks(args) {
  const url = String(args.url || '').trim();
  if (!url) throw new Error('url is required');
  const sameDomainOnly = Boolean(args.sameDomainOnly);
  const limit = Math.max(1, Math.min(80, Number(args.limit || 30)));

  const res = await fetchTextSafe(url, DEFAULT_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const links = extractLinksFromHtml(res.text, res.finalUrl, sameDomainOnly, limit);
  return {
    url: res.finalUrl,
    title: extractTitle(res.text),
    count: links.length,
    links,
  };
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'web_search':
      return runWebSearch(args || {});
    case 'web_fetch':
      return fetchPageClean(args?.url, args?.maxChars);
    case 'web_crawl':
      return runWebCrawl(args || {});
    case 'extract_links':
      return runExtractLinks(args || {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Stdio JSON-RPC 2.0 MCP Server Loop
// ---------------------------------------------------------------------------

function sendJson(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (!method) return;
  if (id === undefined || id === null) return; // notification

  try {
    if (method === 'initialize') {
      const protocolVersion = params?.protocolVersion || '2024-11-05';
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'atoms-deep-research-mcp',
            version: '1.0.0',
          },
          instructions:
            'Atoms Deep Research MCP server providing live web_search, web_fetch, web_crawl, and extract_links with SSRF safety.',
        },
      });
      return;
    }

    if (method === 'ping') {
      sendJson({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const data = await handleToolCall(toolName, toolArgs);
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            isError: false,
          },
        });
      } catch (err) {
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        });
      }
      return;
    }

    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '').trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\n');
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      void handleMessage(parsed);
    } catch {
      // ignore malformed input
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
