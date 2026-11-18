import { z } from 'zod';

export const stableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

/** The release targets: one whole-install bundle each. */
export const RELEASE_TARGETS = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'] as const;
export const releaseTargetSchema = z.enum(RELEASE_TARGETS);
export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;

/**
 * The signed release manifest (lookstow-app-<target>.json). The launcher's updater
 * (launcher/crates/lookstow/src/updates/manifest.rs) and install.sh read the same fields;
 * `minimumLauncher` is the oldest installed version that may update to this release by itself,
 * and `rollbackFrom` lists the versions that run on the database this release leaves.
 */
export const serverManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	version: stableVersionSchema,
	target: releaseTargetSchema,
	archive: z.string().max(120),
	bytes: z
		.int()
		.min(1)
		.max(1024 ** 3),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	minimumLauncher: stableVersionSchema,
	nodeMajor: z.int().positive(),
	rollbackFrom: z.array(stableVersionSchema).max(32)
});
export type ServerManifest = z.infer<typeof serverManifestSchema>;

const updateReleaseSchema = z.strictObject({
	version: stableVersionSchema,
	/** The GitHub release body (Markdown; draw it with release-markdown.ts). */
	notes: z.string().max(20_000),
	publishedAtIso: z.iso.datetime(),
	manifest: serverManifestSchema
});

/** update-status.json, written only by the launcher's updater. */
export const updaterStatusSchema = z.strictObject({
	phase: z.enum([
		'checking',
		'up-to-date',
		'downloading',
		'switching',
		'starting',
		'healthy',
		'rolled-back',
		'failed'
	]),
	from: stableVersionSchema.nullable(),
	to: stableVersionSchema.nullable(),
	message: z.string().max(4000),
	atMs: z.int().nonnegative()
});

/** What the console shows: the updater's status, or the app's own request waiting for it. */
const serverUpdateOperationSchema = z.strictObject({
	phase: z.enum(['idle', 'requested', ...updaterStatusSchema.shape.phase.options]),
	from: stableVersionSchema.nullable(),
	to: stableVersionSchema.nullable(),
	message: z.string().max(4000),
	atIso: z.iso.datetime().nullable()
});

/** update-timings.json, written only by the updater: when each step of the last update ended. */
export const updaterTimingsSchema = z.object({
	steps: z.array(z.object({ step: z.string().max(100), atMs: z.int().nonnegative() })).max(32)
});

/** The last update's steps, each with when it ended. */
const updateTimingsSchema = z
	.array(z.strictObject({ step: z.string(), atIso: z.iso.datetime() }))
	.max(32);

/** The last release check, kept in check.json in the data folder across restarts. */
export const updateCacheSchema = z.strictObject({
	checkedAtIso: z.iso.datetime().nullable(),
	lastSuccessAtIso: z.iso.datetime().nullable(),
	release: updateReleaseSchema.nullable(),
	problem: z.string().nullable()
});

/** GET /api/updates and POST /api/updates (Check now) reply with this. */
export const serverUpdateViewSchema = z.strictObject({
	installedVersion: stableVersionSchema,
	deployment: z.enum(['source', 'installed']),
	checkedAtIso: z.iso.datetime().nullable(),
	lastSuccessAtIso: z.iso.datetime().nullable(),
	release: updateReleaseSchema.nullable(),
	problem: z.string().nullable(),
	install: z.strictObject({ allowed: z.boolean(), reason: z.string() }),
	operation: serverUpdateOperationSchema,
	lastUpdateSteps: updateTimingsSchema
});
export type ServerUpdateView = z.infer<typeof serverUpdateViewSchema>;

/** POST /api/updates/request's body: the version the person confirmed. */
export const serverUpdateRequestSchema = z.strictObject({ version: stableVersionSchema });

/** Update now's reply: when the request was written, so the page ignores older updater results. */
export const serverUpdateRequestedSchema = z.strictObject({
	requestedAtIso: z.iso.datetime(),
	view: serverUpdateViewSchema
});
export type ServerUpdateRequested = z.infer<typeof serverUpdateRequestedSchema>;

/** The reply to a refused request (400, 403 or 409): the reason, in plain words. */
export const serverUpdateRefusedSchema = z.strictObject({ message: z.string() });

export type ServerUpdateOperation = z.infer<typeof serverUpdateOperationSchema>;
export type UpdateCache = z.infer<typeof updateCacheSchema>;
