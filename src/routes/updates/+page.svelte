<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { PageProps } from './$types';
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import FullScreenWait from '#lib/ui/full-screen-wait.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { toast } from '#lib/runes/toast.svelte.ts';
	import {
		serverUpdateRefusedSchema,
		serverUpdateRequestedSchema,
		serverUpdateViewSchema,
		type ServerUpdateView
	} from '#lib/schemas/releases/server-updates.ts';
	import { updateOperationNotice } from '#lib/domain/releases/server-update-notice.ts';
	import { updateWaitLine } from '#lib/domain/releases/update-wait.ts';
	import { formatDateTime } from '#lib/utils/format.ts';
	import ReleaseNotes from './release-notes.svelte';

	let { data }: PageProps = $props();

	// The page's own copy: polled and replaced while an update runs.
	let view = $state<ServerUpdateView>(untrack(() => structuredClone(data.view)));
	let checking = $state(false);
	let confirmOpen = $state(false);
	let requesting = $state(false);
	/** Set while an update this page asked for is under way: when it was asked for, and to what. */
	let waiting = $state<{ since: number; to: string } | null>(null);
	let now = $state(Date.now());

	const notice = $derived(updateOperationNotice(view.operation.phase));

	/** How long each step of the last update took, from the step before it. */
	const lastUpdate = $derived.by(() => {
		const steps = view.lastUpdateSteps;
		const first = steps[0];
		const last = steps.at(-1);
		if (first === undefined || last === undefined || steps.length < 2) return null;
		return {
			total: Date.parse(last.atIso) - Date.parse(first.atIso),
			startedIso: first.atIso,
			steps: steps.slice(1).map((step, index) => ({
				step: step.step,
				ms: Date.parse(step.atIso) - Date.parse(steps[index]?.atIso ?? step.atIso)
			}))
		};
	});

	function seconds(ms: number): string {
		const total = Math.max(0, Math.round(ms / 1000));
		return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
	}

	async function refusedMessage(response: Response): Promise<string> {
		const parsed = serverUpdateRefusedSchema.safeParse(await response.json().catch(() => null));
		return parsed.success ? parsed.data.message : `Lookstow answered ${response.status}.`;
	}

	async function checkNow(): Promise<void> {
		checking = true;
		try {
			const response = await fetch('/api/updates', { method: 'POST' });
			if (!response.ok) {
				toast.error(await refusedMessage(response));
				return;
			}
			const parsed = serverUpdateViewSchema.safeParse(await response.json());
			if (parsed.success) {
				view = parsed.data;
				toast.info(
					view.release === null
						? 'Lookstow is up to date.'
						: `Lookstow ${view.release.version} is available.`
				);
			}
		} finally {
			checking = false;
		}
	}

	async function updateNow(version: string): Promise<void> {
		requesting = true;
		try {
			const response = await fetch('/api/updates/request', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ version })
			});
			if (!response.ok) {
				toast.error(await refusedMessage(response));
				return;
			}
			const parsed = serverUpdateRequestedSchema.safeParse(await response.json());
			if (parsed.success) {
				view = parsed.data.view;
				waiting = { since: Date.now(), to: version };
				confirmOpen = false;
			}
		} finally {
			requesting = false;
		}
	}

	/** The version this page was loaded with: once the server answers with another, reload. */
	const loadedVersion = untrack(() => data.view.installedVersion);
	const ACTIVE = new Set(['requested', 'checking', 'downloading', 'switching', 'starting']);

	/** First seen running here: the countdown for an update this page did not ask for. */
	const pageOpened = Date.now();

	/** The update under way (asked for here, automatically, or in another tab), if any. */
	const updating = $derived.by(() => {
		if (waiting !== null) return waiting;
		if (!ACTIVE.has(view.operation.phase)) return null;
		const asked = view.operation.atIso === null ? Number.NaN : Date.parse(view.operation.atIso);
		return {
			since: Number.isNaN(asked) ? pageOpened : asked,
			to: view.release?.version ?? null
		};
	});

	// While any update runs (started here, automatically, or in another tab), ask every two
	// seconds. The service restarts in the middle, so failed requests are expected; once it
	// answers with a new version, the page reloads into it.
	onMount(() => {
		const timer = setInterval(() => {
			now = Date.now();
			if (waiting === null && !ACTIVE.has(view.operation.phase)) {
				return;
			}
			void fetch('/api/updates', { cache: 'no-store' })
				.then(async (response) => {
					const parsed = serverUpdateViewSchema.safeParse(await response.json());
					if (!parsed.success) {
						return;
					}
					view = parsed.data;
					if (parsed.data.installedVersion !== loadedVersion) {
						location.reload();
					} else if (
						parsed.data.operation.phase === 'failed' ||
						parsed.data.operation.phase === 'rolled-back'
					) {
						waiting = null;
					}
				})
				.catch(() => undefined);
		}, 2000);
		return () => {
			clearInterval(timer);
		};
	});
</script>

<PageHeader
	title="Updates"
	lede="Lookstow updates itself from signed releases, and rolls back if a new version does not start."
>
	{#snippet actions()}
		<Button
			variant="secondary"
			disabled={checking || waiting !== null}
			onclick={() => void checkNow()}
		>
			{checking ? 'Checking…' : 'Check now'}
		</Button>
	{/snippet}
</PageHeader>

{#if updating !== null}
	<!-- The wait owns the screen: nothing else can be used until Lookstow is back. -->
	<FullScreenWait
		title={updating.to === null
			? 'Lookstow is updating. Please wait.'
			: `Lookstow is updating to ${updating.to}. Please wait.`}
		detail={`${updateWaitLine(now - updating.since)}. This page reloads by itself when the new version is running.`}
		note={view.operation.message}
	/>
{:else if notice !== undefined}
	<Card title={notice.title} tone={notice.tone === 'warning' ? 'warn' : 'plain'}>
		<p>{view.operation.message}</p>
		{#if view.operation.atIso !== null}<p class="muted small">
				{formatDateTime(view.operation.atIso)}
			</p>{/if}
	</Card>
{/if}

<Card title="This server">
	<DetailView>
		<dt>Installed version</dt>
		<dd>{view.installedVersion}</dd>
		<dt>Last checked</dt>
		<dd>{formatDateTime(view.checkedAtIso)}</dd>
		{#if view.problem !== null}
			<dt>Last check</dt>
			<dd><Badge tone="warn">Problem</Badge> {view.problem}</dd>
		{/if}
		{#if lastUpdate !== null}
			<dt>Last update</dt>
			<dd>
				{seconds(lastUpdate.total)} from asking to ready ({formatDateTime(lastUpdate.startedIso)})
				<ul class="steps small">
					{#each lastUpdate.steps as step, index (index)}
						<li><span class="muted">{seconds(step.ms)}</span> until {step.step}</li>
					{/each}
				</ul>
			</dd>
		{/if}
		{#if view.deployment === 'source'}
			<dt>Running from</dt>
			<dd>Source (development). Updates are installed only on an installed service.</dd>
		{/if}
	</DetailView>
</Card>

{#if view.release !== null}
	<Card title={`Lookstow ${view.release.version} is available`}>
		{#snippet actions()}
			<Button
				disabled={!view.install.allowed || waiting !== null}
				title={view.install.allowed ? undefined : view.install.reason}
				onclick={() => (confirmOpen = true)}
			>
				Update now…
			</Button>
		{/snippet}
		<p class="muted small">Published {formatDateTime(view.release.publishedAtIso)}</p>
		{#if !view.install.allowed}<p class="muted">{view.install.reason}</p>{/if}
		<ReleaseNotes body={view.release.notes} />
	</Card>

	<Modal bind:open={confirmOpen} title={`Update to ${view.release.version}?`} locked={requesting}>
		<p>
			Lookstow stops for about three minutes while the new version is put in place. Backups pause
			and pick up where they stopped. If the new version does not start, the updater puts this
			version back by itself.
		</p>
		{#snippet footer()}
			<Button variant="secondary" disabled={requesting} onclick={() => (confirmOpen = false)}
				>Cancel</Button
			>
			<Button
				disabled={requesting}
				onclick={() => view.release !== null && void updateNow(view.release.version)}
			>
				{requesting ? 'Asking…' : 'Update now'}
			</Button>
		{/snippet}
	</Modal>
{:else}
	<Card>
		<p>Lookstow {view.installedVersion} is the latest version.</p>
	</Card>
{/if}

<style>
	.steps {
		list-style: none;
		margin: var(--space-1) 0 0;
		padding: 0;
	}
</style>
