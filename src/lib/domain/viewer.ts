/**
 * A stored message as the console's viewer shows it (docs/specs/SPEC-VIEWER.md). Browser-safe:
 * the page reads it; the server builds it from the stored file.
 */
import type { MessageDetail } from './messages.ts';
export type PreviewKind = 'image' | 'pdf' | 'text' | 'email';

export type ViewAttachment = {
	index: number;
	filename: string;
	contentType: string;
	bytes: number;
	/** Shown inside the message (a pasted picture, a signature logo) rather than attached. */
	inline: boolean;
	/** Inside a forwarded email: that email's attachment index, else null. */
	insideAttachment: number | null;
	/** How it can be shown on the page, or null: download only. */
	preview: PreviewKind | null;
};

/** A message's page, or a forwarded email's inside it (`part`: its attachment index). */
export type MessagePageData = {
	message: MessageDetail;
	part: number | null;
	view: MessageView | null;
	viewProblem: string | null;
};

export type MessageView = {
	subject: string;
	from: string;
	to: string;
	cc: string;
	date: string;
	hasHtml: boolean;
	attachments: ViewAttachment[];
};
