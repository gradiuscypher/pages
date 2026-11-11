const root = document.documentElement;
const themeButton = document.querySelector('.theme-toggle');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let preferredTheme;
try { preferredTheme = localStorage.getItem('pages-theme'); } catch { /* Storage is optional. */ }

function updateThemeButton() {
  if (!themeButton) return;
  const dark = root.dataset.theme === 'dark';
  themeButton.hidden = false;
  themeButton.textContent = dark ? 'Light theme' : 'Dark theme';
  themeButton.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
  themeButton.setAttribute('aria-pressed', String(dark));
}

function setTheme(theme) {
  root.dataset.theme = theme;
  updateThemeButton();
  renderDiagrams();
}

themeButton?.addEventListener('click', () => {
  preferredTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('pages-theme', preferredTheme); } catch { /* Keep the in-memory preference. */ }
  setTheme(preferredTheme);
});
systemTheme.addEventListener('change', (event) => {
  if (preferredTheme !== 'light' && preferredTheme !== 'dark') setTheme(event.matches ? 'dark' : 'light');
});
window.addEventListener('storage', (event) => {
  if (event.key !== 'pages-theme' && event.key !== null) return;
  preferredTheme = event.newValue;
  setTheme(preferredTheme === 'dark' || preferredTheme === 'light' ? preferredTheme : systemTheme.matches ? 'dark' : 'light');
});
updateThemeButton();

document.querySelectorAll('.print-button').forEach((button) => {
  button.hidden = false;
  button.addEventListener('click', () => window.print());
});

// Make horizontally scrolling code and tables reachable without a pointer.
document.querySelectorAll('.prose pre, .prose table, .mermaid-output').forEach((element) => {
  element.tabIndex = 0;
});

const diagrams = Array.from(document.querySelectorAll('.mermaid-block'), (figure) => {
  const source = figure.querySelector('.mermaid-source');
  const status = figure.querySelector('.mermaid-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  return { figure, source, status, output: figure.querySelector('.mermaid-output'), code: source.textContent, toggle: null };
});
let revision = 0;
let running = false;
let mermaidPromise;

async function renderDiagrams() {
  if (!diagrams.length) return;
  revision += 1;
  if (running) return;
  running = true;
  try {
    mermaidPromise ??= import('mermaid').then((module) => module.default);
    let mermaid;
    try {
      mermaid = await mermaidPromise;
    } catch {
      for (const diagram of diagrams) diagram.status.textContent = 'The diagram renderer could not load. The complete source is shown below.';
      return;
    }
    let renderedRevision;
    do {
      renderedRevision = revision;
      const dark = root.dataset.theme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        fontFamily: '"Berkeley Mono", "IBM Plex Mono", monospace',
        maxTextSize: 50000,
        maxEdges: 500,
        secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart', 'themeVariables'],
        themeVariables: dark
          ? { darkMode: true, background: '#111827', primaryColor: '#172749', primaryTextColor: '#edf1f8', primaryBorderColor: '#7ca1ff', lineColor: '#9aa4ba', secondaryColor: '#301a34', tertiaryColor: '#111827', fontFamily: '"Berkeley Mono", "IBM Plex Mono", monospace' }
          : { darkMode: false, background: '#eceff6', primaryColor: '#e1e9ff', primaryTextColor: '#101627', primaryBorderColor: '#2454cf', lineColor: '#596176', secondaryColor: '#f8e3ec', tertiaryColor: '#eceff6', fontFamily: '"Berkeley Mono", "IBM Plex Mono", monospace' },
      });
      for (let index = 0; index < diagrams.length; index += 1) {
        if (renderedRevision !== revision) break;
        const diagram = diagrams[index];
        diagram.status.textContent = 'Rendering diagram…';
        try {
          // Neither legacy init directives nor YAML frontmatter may supply
          // document-controlled Mermaid configuration, even on future upgrades.
          if (/%%\s*\{/.test(diagram.code) || /^\s*---(?:\s|$)/.test(diagram.code)) {
            throw new Error('Diagram configuration directives are not allowed. Remove the directive and use plain Mermaid syntax.');
          }
          const { svg } = await mermaid.render(`diagram-${renderedRevision}-${index}`, diagram.code);
          if (renderedRevision !== revision) break;
          diagram.output.innerHTML = svg;
          const svgElement = diagram.output.querySelector('svg');
          svgElement?.setAttribute('role', 'img');
          if (svgElement && !svgElement.hasAttribute('aria-label') && !svgElement.hasAttribute('aria-labelledby')) svgElement.setAttribute('aria-label', 'Document diagram; source is available below');
          diagram.source.hidden = true;
          diagram.status.textContent = 'Diagram rendered from Mermaid source.';
          if (!diagram.toggle) {
            diagram.toggle = document.createElement('button');
            diagram.toggle.type = 'button';
            diagram.toggle.className = 'diagram-toggle';
            diagram.toggle.addEventListener('click', () => {
              diagram.source.hidden = !diagram.source.hidden;
              diagram.toggle.textContent = diagram.source.hidden ? 'View diagram source' : 'Hide diagram source';
              diagram.toggle.setAttribute('aria-expanded', String(!diagram.source.hidden));
            });
            diagram.figure.insertBefore(diagram.toggle, diagram.source);
          }
          diagram.toggle.hidden = false;
          diagram.toggle.textContent = 'View diagram source';
          diagram.toggle.setAttribute('aria-expanded', 'false');
        } catch (error) {
          if (renderedRevision !== revision) break;
          diagram.output.replaceChildren();
          diagram.source.hidden = false;
          if (diagram.toggle) diagram.toggle.hidden = true;
          diagram.status.textContent = `Diagram unavailable. ${error instanceof Error && error.message.startsWith('Diagram configuration') ? error.message : 'Check the Mermaid syntax; the original source is preserved.'}`;
        }
      }
    } while (renderedRevision !== revision);
  } finally {
    running = false;
  }
}

renderDiagrams();
