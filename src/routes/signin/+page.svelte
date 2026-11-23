<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';
	import Callout from '#lib/ui/callout.svelte';
	import Card from '#lib/ui/card.svelte';
	import Button from '#lib/ui/button.svelte';

	let { data, form }: PageProps = $props();
	let signingIn = $state(false);
</script>

<svelte:head><title>Sign in · Lookstow</title></svelte:head>

<div class="signin">
	<Card title="Sign in to Lookstow">
		<p class="muted">
			Remote access is read-only: you can search, open and download backed-up messages. Your
			Lookstow administrator gives you a username and password.
		</p>
		<form
			method="POST"
			use:enhance={() => {
				signingIn = true;
				return async ({ update }) => {
					await update({ reset: false });
					signingIn = false;
				};
			}}
		>
			<input type="hidden" name="next" value={data.next} />
			<label>
				Username
				<input name="username" autocomplete="username" required maxlength="40" />
			</label>
			<label>
				Password
				<input
					name="password"
					type="password"
					autocomplete="current-password"
					required
					maxlength="200"
				/>
			</label>
			{#if form?.message}<Callout tone="danger">{form.message}</Callout>{/if}
			<Button type="submit" disabled={signingIn}>{signingIn ? 'Signing in…' : 'Sign in'}</Button>
		</form>
	</Card>
</div>

<style>
	.signin {
		max-width: 28rem;
		width: 100%;
		justify-self: center;
		margin-top: var(--space-8);
	}

	form {
		display: grid;
		gap: var(--space-4);
		margin-top: var(--space-4);
	}

	label {
		display: grid;
		gap: var(--space-1);
		font-weight: var(--font-weight-medium);
	}

	.muted {
		color: var(--colour-text-muted);
		margin: 0;
	}
</style>
