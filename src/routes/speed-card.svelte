<!--
	SpeedCard: how fast Lookstow is copying, at a glance, and why not faster (the throughput
	governor, docs/specs/SPEC-THROUGHPUT.md 4.6). The same numbers as GET /api/throughput.
-->
<script lang="ts">
	import DetailView from '#lib/ui/detail-view.svelte';
	import Badge from '#lib/ui/badge.svelte';
	import Card from '#lib/ui/card.svelte';
	import DataTable from '#lib/ui/data-table.svelte';
	import type { ThroughputView } from '#lib/domain/throughput.ts';
	import { formatBytes, formatDateTime, formatRelative, plural } from '#lib/utils/format.ts';

	interface Props {
		speed: ThroughputView;
	}

	let { speed }: Props = $props();

	const PHASES: Record<
		ThroughputView['pace']['phase'],
		{ label: string; tone: 'ok' | 'info' | 'warn' | 'neutral' }
	> = {
		idle: { label: 'Idle: nothing is being copied', tone: 'neutral' },
		climbing: { label: 'Climbing', tone: 'info' },
		holding: { label: 'Holding under Microsoft’s limit', tone: 'warn' },
		probing: { label: 'At the learned limit, probing', tone: 'ok' }
	};

	const windows = $derived([
		{ label: '10 seconds', seconds: 10, counters: speed.rates.last10Seconds },
		{ label: '1 minute', seconds: 60, counters: speed.rates.lastMinute },
		{ label: '15 minutes', seconds: 900, counters: speed.rates.last15Minutes }
	]);
	type RowWindow = (typeof windows)[number];
	type RowLane = ThroughputView['lanes'][number];

	function perSecond(value: number, seconds: number): string {
		return (value / seconds).toFixed(1);
	}
</script>

<Card title="Speed">
	<div class="tiles">
		<div class="tile">
			<!-- What is arriving from Microsoft now (counted as it arrives), and what has been
			     stored: an archive export reply can take minutes before its emails are stored. -->
			<span class="muted small">Receiving</span>
			<strong>{formatBytes(speed.rates.lastMinute.bytes / 60)}/s</strong>
			<span class="small"
				>{speed.service.rates.lastMinute.messagesPerSecond.toFixed(1)} messages/s stored</span
			>
		</div>
		<div class="tile">
			<span class="muted small">Requests to Microsoft</span>
			<strong>{perSecond(speed.rates.lastMinute.requests, 60)}/s</strong>
			<span class="small">allowed {speed.pace.startsPerSecond}/s</span>
		</div>
		<div class="tile">
			<span class="muted small">In flight</span>
			<strong>{speed.pace.inFlight} of {speed.pace.inFlightCap}</strong>
			<span class="small"
				>{plural(speed.service.engine.mailboxesSyncing, 'mailbox', 'mailboxes')} syncing</span
			>
		</div>
		<div class="tile">
			<span class="muted small">Throttled (1 min)</span>
			<strong>{speed.rates.lastMinute.throttled}</strong>
			<span class="small">{speed.rates.last15Minutes.throttled} in 15 minutes</span>
		</div>
	</div>

	<DetailView>
		<dt>Pace</dt>
		<dd>
			<Badge tone={PHASES[speed.pace.phase].tone}>{PHASES[speed.pace.phase].label}</Badge>
			{#if speed.pace.phase === 'idle'}
				Allowed {speed.pace.startsPerSecond}/s when copying starts again.
			{:else if speed.pace.pausedUntil !== null}
				Microsoft asked every request to wait until {formatDateTime(speed.pace.pausedUntil)}.
			{:else if speed.pace.holdUntil !== null}
				Holding until {formatDateTime(speed.pace.holdUntil)}, then probing upwards.
			{/if}
		</dd>
		{#if speed.pace.phase !== 'idle'}
			<dt>More mailboxes</dt>
			<dd>
				{speed.headroom.more
					? 'Room for more: Microsoft is not holding Lookstow back'
					: speed.headroom.reason}
			</dd>
		{/if}
		{#if speed.pace.lastCut !== null}
			<dt>Last slow-down</dt>
			<dd>
				{formatRelative(speed.pace.lastCut.at)}: {speed.pace.lastCut.code}, wait {Math.round(
					speed.pace.lastCut.retryAfterMs / 1000
				)} s
			</dd>
		{/if}
		{#if speed.pace.ceiling !== null}
			<dt>Learned limit</dt>
			<dd>
				{speed.pace.ceiling.startsPerSecond}/s and {speed.pace.ceiling.inFlightCap} in flight, found {formatRelative(
					speed.pace.ceiling.at
				)}
			</dd>
		{/if}
	</DetailView>

	<div class="rates">
		<DataTable
			columns={['Over the last', 'Requests/s', 'Downloaded/s', 'Throttled', 'Failed']}
			rows={windows}
			key={(window: RowWindow) => window.label}
		>
			{#snippet cells(window: RowWindow)}
				<td>{window.label}</td>
				<td>{perSecond(window.counters.requests, window.seconds)}</td>
				<td>{formatBytes(window.counters.bytes / window.seconds)}</td>
				<td>{window.counters.throttled}</td>
				<td>{window.counters.failed}</td>
			{/snippet}
		</DataTable>
	</div>

	{#if speed.lanes.length > 0}
		<details>
			<summary>Mailbox lanes ({speed.lanes.length})</summary>
			<DataTable
				columns={['Lane', 'Limit', 'In flight', 'Waiting', 'Requests (1 min)', 'Last throttled']}
				rows={speed.lanes}
				key={(lane: RowLane) => lane.name}
			>
				{#snippet cells(lane: RowLane)}
					<td>{lane.name}</td>
					<td>{lane.limit}</td>
					<td>{lane.inFlight}</td>
					<td>{lane.waiting}</td>
					<td>{lane.requestsLastMinute}</td>
					<td>{lane.lastThrottleAt === null ? '—' : formatRelative(lane.lastThrottleAt)}</td>
				{/snippet}
			</DataTable>
		</details>
	{/if}

	{#if speed.changes.length > 0}
		<details>
			<summary>Pace changes ({speed.changes.length})</summary>
			<ul class="changes small">
				{#each [...speed.changes].reverse() as change, index (index)}
					<li>
						<span class="muted">{formatDateTime(change.at)}</span>
						{change.lane ?? 'Pace'}: {change.from} → {change.to}, {change.reason}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</Card>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}

	.tile {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--colour-border);
		border-radius: var(--radius-md);
	}

	.tile strong {
		font-size: var(--font-size-lg);
	}

	.rates {
		margin-bottom: var(--space-3);
	}

	details {
		margin-top: var(--space-2);
	}

	summary {
		cursor: pointer;
		color: var(--colour-text-muted);
	}

	.changes {
		margin: var(--space-2) 0 0;
		padding-left: var(--space-4);
		display: grid;
		gap: var(--space-1);
	}
</style>
