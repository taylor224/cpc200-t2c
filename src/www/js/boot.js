/* Runs before first paint (loaded synchronously from <head>).
 * - Derives the root font size from devicePixelRatio so the UI keeps the same
 *   physical size on Tesla firmware before and after the 2026.26 density change
 *   (DPR 1.0 -> 1.53, CSS viewport 1920x1200 -> 1254x784).
 * - Applies the stored dark theme early to avoid a white flash at night.
 * Kept out of index.in because the adapter's template engine treats every "|"
 * character in that file as a translation token.
 */
(function () {
  var dpr = window.devicePixelRatio || 1;
  var px = Math.max(13, Math.min(30, 24 / dpr));
  document.documentElement.style.fontSize = px.toFixed(2) + 'px';
  try {
    var th = JSON.parse(localStorage.getItem('t2c.theme') || '"auto"');
    if (th === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) { /* ignore */ }
})();
