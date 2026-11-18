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
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconTerminal2 from '@tabler/icons-svelte-runes/icons/terminal-2';
	import IconCloudDownload from '@tabler/icons-svelte-runes/icons/cloud-download';
	import ToastHost from '#lib/ui/toast-host.svelte';
	import IconPlayerPause from '@tabler/icons-svelte-runes/icons/player-pause';
	import IconPlayerPlay from '@tabler/icons-svelte-runes/icons/player-play';
	import { refreshAll } from '$app/navigation';
	import { toast } from '#lib/runes/toast.svelte.ts';
	import { formatPercent } from '#lib/utils/format.ts';

	let { data, children }: LayoutProps = $props();

	const items = [
		{ path: '/', href: resolve('/'), label: 'Dashboard', icon: IconLayoutDashboard },
		{ path: '/mailboxes', href: resolve('/mailboxes'), label: 'Mailboxes', icon: IconMailbox },
		{ path: '/search', href: resolve('/search'), label: 'Search', icon: IconSearch },
		{ path: '/activity', href: resolve('/activity'), label: 'Activity', icon: IconListDetails },
		{ path: '/log', href: resolve('/log'), label: 'Log', icon: IconTerminal2 },
		{ path: '/settings', href: resolve('/settings'), label: 'Settings', icon: IconSettings },
		{ path: '/updates', href: resolve('/updates'), label: 'Updates', icon: IconCloudDownload }
	];

	function active(path: string): boolean {
		return path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
	}

	const phaseText = $derived(
		data.pause.paused
			? 'Paused'
			: data.discovering
				? 'Finding mailboxes'
				: data.syncingCount > 0
					? `Backing up ${data.syncingCount} mailbox${data.syncingCount === 1 ? '' : 'es'}`
					: 'Idle'
	);

	let switching = $state(false);

	/** Pause or Resume everything, from any page. */
	async function togglePause(): Promise<void> {
		switching = true;
		try {
			const response = await fetch('/control', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: data.pause.paused ? 'resume' : 'pause' })
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
					</a>
				</li>
			{/each}
		</ul>
		<button
			type="button"
			class="control"
			class:resume={data.pause.paused}
			disabled={switching}
			onclick={() => void togglePause()}
		>
			{#if data.pause.paused}<IconPlayerPlay size={18} /> Resume{:else}<IconPlayerPause size={18} /> Pause{/if}
		</button>
		<div class="footer">
			<div class="phase" class:busy={data.busy || data.pause.paused}>{phaseText}</div>
			<div class="version">Version {data.version}</div>
		</div>
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
		{#if data.pause.paused}
			<div class="banner" class:bad={data.pause.reason === 'disk'} role="status">
				{#if data.pause.reason === 'disk'}
					Backups are paused: the backup drive is {formatPercent(data.disk.usedPercent)} full (the limit
					is {data.disk.pausePercent}%). Free some space, then press Resume.
				{:else}
					Backups are paused. Nothing syncs until you press Resume.
				{/if}
			</div>
		{:else if data.disk.level === 'warn'}
			<div class="banner" role="status">
				The backup drive is {formatPercent(data.disk.usedPercent)} full. Backups pause at
				{data.disk.pausePercent}%.
			</div>
		{/if}
		{#if data.engineProblem !== null}
			<div class="banner" role="status">
				{data.engineProblem}
				<a href={resolve('/settings')}>Settings</a>
			</div>
		{/if}
		{@render children()}
	</main>
</div>
<ToastHost />

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
