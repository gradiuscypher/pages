import { randomUUID } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import hljs from 'highlight.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderMarkdown(source) {
  // Only renderer-generated classes and IDs survive sanitization. The per-render
  // capability prevents author HTML from impersonating document controls.
  const capability = `r${randomUUID().replaceAll('-', '')}-`;
  const trustedClasses = (html) => html.replace(/class="([^"]*)"/g, (_, names) => `class="${names.split(/\s+/).map((name) => capability + name).join(' ')}"`);
  const headings = [];
  const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  for (const tag of ['th_open', 'td_open']) {
    markdown.renderer.rules[tag] = (tokens, index, options, environment, renderer) => {
      const token = tokens[index];
      const alignment = token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1];
      if (alignment) token.attrSet('align', alignment);
      return renderer.renderToken(tokens, index, options);
    };
  }
  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (language === 'mermaid') {
      return trustedClasses(`<figure class="mermaid-block"><figcaption>Diagram</figcaption><div class="mermaid-output"></div><pre class="mermaid-source"><code>${escape(token.content)}</code></pre><p class="mermaid-status">Diagram source · JavaScript enables the rendered view.</p></figure>`);
    }
    const code = language && hljs.getLanguage(language)
      ? hljs.highlight(token.content, { language, ignoreIllegals: true }).value
      : escape(token.content);
    return trustedClasses(`<pre class="code-block"><code class="hljs">${code}</code></pre>\n`);
  };
  markdown.renderer.rules.heading_open = (tokens, index) => {
    const token = tokens[index];
    const inline = tokens[index + 1];
    const text = (inline.children ?? []).map((child) => child.type === 'image' ? child.content : child.type === 'text' || child.type === 'code_inline' ? child.content : child.type === 'softbreak' ? ' ' : '').join('');
    const id = `doc-section-${headings.length + 1}`;
    headings.push({ id, text: text || 'Section', level: Number(token.tag.slice(1)) });
    return `<${token.tag} id="${capability}${id}">`;
  };
  const html = sanitizeHtml(markdown.render(String(source ?? '')), {
    allowedTags: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'em', 'strong', 's', 'del', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'sup', 'sub', 'kbd', 'details', 'summary', 'div', 'span', 'figure', 'figcaption'],
    allowedAttributes: { '*': ['class', 'id'], a: ['href', 'title', 'rel'], img: ['src', 'alt', 'title', 'width', 'height', 'loading'], ol: ['start'], th: ['align'], td: ['align'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowProtocolRelative: false,
    transformTags: {
      '*': (tagName, attributes) => {
        const attribs = { ...attributes };
        if (attribs.class) {
          attribs.class = attribs.class.split(/\s+/).filter((name) => name.startsWith(capability)).map((name) => name.slice(capability.length)).join(' ');
          if (!attribs.class) delete attribs.class;
        }
        if (attribs.id?.startsWith(`${capability}doc-section-`)) attribs.id = attribs.id.slice(capability.length);
        else delete attribs.id;
        if (tagName === 'a') attribs.rel = 'noopener noreferrer';
        if (tagName === 'img') {
          attribs.loading = 'lazy';
          // Data images are restricted to raster formats, never SVG documents.
          if (attribs.src?.startsWith('data:') && !/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(attribs.src)) delete attribs.src;
        }
        return { tagName, attribs };
      },
    },
  });
  return { html, headings };
}

function shell({ title, description = '', body, kind = 'document' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)} · Pages</title>
<meta name="description" content="${escape(description)}">
<script src="/static/theme.js"></script>
<link rel="stylesheet" href="/static/style.css">
<script type="module" src="/static/client.js"></script>
</head>
<body class="${kind}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><a class="wordmark" href="/" aria-label="Pages home"><span class="brand-mark" aria-hidden="true">p.</span>pages<span class="brand-note">/ a place for the details</span></a><div class="header-actions"><button type="button" class="theme-toggle" aria-label="Switch color theme" aria-pressed="false" hidden>Dark theme</button></div></header>
${body}
<footer class="site-footer"><span>Small documents. Durable links.</span><a href="https://grds.io/" rel="noopener noreferrer">GRDS-inspired / built to read</a></footer>
</body>
</html>`;
}

function tableOfContents(headings) {
  if (!headings.length) return '';
  return `<nav class="toc" aria-label="On this page"><p class="eyebrow">On this page</p><ol>${headings.map(({ id, text, level }) => `<li class="toc-level-${level}"><a href="#${id}">${escape(text)}</a></li>`).join('')}</ol></nav>`;
}

function timestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `<time datetime="${escape(date.toISOString())}">${escape(date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }))}</time>`;
}

function assetPath(asset, download = false) {
  const path = `/assets/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.name)}`;
  return download ? `${path}?download=1` : path;
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachments(assets = []) {
  if (!assets.length) return '';
  return `<section class="attachments" aria-labelledby="attachments-heading"><div class="section-label"><h2 id="attachments-heading">Attachments</h2><span>${assets.length} file${assets.length === 1 ? '' : 's'}</span></div><ul class="asset-list">${assets.map((asset) => `<li><a class="asset-link" href="${assetPath(asset, true)}" download><span class="file-icon" aria-hidden="true">↓</span><span class="asset-name">${escape(asset.name)}<span class="asset-meta">${escape(asset.mime)} · ${escape(fileSize(asset.size))}</span></span><span class="asset-download">Download <span aria-hidden="true">↗</span></span></a></li>`).join('')}</ul></section>`;
}

export function renderPage(page) {
  const { html, headings } = renderMarkdown(page.markdown);
  const source = `/p/${encodeURIComponent(page.id)}/source.md`;
  return shell({
    title: page.title,
    description: page.description,
    body: `<main id="main" class="document-layout"><article class="document-body"><header class="document-header"><p class="eyebrow">Published document</p><h1 class="document-title">${escape(page.title)}</h1>${page.description ? `<p class="document-description">${escape(page.description)}</p>` : ''}<div class="document-meta"><span>Published ${timestamp(page.createdAt)}</span>${page.updatedAt !== page.createdAt ? `<span>Updated ${timestamp(page.updatedAt)}</span>` : ''}</div><div class="document-actions"><a class="text-action" href="${source}" download>Download Markdown <span aria-hidden="true">↓</span></a><button class="text-action print-button" type="button" hidden>Print document <span aria-hidden="true">↗</span></button></div></header><div class="prose">${html}</div>${attachments(page.assets)}</article>${tableOfContents(headings)}</main>`,
  });
}

const showcase = `## An idea, made readable

Pages turns a Markdown file into a focused, shareable document. Send the link. Keep the context. No account needed to read.

> Good documentation is a small act of hospitality: give the next person everything they need, and nothing they don't.

### From source to shared understanding

\`\`\`mermaid
flowchart LR
  A[Write Markdown] --> B[Publish with the API]
  B --> C[Share one link]
  C --> D[Read anywhere]
\`\`\`

### A little structure goes a long way

| Bring your… | Get a readable… |
| :--- | :--- |
| Design notes | Decision record, with the reasoning intact |
| Code snippets | Syntax-highlighted technical guide |
| Diagrams & images | Visual explanation beside the details |
| Files & exports | Downloadable reference material |

### Code that keeps its shape

\`\`\`javascript
const response = await fetch('http://localhost:3000/api/pages', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.PAGES_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    title: 'Notes worth keeping',
    markdown: '# The details\\n\\nStart here.',
  }),
});

const { url } = await response.json();
console.log(url); // Your public reading link
\`\`\`

### The useful details, included

- **Markdown first.** Headings, links, tables, lists, and fenced code.
- **Diagrams stay close.** Mermaid renders right inside the document.
- **Yours to keep.** Download the source, save attachments, or print.
- **Comfortable by default.** Light and dark themes, on any screen.

This is an illustrative preview, not a stored document. Published pages are available only through their individual links.
`;

export function renderHome() {
  const { html, headings } = renderMarkdown(showcase);
  return shell({
    title: 'A place for the details',
    description: 'Publish Markdown, share a link, and let the details speak for themselves.',
    kind: 'home',
    body: `<main id="main"><section class="hero"><p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> Write once. Share clearly.</p><h1>A place for<br>the <em>details.</em></h1><p class="hero-description">Notes, guides, and ideas deserve more than a message thread. Publish Markdown as a clean, lasting page.</p><div class="hero-actions"><a class="primary-action" href="#preview">Explore a page <span aria-hidden="true">↓</span></a><a class="text-action" href="#publishing">How to publish <span aria-hidden="true">↗</span></a></div><div class="hero-index" aria-hidden="true"><span>01 / WORDS</span><span>02 / CODE</span><span>03 / DIAGRAMS</span></div></section><section id="publishing" class="publishing-intro"><p class="eyebrow">A small, deliberate workflow</p><div><h2>Your tools write it.<br>A link delivers it.</h2><p>Publish with <code>POST /api/pages</code> using your server's Bearer key. Include a title and Markdown; attach files when you need them. The response gives you the public reading URL.</p><p>Reading is public to anyone with the link. Publishing stays authenticated. There is no public document directory.</p></div></section><section id="preview" class="preview-shell" aria-labelledby="preview-heading"><div class="preview-banner"><span id="preview-heading">The reading experience</span><span>Illustrative preview · not a published page</span></div><div class="document-layout"><article class="document-body"><header class="document-header"><p class="eyebrow">A field guide / 001</p><h2 class="document-title">Less friction.<br>More understanding.</h2><p class="document-description">A quick look at what belongs on a page.</p><div class="document-meta"><span>Markdown → a document worth sharing</span></div></header><div class="prose">${html}</div></article>${tableOfContents(headings)}</div></section></main>`,
  });
}

export function renderError(status, message) {
  return shell({ title: `${status} · ${message}`, body: `<main id="main" class="error-page"><p class="eyebrow">${escape(status)} / Nothing here to read</p><h1>${escape(message)}</h1><p>The link may be incomplete, or this document may no longer be available.</p><a class="primary-action" href="/">Back to Pages <span aria-hidden="true">↗</span></a></main>` });
}
