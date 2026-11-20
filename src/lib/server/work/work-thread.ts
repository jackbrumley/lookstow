/**
 * The work thread's entry (docs/specs/SPEC-SCALE.md); a release bundles it as app/work.js.
 * Modules run in import order, so the version is set before the work thread's code loads.
 */
import './version-global.ts';
import './work-main.ts';
