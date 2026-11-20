/**
 * The AI tools' thread entry (docs/specs/SPEC-SCALE.md); a release bundles it as app/ai.js.
 * Modules run in import order, so the version is set before the thread's code loads.
 */
import './version-global.ts';
import './ai-main.ts';
