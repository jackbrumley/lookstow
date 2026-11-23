<script lang="ts">
	import { resolve } from '$app/paths';
	import { page, updated } from '$app/state';
	import type { LayoutProps } from './$types';
	import '#lib/ui/tokens.css';
	import '#lib/ui/global.css';
	import IconLayoutDashboard from '@tabler/icons-svelte-runes/icons/layout-dashboard';
	import IconMailbox from '@tabler/icons-svelte-runes/icons/mailbox';
	import IconListDetails from '@tabler/icons-svelte-runes/icons/list-details';
	import IconSearch from '@tabler/icons-svelte-runes/icons/search';
	import IconBell from '@tabler/icons-svelte-runes/icons/bell';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconTerminal2 from '@tabler/icons-svelte-runes/icons/terminal-2';
	import IconCloudDownload from '@tabler/icons-svelte-runes/icons/cloud-download';
	import IconBook from '@tabler/icons-svelte-runes/icons/book';
	import IconPackageExport from '@tabler/icons-svelte-runes/icons/package-export';
	import ToastHost from '#lib/ui/toast-host.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import Button from '#lib/ui/button.svelte';
	import IconPlayerPause from '@tabler/icons-svelte-runes/icons/player-pause';
	import IconPlayerPlay from '@tabler/icons-svelte-runes/icons/player-play';
	import IconLogout from '@tabler/icons-svelte-runes/icons/logout';
	import { invalidate, refreshAll } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import { LIVE_STATUS, isBusy, phaseText, refreshAfterMs } from '#lib/domain/live-status.ts';
	import { toast } from '#lib/runes/toast.svelte.ts';
	import { pending } from '#lib/runes/pending.svelte.ts';
	import { formatPercent, setDisplayTimeZone } from '#lib/utils/format.ts';

	let { data, children }: LayoutProps = $props();

	// Before any page draws a time, so the server's page and the browser show the same zone (it
	// is the server's, so it never changes while the page is open).
	setDisplayTimeZone(untrack(() => data.timeZone));

	const allItems = [
		{ path: '/', href: resolve('/'), label: 'Dashboard', icon: IconLayoutDashboard },
		{ path: '/mailboxes', href: resolve('/mailboxes'), label: 'Mailboxes', icon: IconMailbox },
		{ path: '/search', href: resolve('/search'), label: 'Search', icon: IconSearch },
		{
			path: '/evidence-packs',
			href: resolve('/evidence-packs'),
			label: 'Evidence packs',
			icon: IconPackageExport
		},
		{ path: '/activity', href: resolve('/activity'), label: 'Activity', icon: IconListDetails },
		{ path: '/log', href: resolve('/log'), label: 'Log', icon: IconTerminal2 },
		{ path: '/alerts', href: resolve('/alerts'), label: 'Alerts', icon: IconBell },
		{ path: '/settings', href: resolve('/settings'), label: 'Settings', icon: IconSettings },
		{ path: '/updates', href: resolve('/updates'), label: 'Updates', icon: IconCloudDownload },
		{ path: '/how-it-works', href: resolve('/how-it-works'), label: 'How it works', icon: IconBook }
	];

	// A remote person (docs/specs/SPEC-REMOTE.md) sees only what they may open, and nothing
	// before they have signed in.
	const READ_ONLY = new Set(['/', '/mailboxes', '/search', '/how-it-works']);
	const remote = $derived(data.remote);
	const items = $derived(
		remote === null
			? allItems
			: remote.user === null
				? []
				: allItems.filter(
						(item) =>
							READ_ONLY.has(item.path) || (item.path === '/evidence-packs' && remote.mayExport)
					)
	);

	function active(path: string): boolean {
		return path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
	}

	const live = $derived(data.live);
	// A request just made shows at once; the live status takes over once it shows the work.
	$effect(() => {
		pending.settle(live.engine);
	});
	const pause = $derived(live.engine.pause);
	const disk = $derived(live.engine.disk);

	// Every page follows the engine through the one live status: every few seconds while work
	// runs, every 30 s otherwise (docs/specs/SPEC-STATUS.md).
	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		// Only refresh while the server answers. When it is stopped (an update, a restart),
		// SvelteKit reacts to a refresh it cannot load by reloading the whole page, which shows
		// the browser's "Unable to connect" page; the Updates page reloads by itself once the new
		// version answers.
		const serverUp = async (): Promise<boolean> => {
			try {
				return (await fetch('/healthz', { cache: 'no-store' })).ok;
			} catch {
				return false;
			}
		};
		const refresh = () => {
			timer = setTimeout(() => {
				void serverUp()
					.then(async (up) => {
						if (up) await invalidate(LIVE_STATUS);
					})
					.finally(refresh);
			}, refreshAfterMs(live));
		};
		refresh();
		return () => {
			clearTimeout(timer);
		};
	});

	// The update reminder (domain/releases/update-reminder.ts): front and centre on every page
	// until someone answers it. Update now goes to the Updates page; the other two answers are
	// kept on the server.
	const update = $derived(data.update);
	// Shown while the server says to remind; an answer hides it at once.
	let reminding = $derived(update?.remind === true);
	let answering = $state(false);

	async function answerReminder(answer: 'later' | 'skip'): Promise<void> {
		if (update === null) return;
		answering = true;
		try {
			const response = await fetch('/api/updates/reminder', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ answer, version: update.version })
			});
			if (!response.ok) {
				toast.error(`Lookstow answered ${String(response.status)}`);
				return;
			}
			reminding = false;
			await invalidate(LIVE_STATUS);
		} finally {
			answering = false;
		}
	}

	let switching = $state(false);

	/** Pause or Resume everything, from any page. */
	async function togglePause(): Promise<void> {
		switching = true;
		try {
			const response = await fetch('/control', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: pause.paused ? 'resume' : 'pause' })
			});
			const reply: unknown = await response.json().catch(() => null);
			const message =
				typeof reply === 'object' &&
				reply !== null &&
				'message' in reply &&
				typeof reply.message === 'string'
					? reply.message
					: `Lookstow answered ${response.status}`;
			if (response.ok) {
				toast.success(message);
			} else {
				toast.error(message);
			}
			await refreshAll();
		} finally {
			switching = false;
		}
	}
</script>

<div class="shell">
	<nav aria-label="Main">
		<div class="brand">
			<span class="brand-tile"><img src="/favicon.svg" alt="" width="28" height="28" /></span>
			<div>
				<strong>Lookstow</strong>
				<span>Mailbox backup</span>
			</div>
		</div>
		<ul>
			{#each items as item (item.path)}
				<li>
					<a href={item.href} class:active={active(item.path)}>
						<item.icon size={18} />
						{item.label}
						{#if item.path === '/updates' && update !== null}<span
								class="new"
								title={`Lookstow ${update.version} is available`}>New</span
							>{/if}
					</a>
				</li>
			{/each}
		</ul>
		{#if remote === null}
			<button
				type="button"
				class="control"
				class:resume={pause.paused}
				disabled={switching}
				onclick={() => void togglePause()}
			>
				{#if live.engine.backupMove.kind === 'moving'}
					<div class="banner" role="status">
						The backup is moving to {live.engine.backupMove.to}. Backups and changes wait until
						every file is copied and checked. Settings, Backup folder shows how far it is.
					</div>
				{/if}
				{#if pause.paused}<IconPlayerPlay size={18} /> Resume{:else}<IconPlayerPause size={18} /> Pause{/if}
			</button>
		{/if}
		<div class="footer">
			<div class="phase" class:busy={pending.current !== null || isBusy(live) || pause.paused}>
				{pending.current?.text ?? phaseText(live)}
			</div>
			<div class="version">Version {data.version}</div>
		</div>
		{#if remote?.user}
			<!-- Who is signed in, at the very bottom, where people look for it. -->
			<form method="POST" action={resolve('/signout')} class="signed-in">
				<span class="avatar" aria-hidden="true">{remote.user.slice(0, 1).toUpperCase()}</span>
				<span class="who">
					<span class="muted-label">Signed in as</span>
					<strong>{remote.user}</strong>
				</span>
				<button type="submit" class="sign-out" title="Sign out" aria-label="Sign out">
					<IconLogout size={18} />
				</button>
			</form>
		{/if}
	</nav>
	<main>
		{#if updated.current}
			<div class="banner" role="status">
				Lookstow has been updated.
				<button
					type="button"
					class="link"
					onclick={() => {
						location.reload();
					}}>Reload this page</button
				>
				to use the new version.
			</div>
		{/if}
		{#if pause.paused}
			<div class="banner" class:bad={pause.reason === 'disk'} role="status">
				{#if pause.reason === 'disk'}
					Backups are paused: the backup drive is {formatPercent(disk.usedPercent)} full (the limit is
					{disk.pausePercent}%). Free some space, then press Resume.
				{:else}
					Backups are paused. Nothing syncs until you press Resume.
				{/if}
			</div>
		{:else if disk.level === 'warn'}
			<div class="banner" role="status">
				The backup drive is {formatPercent(disk.usedPercent)} full. Backups pause at
				{disk.pausePercent}%.
			</div>
		{/if}
		{#if data.indexing !== null}
			<div class="banner" role="status">{data.indexing}</div>
		{/if}
		{#if live.engine.problem !== null}
			<div class="banner" role="status">
				{live.engine.problem}
				{#if remote === null}<a href={resolve('/settings')}>Settings</a>{/if}
			</div>
		{/if}
		{@render children()}
	</main>
</div>
<ToastHost />

{#if update !== null}
	<Modal open={reminding} title={`Lookstow ${update.version} is available`} locked>
		<p>
			You have {update.installed}. Updating takes about three minutes; backups pause meanwhile and
			carry on where they were.
		</p>
		{#if update.highlights.length > 0}
			<ul class="highlights">
				{#each update.highlights as line, index (index)}
					<li>{line}</li>
				{/each}
			</ul>
		{/if}
		{#snippet footer()}
			<Button variant="secondary" disabled={answering} onclick={() => void answerReminder('skip')}
				>Skip this version</Button
			>
			<Button variant="secondary" disabled={answering} onclick={() => void answerReminder('later')}
				>Remind me tomorrow</Button
			>
			<a class="update-now" href={resolve('/updates')} onclick={() => (reminding = false)}
				>Update now</a
			>
		{/snippet}
	</Modal>
{/if}

<style>
	.shell {
		display: grid;
		grid-template-columns: var(--sidebar-width) 1fr;
		min-height: 100vh;
	}

	nav {
		background: var(--colour-sidebar);
		color: var(--colour-sidebar-text);
		padding: var(--space-5) var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
		position: sticky;
		top: 0;
		height: 100vh;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
		line-height: var(--line-height-tight);
	}

	/* The icon's crate is the sidebar's own dark plum, so it sits on a light tile to stay visible. */
	.brand-tile {
		display: grid;
		place-items: center;
		padding: var(--space-1);
		background: var(--colour-icon-tile);
		border-radius: var(--radius-md);
	}

	.brand div {
		display: grid;
	}

	.brand strong {
		font-size: var(--font-size-lg);
	}

	.brand span,
	.footer {
		color: var(--colour-sidebar-muted);
		font-size: var(--font-size-sm);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-1);
	}

	nav a {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		color: var(--colour-sidebar-text);
		text-decoration: none;
	}

	nav a:hover,
	nav a.active {
		background: var(--colour-sidebar-active);
	}

	.footer {
		margin-top: auto;
		padding: 0 var(--space-3);
		display: grid;
		gap: var(--space-1);
	}

	.control {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		margin: 0 var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: 999px;
		border: 1px solid var(--colour-sidebar-muted);
		background: transparent;
		color: var(--colour-sidebar-text);
		font: inherit;
		font-weight: var(--font-weight-medium);
		cursor: pointer;
	}

	.control:hover {
		background: var(--colour-sidebar-active);
	}

	.control.resume {
		background: var(--colour-brand);
		border-color: var(--colour-brand);
		color: var(--colour-text-inverse);
	}

	.control:disabled {
		opacity: 0.6;
		cursor: progress;
	}

	.link {
		font: inherit;
		color: inherit;
		background: none;
		border: none;
		padding: 0;
		text-decoration: underline;
		cursor: pointer;
	}

	.banner.bad {
		background: var(--colour-bad-soft);
		color: var(--colour-bad-text);
	}

	.new {
		margin-left: auto;
		padding: 0 var(--space-2);
		border-radius: 999px;
		background: var(--colour-brand);
		color: var(--colour-text-inverse);
		font-size: var(--font-size-sm);
	}

	.signed-in {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background: var(--colour-sidebar-active);
	}

	.avatar {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: var(--colour-brand);
		color: var(--colour-text-inverse);
		font-weight: var(--font-weight-semibold);
	}

	.who {
		display: grid;
		min-width: 0;
		line-height: var(--line-height-tight);
	}

	.who strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.muted-label {
		color: var(--colour-sidebar-muted);
		font-size: var(--font-size-xs);
	}

	.sign-out {
		display: inline-flex;
		margin-left: auto;
		padding: var(--space-2);
		border: none;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--colour-sidebar-text);
		cursor: pointer;
	}

	.sign-out:hover {
		background: var(--colour-sidebar);
	}

	.highlights {
		margin: var(--space-3) 0 0;
		padding-left: var(--space-5);
		display: grid;
		gap: var(--space-1);
	}

	.update-now {
		display: inline-flex;
		align-items: center;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-md);
		background: var(--colour-brand);
		color: var(--colour-text-inverse);
		font-weight: var(--font-weight-medium);
		text-decoration: none;
	}

	.phase.busy {
		color: var(--colour-sidebar-text);
	}

	main {
		padding: var(--space-6) var(--space-8);
		display: grid;
		gap: var(--space-6);
		align-content: start;
		min-width: 0;
	}

	.banner {
		background: var(--colour-warn-soft);
		color: var(--colour-warn-text);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
	}

	@media (max-width: 900px) {
		.shell {
			grid-template-columns: 1fr;
		}

		nav {
			position: static;
			height: auto;
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
			padding: var(--space-3);
		}

		ul {
			display: flex;
			flex-wrap: wrap;
		}

		.footer {
			display: none;
		}

		main {
			padding: var(--space-4);
		}
	}
</style>
