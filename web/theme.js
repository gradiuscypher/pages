(() => {
  let preference;
  try { preference = localStorage.getItem('pages-theme'); } catch { /* Storage is optional. */ }
  const theme = preference === 'light' || preference === 'dark'
    ? preference
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
})();
