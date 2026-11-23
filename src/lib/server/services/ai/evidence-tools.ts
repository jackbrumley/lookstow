import { z } from 'zod';
import type { Queryable } from '../../database/connection.ts';
import {
	PACK_MAX_MESSAGES,
	packProgress,
	type EvidencePack
} from '../../../domain/evidence-packs.ts';
import type { PackBuilder } from '../evidence/builder.ts';
import { createPack, listPacks, planPack, readPack } from '../evidence/packs.ts';
import { recordActivity } from '../activity/activity.ts';

/**
 * The AI tools for evidence packs (docs/specs/SPEC-EVIDENCE-PACKS.md): make a ZIP of chosen
 * messages, see the packs and how far each has got, and get a finished one's download URL. The
 * download needs the same access token as /mcp.
 */
export type EvidenceContext = { builder: PackBuilder; dataDir: string };

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };

const MISSING_SHOWN = 100;

export const EVIDENCE_TOOLS = [
	{
		name: 'create_evidence_pack',
		description: `Makes an evidence pack: one ZIP file of the given messages (Lookstow ids, up to ${PACK_MAX_MESSAGES.toLocaleString('en-AU')}), each as its .eml exactly as stored, with manifest.csv, index.html, README.txt and SHA256SUMS.txt, for handing to a lawyer. It is made in the background; follow it with get_evidence_pack. withAttachments also puts every attachment in as its own file. Ids Lookstow does not have are listed back and left out.`,
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'What the pack is for, used as its file name' },
				messageIds: { type: 'array', items: { type: 'string' } },
				withAttachments: { type: 'boolean' }
			},
			required: ['messageIds']
		}
	},
	{
		name: 'list_evidence_packs',
		description:
			'Every evidence pack still kept (7 days after it was made): its id, name, state (queued, building, ready, failed), progress, size, SHA-256 and, when ready, its download URL.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'get_evidence_pack',
		description:
			'One evidence pack: its state and progress, the ids asked for that are not in the backup, and when ready its size, SHA-256 and download URL. Download it with curl, sending the same Authorization header (it can be many gigabytes: save it to a file).',
		inputSchema: {
			type: 'object',
			properties: { packId: { type: 'string' } },
			required: ['packId']
		}
	}
] as const;

const createInput = z.object({
	name: z.string().max(200).optional(),
	messageIds: z.array(z.string().max(200)).max(PACK_MAX_MESSAGES),
	withAttachments: z.boolean().optional()
});
const getInput = z.object({ packId: z.string() });

/** An AI agent as packs and the activity log name it: whose, when it is a remote account's. */
function agentName(who: string | undefined): string {
	return who === undefined || who === 'this computer' ? 'AI agent' : `AI agent (${who})`;
}

function text(value: unknown): Text {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): Text {
	return { content: [{ type: 'text', text: message }], isError: true };
}

function described(pack: EvidencePack, baseUrl: string, full: boolean) {
	return {
		id: pack.id,
		name: pack.name,
		state: pack.status,
		progress: packProgress(pack),
		messages: pack.total,
		written: pack.done,
		createdBy: pack.createdBy,
		createdAt: pack.createdAt,
		zipBytes: pack.zipBytes,
		sha256: pack.sha256,
		storedFilesNotMatching: pack.mismatched,
		unreadable: pack.unreadable,
		missingCount: pack.missing.length,
		...(full ? { missing: pack.missing.slice(0, MISSING_SHOWN) } : {}),
		expiresAt: pack.expiresAt,
		downloadUrl:
			pack.status === 'ready' ? `${baseUrl}/mcp/evidence-packs/${pack.id}/download` : null,
		consoleUrl: `${baseUrl}/evidence-packs`
	};
}

export async function callEvidenceTool(
	context: {
		db: Queryable;
		baseUrl: string;
		who?: string | undefined;
		evidence?: EvidenceContext | undefined;
	},
	name: string,
	args: unknown
): Promise<Text | null> {
	if (!EVIDENCE_TOOLS.some((tool) => tool.name === name)) return null;
	const evidence = context.evidence;
	if (evidence === undefined) return failure('Evidence packs are not available here.');
	switch (name) {
		case 'create_evidence_pack': {
			const input = createInput.safeParse(args);
			if (!input.success) {
				return failure(input.error.issues[0]?.message ?? 'Give messageIds, a list of ids');
			}
			const ids = [...new Set(input.data.messageIds.map((id) => id.trim().toLowerCase()))];
			const withAttachments = input.data.withAttachments ?? false;
			const plan = await planPack(
				context.db,
				evidence.dataDir,
				ids,
				input.data.messageIds.length - ids.length,
				withAttachments
			);
			if (plan.refusal !== null) return failure(plan.refusal);
			const pack = await createPack(evidence.dataDir, plan, {
				name: input.data.name ?? '',
				createdBy: agentName(context.who),
				withAttachments
			});
			recordActivity(context.db, {
				level: 'info',
				kind: 'evidence-pack',
				actor: agentName(context.who),
				summary: `Evidence pack asked for: ${pack.name}`,
				detail: `${String(pack.total)} messages${pack.missing.length > 0 ? `; ${String(pack.missing.length)} ids not in the backup` : ''}.`
			});
			await evidence.builder.enqueue(pack.id);
			return text(described(pack, context.baseUrl, true));
		}
		case 'list_evidence_packs': {
			const { packs } = await listPacks(evidence.dataDir);
			return text(packs.map((pack) => described(pack, context.baseUrl, false)));
		}
		default: {
			const input = getInput.safeParse(args);
			if (!input.success) return failure('Give packId');
			const stored = await readPack(evidence.dataDir, input.data.packId).catch(() => null);
			if (stored === null) return failure(`No evidence pack with id ${input.data.packId}`);
			const { packs } = await listPacks(evidence.dataDir);
			const pack = packs.find((each) => each.id === stored.id);
			if (pack === undefined) return failure('That pack has been removed.');
			return text(described(pack, context.baseUrl, true));
		}
	}
}
