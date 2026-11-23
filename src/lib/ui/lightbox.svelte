<!--
	Lightbox: a message's pictures and PDFs over the page, so looking through mail never opens a
	tab. Pictures: zoom with the buttons, the wheel, a pinch or + - 0; rotate with the buttons or
	R (Shift+R the other way); drag to move. PDFs show in the browser's own PDF viewer, which has
	its own zoom, rotate and pages. Flick between them with the arrows or ← →; close with Esc or
	a click outside (not at the end of a drag). After Midfield AI's media lightbox.
-->
<script lang="ts">
	import type { ResolvedPathname } from '$app/types';
	import IconChevronLeft from '@tabler/icons-svelte-runes/icons/chevron-left';
	import IconChevronRight from '@tabler/icons-svelte-runes/icons/chevron-right';
	import IconDownload from '@tabler/icons-svelte-runes/icons/download';
	import IconExternalLink from '@tabler/icons-svelte-runes/icons/external-link';
	import IconRotate from '@tabler/icons-svelte-runes/icons/rotate';
	import IconRotateClockwise from '@tabler/icons-svelte-runes/icons/rotate-clockwise';
	import IconX from '@tabler/icons-svelte-runes/icons/x';
	import IconZoomIn from '@tabler/icons-svelte-runes/icons/zoom-in';
	import IconZoomOut from '@tabler/icons-svelte-runes/icons/zoom-out';
	import IconZoomReset from '@tabler/icons-svelte-runes/icons/zoom-reset';
	import { PanZoom } from '#lib/runes/pan-zoom.svelte.ts';
	import { stepIndex } from '#lib/utils/pan-zoom.ts';

	export type LightboxItem = {
		kind: 'image' | 'pdf';
		/** Shown in the lightbox (a HEIC photo's JPEG copy). */
		view: ResolvedPathname;
		/** The original file. */
		download: ResolvedPathname;
		filename: string;
		caption: string;
	};

	interface Props {
		items: LightboxItem[];
		/** The item showing, or null when closed. */
		index: number | null;
	}

	let { items, index = $bindable() }: Props = $props();

	const panZoom = new PanZoom();
	const item = $derived(index === null ? undefined : items[index]);
	let loading = $state(true);
	let stageWidth = $state(0);
	let stageHeight = $state(0);

	// A picture is fitted to the window; on its side, its width is fitted to the window's height.
	const fitWidth = $derived(Math.max(100, (panZoom.sideways ? stageHeight : stageWidth) - 96));
	const fitHeight = $derived(Math.max(100, (panZoom.sideways ? stageWidth : stageHeight) - 32));

	function close(): void {
		index = null;
	}

	function go(by: 1 | -1): void {
		if (index === null || items.length < 2) return;
		index = stepIndex(index, items.length, by);
	}

	// Each item opens fitted, centred and upright.
	$effect(() => {
		if (item === undefined) return;
		panZoom.resetAll();
		loading = item.kind === 'image';
	});

	// The page behind does not scroll while the lightbox is open.
	$effect(() => {
		if (item === undefined) return;
		const before = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = before;
		};
	});

	function onkeydown(event: KeyboardEvent): void {
		if (item === undefined) return;
		const picture = item.kind === 'image';
		switch (event.key) {
			case 'Escape':
				close();
				break;
			case 'ArrowLeft':
				go(-1);
				break;
			case 'ArrowRight':
				go(1);
				break;
			case '+':
			case '=':
				if (!picture) return;
				panZoom.zoomIn();
				break;
			case '-':
			case '_':
				if (!picture) return;
				panZoom.zoomOut();
				break;
			case '0':
				if (!picture) return;
				panZoom.reset();
				break;
			case 'r':
				if (!picture) return;
				panZoom.rotateRight();
				break;
			case 'R':
				if (!picture) return;
				panZoom.rotateLeft();
				break;
			default:
				return;
		}
		event.preventDefault();
	}

	/** A press on the picture starts a drag; a press on the backdrop does not. */
	function onPress(event: MouseEvent): void {
		if (event.target instanceof HTMLImageElement) panZoom.mouseDown(event);
	}

	function onBackdrop(event: MouseEvent): void {
		// Only a click on the backdrop itself (not the picture or the bar), and not a drag's end.
		if (event.target !== event.currentTarget) return;
		if (panZoom.clickedOutside()) close();
	}
</script>

<svelte:document {onkeydown} onmousemove={panZoom.mouseMove} onmouseup={panZoom.mouseUp} />

{#if item !== undefined && index !== null}
	<div class="lightbox" role="dialog" aria-modal="true" aria-label={item.filename}>
		<div class="bar">
			<span class="title">
				{item.filename}
				<span class="muted">{item.caption}</span>
				{#if items.length > 1}<span class="muted">· {index + 1} of {items.length}</span>{/if}
			</span>
			<div class="tools">
				{#if item.kind === 'image'}
					<button type="button" title="Rotate left (Shift+R)" onclick={panZoom.rotateLeft}>
						<IconRotate size={18} />
					</button>
					<button type="button" title="Rotate right (R)" onclick={panZoom.rotateRight}>
						<IconRotateClockwise size={18} />
					</button>
					<button type="button" title="Zoom out (-)" onclick={panZoom.zoomOut}>
						<IconZoomOut size={18} />
					</button>
					<button type="button" class="percent" title="Back to fitted (0)" onclick={panZoom.reset}>
						{Math.round(panZoom.zoom * 100)}%
					</button>
					<button type="button" title="Zoom in (+)" onclick={panZoom.zoomIn}>
						<IconZoomIn size={18} />
					</button>
					<button type="button" title="Back to fitted and upright" onclick={panZoom.resetAll}>
						<IconZoomReset size={18} />
					</button>
				{:else}
					<span class="hint">Zoom, rotate and pages: the PDF's own toolbar</span>
				{/if}
				<a href={item.download} title="Download the original file" download>
					<IconDownload size={18} />
				</a>
				<a href={item.view} title="Open in a new tab" target="_blank" rel="noopener noreferrer">
					<IconExternalLink size={18} />
				</a>
				<button type="button" title="Close (Esc)" onclick={close}>
					<IconX size={20} />
				</button>
			</div>
		</div>

		<div
			class="stage"
			class:dragging={panZoom.dragging}
			role="presentation"
			bind:clientWidth={stageWidth}
			bind:clientHeight={stageHeight}
			onclick={onBackdrop}
			onmousedown={onPress}
			onwheel={item.kind === 'image' ? panZoom.wheel : undefined}
			ontouchstart={item.kind === 'image' ? panZoom.touchStart : undefined}
			ontouchmove={item.kind === 'image' ? panZoom.touchMove : undefined}
			ontouchend={item.kind === 'image' ? panZoom.touchEnd : undefined}
		>
			{#if item.kind === 'image'}
				{#if loading}<span class="loading">Opening…</span>{/if}
				<img
					src={item.view}
					alt={item.filename}
					style:transform={panZoom.transform}
					style:max-width="{fitWidth}px"
					style:max-height="{fitHeight}px"
					draggable="false"
					onload={() => (loading = false)}
					onerror={() => (loading = false)}
				/>
			{:else}
				<iframe class="pdf" src={item.view} title={item.filename}></iframe>
			{/if}
			{#if items.length > 1}
				<button
					type="button"
					class="step previous"
					title="Previous (←)"
					onclick={() => {
						go(-1);
					}}
				>
					<IconChevronLeft size={28} />
				</button>
				<button
					type="button"
					class="step next"
					title="Next (→)"
					onclick={() => {
						go(1);
					}}
				>
					<IconChevronRight size={28} />
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.lightbox {
		position: fixed;
		inset: 0;
		z-index: 45;
		display: flex;
		flex-direction: column;
		background: var(--colour-lightbox);
		color: var(--colour-lightbox-text);
		animation: fade-in 0.12s ease-out;
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-4);
	}

	.title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: var(--font-weight-medium);
	}

	.muted,
	.hint {
		opacity: 0.7;
		font-weight: var(--font-weight-normal);
	}

	.muted {
		margin-left: var(--space-2);
	}

	.hint {
		font-size: var(--font-size-sm);
		margin-right: var(--space-2);
	}

	.tools {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.tools button,
	.tools a,
	.step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 2.25rem;
		height: 2.25rem;
		padding: 0 var(--space-2);
		border: none;
		border-radius: var(--radius-md);
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.tools button:hover,
	.tools a:hover,
	.step:hover {
		background: var(--colour-lightbox-bar);
	}

	.percent {
		font-variant-numeric: tabular-nums;
		font-size: var(--font-size-sm);
	}

	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		display: grid;
		place-items: center;
		overflow: hidden;
		cursor: zoom-out;
		touch-action: none;
		user-select: none;
	}

	.stage img {
		object-fit: contain;
		cursor: grab;
		transform-origin: center;
		transition: transform 0.12s ease-out;
		box-shadow: var(--shadow-md);
		background: var(--colour-email-paper);
	}

	.stage.dragging img {
		cursor: grabbing;
		transition: none;
	}

	.pdf {
		width: calc(100% - 7rem);
		height: calc(100% - var(--space-4));
		border: none;
		border-radius: var(--radius-md);
		background: var(--colour-email-paper);
		box-shadow: var(--shadow-md);
	}

	.loading {
		position: absolute;
		opacity: 0.7;
	}

	.step {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		height: 3rem;
		background: var(--colour-lightbox-bar);
	}

	.previous {
		left: var(--space-3);
	}

	.next {
		right: var(--space-3);
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}

		to {
			opacity: 1;
		}
	}
</style>
