# AIX K-line display optimization

The old chart fitted all history into the viewport. In the browser regression, 500 minute candles were spaced 1.248px apart on desktop and 0.576px on mobile; two daily candles were spaced 312px / 144px apart.

The default spacing is now 12px for 1m/5m/15m, 11px for 1h, 10px for 4h, and 9px for 1d. All fetched history remains available by panning. Sparse daily history leaves space instead of stretching candles. Resizing preserves pixel spacing; new live candles preserve historical pan/zoom or follow the latest bar when already at the right edge. Period and chart generation checks discard obsolete requests. An empty period clears old data.

Validation: 14 real Lightweight Charts browser scenarios passed across desktop/mobile; the existing page-loading and mobile-wallet-startup suites passed; JavaScript syntax checks passed. Before/after screenshots and browser measurements are stored here. Production deployment and public validation are recorded below.


Deployment: aix-chart-20261011-024625, completed at 2026-10-11T02:46:26.268620+00:00. Three frontend files updated; the other 244 protected files and the running service remained unchanged. No database was accessed. Backup: /opt/wg-platform/backups/aix-chart-20261011-024625. Public hashes and guest health passed (4 paths). Online browser verification passed for all 6 periods on desktop and mobile, including shared service-worker caching between visits; no runtime errors or write requests occurred.
