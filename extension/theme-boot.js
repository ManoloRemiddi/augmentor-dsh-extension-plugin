/* Pre-paint theme restore, runs synchronously before first paint.
 *
 * This must be a file: MV3's default extension-page CSP (script-src 'self',
 * not extendable in MV3) refuses inline <script> in extension pages. The
 * header toggle persists "light"; dark is the default (the GUI's dark
 * palette), so no stored value means no attribute.
 */
try {
  if (localStorage.getItem('augmentor-theme') === 'light')
    document.documentElement.dataset.theme = 'light'
} catch (e) {
  /* storage unavailable: fall through to the default dark palette */
}
