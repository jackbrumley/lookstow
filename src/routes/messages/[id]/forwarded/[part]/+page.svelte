<script lang="ts">
	import type { PageProps } from './$types';
	import MessagePage from '../../message-page.svelte';

	let { data }: PageProps = $props();
</script>

<MessagePage {data} />
