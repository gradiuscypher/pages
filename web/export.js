function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function publicFile(url) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('File unavailable');
  return response.blob();
}

async function embedImage(url) {
  if (url.origin === location.origin) {
    const blob = await publicFile(url);
    if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(blob.type)) throw new Error('Not a raster image');
    return dataUrl(blob);
  }
  // Remote image hosts must allow anonymous canvas reads. Never proxy their URLs on the server.
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url.href;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas.toDataURL('image/png');
}

async function exportPage() {
  const main = document.querySelector('main').cloneNode(true);
  main.querySelectorAll('.document-actions, .export-status, .diagram-toggle, .mermaid-status').forEach(el => el.remove());
  for (const figure of main.querySelectorAll('.mermaid-block')) {
    const source = figure.querySelector('.mermaid-source');
    source.hidden = false;
    if (!figure.querySelector('svg')) continue;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Diagram source';
    source.replaceWith(details);
    details.append(summary, source);
  }
  main.querySelector('[aria-current]')?.removeAttribute('aria-current');

  const assets = new Map();
  for (const link of main.querySelectorAll('.asset-link')) {
    const url = new URL(link.getAttribute('href'), location.href);
    const name = decodeURIComponent(url.pathname.split('/').pop());
    try {
      const bytes = await dataUrl(await publicFile(url));
      link.href = bytes;
      link.download = name;
      assets.set(url.pathname, { bytes, name });
    } catch { throw new Error(`Could not include attachment: ${name}. No file was saved.`); }
  }
  let unavailable = 0;
  for (const img of main.querySelectorAll('img[src]')) {
    const url = new URL(img.getAttribute('src'), location.href);
    if (url.protocol === 'data:') continue;
    const asset = url.origin === location.origin && assets.get(url.pathname);
    try {
      img.src = asset && asset.bytes.startsWith('data:image/') ? asset.bytes : await embedImage(url);
    } catch {
      const link = document.createElement('a');
      link.href = url.href;
      link.textContent = `${img.alt || 'Image'} (view online)`;
      img.replaceWith(link);
      unavailable++;
    }
  }
  for (const link of main.querySelectorAll('a[href]:not([download])')) {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) continue;
    const url = new URL(href, location.href);
    const asset = url.origin === location.origin && assets.get(url.pathname);
    link.href = asset ? asset.bytes : url.href;
    if (asset) link.download = asset.name;
  }

  const doc = document.implementation.createHTMLDocument(document.title);
  doc.documentElement.lang = document.documentElement.lang;
  Object.assign(doc.documentElement.dataset, document.documentElement.dataset);
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  doc.head.prepend(document.querySelector('meta[charset]').cloneNode(), policy);
  const style = doc.createElement('style');
  // Use the stylesheet's system font fallback rather than depend on hosted fonts.
  const sheet = document.querySelector('link[rel="stylesheet"]').sheet;
  style.textContent = Array.from(sheet.cssRules).filter(rule => rule.type !== CSSRule.FONT_FACE_RULE).map(rule => rule.cssText).join('\n');
  doc.head.append(document.querySelector('meta[name="viewport"]').cloneNode(), style);
  doc.body.className = document.body.className;
  doc.body.append(main);
  const url = URL.createObjectURL(new Blob(['<!doctype html>\n', doc.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }));
  const download = document.createElement('a');
  download.href = url;
  download.download = `${location.pathname.split('/').filter(Boolean).pop()}.html`;
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return unavailable;
}

export function enableExport() {
  const button = document.querySelector('.export-button');
  if (!button) return;
  const status = document.querySelector('.export-status');
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.hidden = false;
    status.textContent = 'Preparing HTML…';
    try {
      const missing = await exportPage();
      status.textContent = missing ? `HTML exported. Images unavailable offline: ${missing}. Online links included instead.` : 'HTML exported.';
    } catch (error) {
      status.textContent = error.message || 'Export failed. Please try again.';
    } finally { button.disabled = false; }
  });
}
