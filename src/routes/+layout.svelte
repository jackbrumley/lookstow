<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';
	import '#lib/ui/tokens.css';
	import '#lib/ui/global.css';
	import IconLayoutDashboard from '@tabler/icons-svelte-runes/icons/layout-dashboard';
	import IconMailbox from '@tabler/icons-svelte-runes/icons/mailbox';
	import IconListDetails from '@tabler/icons-svelte-runes/icons/list-details';
	import IconSettings from '@tabler/icons-svelte-runes/icons/settings';
	import IconCloudDownload from '@tabler/icons-svelte-runes/icons/cloud-download';
	import ToastHost from '#lib/ui/toast-host.svelte';

	let { data, children }: LayoutProps = $props();

	const items = [
		{ path: '/', href: resolve('/'), label: 'Dashboard', icon: IconLayoutDashboard },
		{ path: '/mailboxes', href: resolve('/mailboxes'), label: 'Mailboxes', icon: IconMailbox },
		{ path: '/activity', href: resolve('/activity'), label: 'Activity', icon: IconListDetails },
		{ path: '/settings', href: resolve('/settings'), label: 'Settings', icon: IconSettings },
		{ path: '/updates', href: resolve('/updates'), label: 'Updates', icon: IconCloudDownload }
	];

	function active(path: string): boolean {
		return path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
	}

	const phaseText = $derived(
		data.enginePhase === 'discovering'
			? 'Finding mailboxes'
			: data.enginePhase === 'syncing'
				? 'Backing up'
				: data.paused
					? 'Paused'
					: 'Idle'
	);
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
		<div class="footer">
			<div class="phase" class:busy={data.enginePhase !== 'idle'}>{phaseText}</div>
			<div class="version">Version {data.version}</div>
		</div>
	</nav>
	<main>
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
