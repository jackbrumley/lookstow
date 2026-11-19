<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import type { PageProps } from './$types';
	import Button from '#lib/ui/button.svelte';
	import Card from '#lib/ui/card.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { toast } from '#lib/runes/toast.svelte.ts';
	import { logReplySchema, type LogLine } from '#lib/schemas/log.ts';

	let { data }: PageProps = $props();

	/** The newest lines the page has, oldest first; at most this many. */
	const KEEP = 2000;
	let lines = $state<LogLine[]>(untrack(() => data.lines));
	let level = $state<'all' | 'warn' | 'error'>('all');
	let search = $state('');
	let following = $state<boolean>(true);
	let box = $state<HTMLElement | null>(null);

	const shown = $derived(
		lines.filter((line) => {
			const text = search.trim().toLowerCase();
			const levelOk =
				level === 'all' || (level === 'warn' ? line.level !== 'info' : line.level === 'error');
			return (
				levelOk && (text === '' || `${line.area} ${line.message}`.toLowerCase().includes(text))
			);
		})
	);

	function asText(line: LogLine): string {
		return `[${line.at}] ${line.level.toUpperCase()} ${line.area}: ${line.message}`;
	}

	async function copyShown(): Promise<void> {
		await navigator.clipboard.writeText(shown.map(asText).join('\n'));
		toast.success(`Copied ${shown.length} lines.`);
	}

	// New lines every two seconds; the view keeps to the bottom while following.
	onMount(() => {
		const timer = setInterval(() => {
			const after = lines.at(-1)?.seq ?? 0;
			void fetch(`/api/log?after=${after}`, { cache: 'no-store' })
				.then(async (response) => {
					const reply = logReplySchema.safeParse(await response.json());
					if (!reply.success) {
						return;
					}
					const fresh = reply.data.lines;
					if (fresh.length === 0) {
						return;
					}
					lines = [...lines, ...fresh].slice(-KEEP);
					if (following) {
						await tick();
						box?.scrollTo({ top: box.scrollHeight });
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
	title="Log"
	lede="The service's own log, live: every sync, throttling reply and problem, as it happens. Activity has the same events in plain words; this is the detail."
>
	{#snippet actions()}
		<Button variant="secondary" onclick={() => void copyShown()}>Copy</Button>
	{/snippet}
</PageHeader>

<Card>
	<div class="filters">
		<input
			type="search"
			placeholder="Search the log"
			aria-label="Search the log"
			bind:value={search}
		/>
		<select aria-label="Level" bind:value={level}>
			<option value="all">Everything</option>
			<option value="warn">Warnings and problems</option>
			<option value="error">Problems only</option>
		</select>
		<label class="check"><input type="checkbox" bind:checked={following} /> Follow new lines</label>
		<span class="muted small">{shown.length} of {lines.length} lines (the last {KEEP} kept)</span>
	</div>
	<div class="log" bind:this={box}>
		{#each shown as line (line.seq)}
			<div class="line {line.level}">
				<span class="at">{new Date(line.at).toLocaleTimeString('en-AU')}</span>
				<span class="area">{line.area}</span>
				<span class="message">{line.message}</span>
			</div>
		{:else}
			<p class="muted">Nothing yet.</p>
		{/each}
	</div>
</Card>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: center;
		margin-bottom: var(--space-3);
	}

	.filters input[type='search'] {
		flex: 1 1 16rem;
	}

	.check {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		font-weight: var(--font-weight-normal);
	}

	.log {
		max-height: 70vh;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: var(--font-size-sm);
		background: var(--colour-surface-alt);
		border-radius: var(--radius-md);
		padding: var(--space-2) var(--space-3);
	}

	.line {
		display: grid;
		grid-template-columns: max-content 7rem 1fr;
		gap: var(--space-3);
		padding: 1px 0;
	}

	.line.warn .message {
		color: var(--colour-warn-text);
	}

	.line.error .message {
		color: var(--colour-bad-text);
	}

	.at,
	.area {
		color: var(--colour-text-muted);
	}

	.message {
		overflow-wrap: anywhere;
	}
</style>
