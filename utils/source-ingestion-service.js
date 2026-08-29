const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const axios = require('axios');
const { Logger } = require('./logger');
const { detect } = require('./language-detector');

/**
 * Turns a source URL (a guide, an article, a how-to page) into structured
 * material the script writer can actually follow.
 *
 * The pipeline previously had no way to read a supplied guide: `topic` was a
 * 200-character string and nothing ever fetched it, so "make a video from this
 * guide" degraded into "invent something about this title" — which is how a
 * script ends up being an introduction repeated instead of the guide's table of
 * contents.
 *
 * Two products come out of ingestion:
 *   1. an outline (the headings) plus the text under each heading, which becomes
 *      the script's section structure;
 *   2. real screenshots of the page, which give the video visuals that show the
 *      thing being described rather than decorative AI art.
 */

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

class SourceIngestionService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('SourceIngestion');
    this.cacheDir = options.cacheDir || path.join(__dirname, '..', 'data', 'sources');
    this.timeout = Number(options.timeoutMs || process.env.SOURCE_FETCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.userAgent =
      options.userAgent ||
      process.env.SOURCE_FETCH_USER_AGENT ||
      'Mozilla/5.0 (compatible; LumenBot/1.0; +https://github.com/lumen-agent)';
    this.http = options.http || axios;
    this.captureScreenshots = options.captureScreenshots !== false;
  }

  /**
   * Extract every http(s) URL from free-form text. Users routinely paste the
   * guide link straight into the topic field, so treat that as a source.
   */
  static extractUrls(text) {
    if (!text) return [];
    const matches = String(text).match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
    return [...new Set(matches.map(url => url.replace(/[.,;:]+$/, '')))];
  }

  static isValidUrl(value) {
    try {
      const parsed = new URL(String(value));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_error) {
      return false;
    }
  }

  async ingest(url, options = {}) {
    if (!SourceIngestionService.isValidUrl(url)) {
      throw new Error(`Invalid source URL: ${url}`);
    }

    this.logger.info(`Ingesting source document: ${url}`);
    const fetched = await this.fetchHtml(url);
    // Downstream work (screenshots, citations) must use the URL that answered,
    // not the one originally requested.
    const resolvedUrl = fetched.url;
    const document = this.parseDocument(fetched.html, resolvedUrl);

    if (!document.outline.length && document.text.length < 200) {
      throw new Error(`Source document has no usable content: ${url}`);
    }

    if (this.captureScreenshots && options.screenshots !== false) {
      document.screenshots = await this.capturePageScreenshots(resolvedUrl, document, options);
    } else {
      document.screenshots = [];
    }

    await this.persist(document);
    this.logger.info(
      `Source ingested: ${document.outline.length} headings, ${document.wordCount} words, ${document.screenshots.length} screenshots`
    );
    return document;
  }

  async fetchHtml(url) {
    try {
      return { html: await this.requestHtml(url), url };
    } catch (error) {
      // Hosts are normalised without "www." for counting purposes, but plenty of
      // sites only answer on the www subdomain — the bare name does not resolve
      // at all. Retry across the www boundary before giving up.
      const alternate = this.toggleWww(url);
      if (alternate && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(error.code || error.message || '')) {
        this.logger.info(`${url} did not resolve; retrying as ${alternate}`);
        return { html: await this.requestHtml(alternate), url: alternate };
      }
      throw error;
    }
  }

  toggleWww(url) {
    try {
      const parsed = new URL(url);
      parsed.hostname = parsed.hostname.startsWith('www.')
        ? parsed.hostname.slice(4)
        : `www.${parsed.hostname}`;
      return parsed.toString();
    } catch (_error) {
      return null;
    }
  }

  async requestHtml(url) {
    const response = await this.http.get(url, {
      timeout: this.timeout,
      maxContentLength: MAX_HTML_BYTES,
      maxRedirects: 5,
      responseType: 'text',
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.6',
      },
      // Let non-2xx surface as an explicit error rather than parsing an error page.
      validateStatus: status => status >= 200 && status < 300,
    });

    if (typeof response.data !== 'string') {
      throw new Error(`Source returned a non-HTML payload: ${url}`);
    }
    return response.data;
  }

  /**
   * Minimal, dependency-free HTML extraction.
   *
   * A full DOM parser is not a project dependency, and pulling one in for this
   * would be heavier than the job needs: the pipeline only requires the heading
   * hierarchy and the prose beneath each heading.
   */
  parseDocument(html, url) {
    const cleaned = this.stripNonContent(html);
    const title = this.extractTitle(html);
    const outline = this.extractOutline(cleaned);
    const text = this.htmlToText(cleaned);
    const declaredLang = (html.match(/<html[^>]*\blang=["']?([a-z]{2})/i) || [])[1];

    return {
      url,
      title,
      language: (declaredLang || detect(text) || 'fr').toLowerCase().slice(0, 2),
      fetchedAt: new Date().toISOString(),
      outline,
      text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      // The site the guide is *about*, which is what the visuals must show.
      subjectUrl: this.detectSubjectUrl(html, url),
      screenshots: [],
    };
  }

  /**
   * Find the official site a how-to guide describes.
   *
   * A guide and its subject are two different things: an article explaining how
   * to reach an insurer's customer area is not that customer area. Illustrating
   * the video with screenshots of the guide shows the reader the instructions
   * instead of the interface they must operate — the visuals end up picturing
   * the wrong website entirely.
   *
   * The subject is inferred from the outbound links: a guide about one service
   * links to it repeatedly, and to little else.
   */
  detectSubjectUrl(html, guideUrl) {
    let guideHost = '';
    try {
      guideHost = new URL(guideUrl).hostname.replace(/^www\./, '');
    } catch (_error) {
      return null;
    }

    const counts = new Map();
    const noise = /(facebook|twitter|linkedin|instagram|youtube|tiktok|google|gstatic|googleapis|cloudflare|gravatar|schema|w3|wordpress|jsdelivr|unpkg|gmail|apple|microsoft)\./i;

    const record = host => {
      if (!host) return;
      const clean = host.replace(/^www\./, '').toLowerCase();
      if (clean === guideHost || clean.endsWith(`.${guideHost}`)) return;
      if (noise.test(clean)) return;
      counts.set(clean, (counts.get(clean) || 0) + 1);
    };

    for (const match of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
      try {
        record(new URL(match[1]).hostname);
      } catch (_error) { /* malformed href */ }
    }

    // Security-conscious guides deliberately mention the official address as
    // plain text instead of linking it, so readers type it themselves. Those
    // mentions are the strongest signal available and must be counted too.
    const text = this.htmlToText(this.stripNonContent(html));
    for (const match of text.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi)) {
      const candidate = match[1].toLowerCase();
      if (!/\.(com|fr|net|org|eu|be|ch|ca|io)$/.test(candidate)) continue;
      // Skip file names such as "image.png" or version strings.
      if (/\.(png|jpe?g|gif|svg|webp|css|js|json|pdf)$/.test(candidate)) continue;
      record(candidate);
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    // A single stray mention proves nothing; require the domain to recur.
    if (!best || best[1] < 2) return null;
    return `https://${best[0]}/`;
  }

  stripNonContent(html) {
    return String(html)
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<form\b[\s\S]*?<\/form>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
  }

  extractTitle(html) {
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    if (h1) return this.htmlToText(h1).slice(0, 200);
    const ogTitle = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1];
    if (ogTitle) return this.decodeEntities(ogTitle).slice(0, 200);
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    return title ? this.htmlToText(title).slice(0, 200) : '';
  }

  /**
   * Build the outline: each heading plus the text that follows it up to the next
   * heading. That pairing is what lets the script writer produce one section per
   * chapter of the guide instead of restating the introduction.
   */
  extractOutline(html) {
    const headingPattern = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
    const found = [];
    let match;

    while ((match = headingPattern.exec(html)) !== null) {
      const level = Number(match[1]);
      const text = this.htmlToText(match[3]).trim();
      if (!text || text.length > 250) continue;
      found.push({
        level,
        text,
        anchor: (match[2].match(/id=["']([^"']+)["']/i) || [])[1] || null,
        start: match.index,
        end: headingPattern.lastIndex,
      });
    }

    return found
      .map((heading, index) => {
        const nextStart = index + 1 < found.length ? found[index + 1].start : html.length;
        const body = this.htmlToText(html.slice(heading.end, nextStart));
        return {
          level: heading.level,
          text: heading.text,
          anchor: heading.anchor,
          content: body.slice(0, 4000),
          wordCount: body.split(/\s+/).filter(Boolean).length,
        };
      })
      // Headings with no prose under them are navigation chrome, not chapters.
      // The threshold is deliberately low: a genuine chapter can be a two-line
      // answer, while nav links and buttons carry essentially no body text.
      .filter(heading => heading.level <= 4 && heading.wordCount >= 10);
  }

  htmlToText(html) {
    return this.decodeEntities(
      String(html)
        .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<[^>]+>/g, ' ')
    )
      // Includes U+00A0: French typography is full of non-breaking spaces,
      // and leaving them in breaks later word-boundary matching.
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .trim();
  }

  decodeEntities(text) {
    const named = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
      eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç',
      ugrave: 'ù', ocirc: 'ô', icirc: 'î', euro: '€', laquo: '«', raquo: '»',
      rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', deg: '°',
    };
    return String(text)
      .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (match, entity) => named[entity.toLowerCase()] ?? match);
  }

  /**
   * Capture the page as the viewer would see it: one full-page shot plus one
   * framed shot per outline heading. These become the video's visuals, which is
   * the only way an instructional video can show the actual interface it talks
   * about.
   *
   * Screenshots are best-effort: a missing browser runtime degrades to "no
   * screenshots" rather than failing the whole generation.
   */
  async capturePageScreenshots(url, document, options = {}) {
    const maxShots = Math.max(0, Number(options.maxScreenshots ?? process.env.SOURCE_MAX_SCREENSHOTS ?? 8));
    if (maxShots === 0) return [];

    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (_error) {
      this.logger.warn('Playwright is not installed — skipping source screenshots');
      return [];
    }

    const outDir = path.join(this.cacheDir, this.slug(url), 'screenshots');
    await fs.mkdir(outDir, { recursive: true });

    let browser;
    try {
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (error) {
      this.logger.warn(`Could not launch a browser for screenshots: ${error.message}`);
      return [];
    }

    const shots = [];
    try {
      const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        locale: document.language === 'en' ? 'en-US' : 'fr-FR',
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: this.timeout });
      await this.dismissConsentBanners(page);

      const hero = path.join(outDir, 'page_top.png');
      await page.screenshot({ path: hero });
      shots.push({ path: hero, label: document.title || 'Page', headingIndex: null, kind: 'hero' });

      const headings = document.outline.slice(0, Math.max(0, maxShots - 1));
      for (const [index, heading] of headings.entries()) {
        const shotPath = path.join(outDir, `section_${String(index).padStart(2, '0')}.png`);
        const captured = await this.captureHeading(page, heading, shotPath);
        if (captured) {
          shots.push({ path: shotPath, label: heading.text, headingIndex: index, kind: 'section' });
        }
      }
    } catch (error) {
      this.logger.warn(`Screenshot capture stopped early: ${error.message}`);
    } finally {
      await browser.close().catch(() => {});
    }

    return shots;
  }

  /**
   * Scroll the heading into view and capture the region beneath it, so the shot
   * frames the step being narrated instead of an arbitrary part of the page.
   */
  async captureHeading(page, heading, shotPath) {
    try {
      const scrolled = await page.evaluate(headingText => {
        const nodes = Array.from(document.querySelectorAll('h1,h2,h3,h4'));
        const target = nodes.find(node => node.textContent.trim() === headingText);
        if (!target) return false;
        target.scrollIntoView({ block: 'start' });
        return true;
      }, heading.text);

      if (!scrolled) return false;
      // Let lazy-loaded imagery settle before the shot.
      await page.waitForTimeout(600);
      await page.screenshot({ path: shotPath });
      return true;
    } catch (error) {
      this.logger.warn(`Could not capture "${heading.text}": ${error.message}`);
      return false;
    }
  }

  async dismissConsentBanners(page) {
    // Cookie walls cover the content and would otherwise be the screenshot.
    const selectors = [
      '#didomi-notice-agree-button',
      'button#onetrust-accept-btn-handler',
      'button[aria-label*="Accepter" i]',
      'button:has-text("Tout accepter")',
      'button:has-text("J\'accepte")',
      'button:has-text("Accept all")',
    ];
    for (const selector of selectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 700 })) {
          await button.click({ timeout: 1500 });
          await page.waitForTimeout(400);
          return;
        }
      } catch (_error) {
        // Selector absent on this site; try the next one.
      }
    }
  }

  async persist(document) {
    try {
      const dir = path.join(this.cacheDir, this.slug(document.url));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'document.json'),
        JSON.stringify(document, null, 2),
        'utf8'
      );
    } catch (error) {
      this.logger.warn(`Could not cache source document: ${error.message}`);
    }
  }

  slug(url) {
    const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
    const readable = String(url)
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    return `${readable || 'source'}-${hash}`;
  }

  /**
   * Condensed form handed to AI prompts: the outline is the contract the script
   * must follow, so it is presented first and in full.
   */
  static toPromptContext(document, options = {}) {
    if (!document) return null;
    const maxContentChars = Number(options.maxContentChars || 900);
    const outline = (document.outline || []).map((heading, index) => ({
      order: index + 1,
      heading: heading.text,
      summary: (heading.content || '').slice(0, maxContentChars),
    }));

    return {
      url: document.url,
      title: document.title,
      language: document.language,
      outline,
    };
  }
}

module.exports = { SourceIngestionService };
