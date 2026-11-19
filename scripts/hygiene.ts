// Structural checks that the compiler and the linter cannot express: file size,
// naming, file placement, layer boundaries, the backup's delete and move paths,
// where Microsoft's hosts are named, and forbidden patterns. Each rule is in AGENTS.md.
//
//   npm run hygiene
//
// A violation fails the run; a warning is printed and does not.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, posix } from 'node:path';
import process from 'node:process';

type Finding = { rule: string; path: string; details: string };

const violations: Finding[] = [];
const warnings: Finding[] = [];

function violation(rule: string, path: string, details: string): void {
	violations.push({ rule, path, details });
}

function warning(rule: string, path: string, details: string): void {
	warnings.push({ rule, path, details });
}

const SOFT_LINES = 600;
const HARD_LINES = 1000;

/** Code we write: TypeScript, JavaScript and Svelte. Rust is checked separately. */
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.svelte']);
const MIGRATIONS = 'src/lib/server/database/migrations/';
const THIS_FILE = 'scripts/hygiene.ts';

/**
 * The only server files that delete, move or copy files on disk, with the reason.
 * A new one needs the maintainer's approval (AGENTS.md section 11).
 */
const FILE_CHANGE_ALLOWED = new Map<string, string>([
	[
		'src/lib/server/services/storage/eml-store.ts',
		'atomic write: a temporary file renamed into place, removed if the write fails'
	],
	[
		'src/lib/server/services/storage/relayout.ts',
		'the one-time move into the date layout (docs/decisions.md)'
	],
	[
		'src/lib/server/services/mailboxes/delete-backup.ts',
		'deleting a backup after the typed confirmation'
	],
	[
		'src/lib/server/services/storage/index-snapshot.ts',
		'the daily index copy: written through a .partial file, only the 7 newest lookstow-*.db kept in .lookstow-index'
	],
	[
		'src/lib/server/services/throughput/monitor.ts',
		'deleting its own pace history files (<data>/throughput/*.jsonl) older than 7 days; never backup files'
	],
	[
		'src/lib/server/services/server-updates/readiness.ts',
		'atomic write of the readiness file in the data folder'
	],
	[
		'src/lib/server/services/server-updates/service.ts',
		"atomic write of the updater's request and status files"
	]
]);
const FILE_CHANGE_CALL =
	/\b(?:rm|rmdir|unlink|rename|cp|copyFile)(?:Sync)?\s*\(|\bfs\.(?:rm|rmdir|unlink|rename|cp|copyFile)/;

/** Folders under src/lib that run in the browser, or are shared with it. */
const BROWSER_LIB = /^src\/lib\/(?:ui|runes|utils|domain|schemas)\//;
/** Route files that run in the browser. */
const BROWSER_ROUTE = /^src\/routes\/(?:.*\/)?(?:[^/]+\.svelte|\+page\.ts|\+layout\.ts)$/;

const IMPORT_SPECIFIER =
	/^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every file git tracks or would track (new files included, ignored files left out). */
function repositoryFiles(): string[] {
	const output = execFileSync(
		'git',
		['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	return [...new Set(output.split('\0'))].filter((path) => path !== '' && existsSync(path));
}

function lineOf(content: string, index: number): number {
	return content.slice(0, index).split('\n').length;
}

/** Each line that matches, with its number. */
function matchingLines(content: string, pattern: RegExp): { line: number; text: string }[] {
	return content
		.split('\n')
		.map((text, index) => ({ line: index + 1, text: text.trim() }))
		.filter(({ text }) => pattern.test(text));
}

/** The repository path an import points at, or null for a package. */
function importTarget(importer: string, specifier: string): string | null {
	if (specifier.startsWith('#lib/')) {
		return `src/lib/${specifier.slice('#lib/'.length)}`;
	}
	if (specifier.startsWith('.')) {
		return posix.normalize(posix.join(posix.dirname(importer), specifier));
	}
	return null;
}

function importsOf(content: string): string[] {
	return [...content.matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? '');
}

/** Folders and files are kebab-case; SvelteKit's own names and route parameters keep theirs. */
function checkNaming(path: string): void {
	if (!/^(?:src|scripts|tests)\//.test(path) || path.startsWith(MIGRATIONS)) {
		return;
	}
	for (const segment of path.split('/')) {
		if (segment.startsWith('+') || /^\[{1,2}(?:\.\.\.)?[a-zA-Z]+\]{1,2}$/.test(segment)) {
			continue;
		}
		if (/^\([a-z0-9-]+\)$/.test(segment)) {
			continue;
		}
		const stem = segment.replace(/(?:\.(?:test|svelte|server|d))?\.[a-z]+$/, '');
		if (!KEBAB.test(stem)) {
			violation('naming', path, `"${segment}" is not kebab-case`);
			return;
		}
	}
	if (path.endsWith('.spec.ts')) {
		violation('naming', path, 'Tests are named *.test.ts');
	}
}

function checkPlacement(path: string): void {
	if (path.endsWith('.svelte') && !/^src\/(?:lib\/ui|routes)\//.test(path)) {
		violation('component-placement', path, 'Components live in src/lib/ui/ or beside their route');
	}
	if (
		path.endsWith('.css') &&
		path !== 'src/lib/ui/global.css' &&
		path !== 'src/lib/ui/tokens.css'
	) {
		violation(
			'css-placement',
			path,
			'Global CSS lives only in src/lib/ui/global.css and tokens.css'
		);
	}
}

function checkSize(path: string, content: string): void {
	const lines = content.split('\n').length;
	if (lines > HARD_LINES) {
		violation(
			'file-size',
			path,
			`${lines} lines (hard limit ${HARD_LINES}); split it by responsibility`
		);
	} else if (lines > SOFT_LINES) {
		warning('file-size', path, `${lines} lines (plan a split at ${SOFT_LINES})`);
	}
}

/** Rules for every TypeScript, JavaScript and Svelte file we write. */
function checkCode(path: string, content: string): void {
	checkSize(path, content);

	for (const { line } of matchingLines(
		content,
		/(?:\/\/|\/\*|<!--)\s*(?:@ts-(?:ignore|expect-error|nocheck)|eslint-(?:disable|enable)|svelte-ignore)/
	)) {
		violation('bypass-comment', path, `Line ${line} silences a check; fix the code instead`);
	}
	for (const { line } of matchingLines(content, /\b(?:TODO|FIXME|XXX|HACK)\b(?!\.md)/)) {
		violation('todo-marker', path, `Line ${line} has a marker; plans go in docs/TODO.md`);
	}
	for (const { line } of matchingLines(content, /\p{Extended_Pictographic}/u)) {
		violation('emoji', path, `Line ${line} has an emoji; icons come from Tabler`);
	}
	for (const { line } of matchingLines(
		content,
		/\bprocess\.env(?:\.\w+|\[[^\]]*\])\s*(?:\?\?|\|\|)/
	)) {
		violation(
			'env-fallback',
			path,
			`Line ${line} gives an environment variable a default; require it and fail when it is missing`
		);
	}

	if (!path.startsWith('src/')) {
		return;
	}
	const isTest = path.endsWith('.test.ts');

	if (path !== 'src/lib/server/env.ts' && /\bprocess\.env\b/.test(content)) {
		violation('env-read', path, 'Only src/lib/server/env.ts reads process.env');
	}
	if (/\bimport\(\s*['"`]\.\.?\//.test(content)) {
		violation('dynamic-import', path, 'Use a static import, not a relative dynamic import');
	}
	if (/!important\b/.test(content)) {
		violation('important', path, 'No !important; fix the cascade');
	}

	const imports = importsOf(content);
	if (path.startsWith('src/lib/server/') && !isTest) {
		for (const specifier of imports.filter((spec) => /^\$(?:app|env)\//.test(spec))) {
			violation(
				'server-boundary',
				path,
				`Imports ${specifier}; server code runs outside SvelteKit too (scripts, tests)`
			);
		}
	}
	if (BROWSER_LIB.test(path) || BROWSER_ROUTE.test(path)) {
		for (const specifier of imports) {
			if (importTarget(path, specifier)?.startsWith('src/lib/server/') === true) {
				violation(
					'browser-boundary',
					path,
					`Imports ${specifier}; browser code never imports server code, not even a type`
				);
			}
		}
	}
	if (path.startsWith('src/routes/')) {
		const direct = imports.filter((spec) =>
			/^(?:drizzle-orm|better-sqlite3|node:fs|node:fs\/promises|#lib\/server\/database\/schema)/.test(
				spec
			)
		);
		for (const specifier of direct) {
			violation(
				'thin-route',
				path,
				`Imports ${specifier}; routes call a service, never the database or the disk`
			);
		}
	}
	if (path.startsWith('src/lib/server/') && !isTest && !FILE_CHANGE_ALLOWED.has(path)) {
		for (const { line } of matchingLines(content, FILE_CHANGE_CALL)) {
			violation(
				'file-change',
				path,
				`Line ${line} deletes, moves or copies a file; only the files in FILE_CHANGE_ALLOWED may (AGENTS.md section 11)`
			);
		}
	}
	if (!isTest && !path.startsWith('src/lib/server/services/graph/')) {
		for (const { line } of matchingLines(
			content,
			/graph\.microsoft\.com|login\.microsoftonline\.com/
		)) {
			violation(
				'microsoft-host',
				path,
				`Line ${line} names a Microsoft host; only services/graph/ talks to Microsoft`
			);
		}
	}
	if (isTest) {
		for (const { line } of matchingLines(content, /\b(?:it|describe|test)\.(?:only|skip|todo)\(/)) {
			violation('test-focus', path, `Line ${line} skips or focuses tests; every test runs`);
		}
	}
	if (path.endsWith('.svelte')) {
		checkStyleColours(path, content);
	}
}

/** Colours in a component come from tokens.css. */
function checkStyleColours(path: string, content: string): void {
	const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(content);
	if (style === null) {
		return;
	}
	const body = style[1] ?? '';
	const firstLine = lineOf(content, style.index);
	for (const { line, text } of matchingLines(body, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)) {
		violation(
			'colour-literal',
			path,
			`Line ${firstLine + line - 1} ("${text}") sets a colour; use a token from tokens.css`
		);
	}
}

/** Rules for the launcher's Rust. */
function checkRust(path: string, content: string): void {
	checkSize(path, content);
	for (const { line } of matchingLines(content, /#!?\[allow\(/)) {
		violation('bypass-comment', path, `Line ${line} silences a lint; fix the code instead`);
	}
	for (const { line } of matchingLines(content, /\b(?:TODO|FIXME|XXX|HACK)\b(?!\.md)/)) {
		violation('todo-marker', path, `Line ${line} has a marker; plans go in docs/TODO.md`);
	}
}

function checkClaudeFile(): void {
	const claude = readFileSync('CLAUDE.md', 'utf8').trim();
	if (claude !== '@AGENTS.md') {
		violation(
			'claude-md',
			'CLAUDE.md',
			'CLAUDE.md holds only "@AGENTS.md", so every agent reads one file'
		);
	}
}

function run(): void {
	for (const path of repositoryFiles()) {
		checkNaming(path);
		checkPlacement(path);
		if (path === THIS_FILE || path.startsWith(MIGRATIONS)) {
			continue;
		}
		const extension = extname(path);
		const isOurCode = /^(?:src|scripts|tests)\//.test(path) || dirname(path) === '.';
		if (isOurCode && CODE_EXTENSIONS.has(extension)) {
			checkCode(path, readFileSync(join(process.cwd(), path), 'utf8'));
		} else if (path.startsWith('launcher/') && extension === '.rs') {
			checkRust(path, readFileSync(path, 'utf8'));
		}
	}
	checkClaudeFile();

	for (const found of warnings) {
		console.warn(`warning [${found.rule}] ${found.path}: ${found.details}`);
	}
	if (violations.length === 0) {
		console.log(`Hygiene passed (${warnings.length} warning(s)).`);
		return;
	}
	for (const found of violations) {
		console.error(`[${found.rule}] ${found.path}: ${found.details}`);
	}
	console.error(`Hygiene failed: ${violations.length} problem(s).`);
	process.exit(1);
}

run();
