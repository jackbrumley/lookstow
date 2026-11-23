import { describe, expect, it } from 'vitest';
import { parseEml } from '../ai/mime.ts';
import { bodyDocument, bodyPolicy, inlineType, previewKind, viewOf } from './view-message.ts';

const PIXEL = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

function eml(lines: string[]): Buffer {
	return Buffer.from(lines.join('\r\n'));
}

const withPicture = eml([
	'From: Ann <ann@example.com>',
	'To: Bob <bob@example.com>',
	'Subject: Site photo',
	'Date: Mon, 2 Nov 2026 09:00:00 +1000',
	'MIME-Version: 1.0',
	'Content-Type: multipart/related; boundary="b1"',
	'',
	'--b1',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>See <img src="cid:pic1@x"> and <a href="https://example.com">this</a></p><script>alert(1)</script>',
	'--b1',
	'Content-Type: image/png; name="pic.png"',
	'Content-Transfer-Encoding: base64',
	'Content-ID: <pic1@x>',
	'Content-Disposition: inline; filename="pic.png"',
	'',
	PIXEL.toString('base64'),
	'--b1--',
	''
]);

const plainOnly = eml([
	'From: ann@example.com',
	'Subject: Plain',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Hello <b>there</b> & bye',
	''
]);

describe('previewing attachments', () => {
	it('shows pictures, PDFs, emails and small text, and downloads the rest', () => {
		expect(previewKind('image/png', 'a.png', 10)).toBe('image');
		expect(previewKind('application/octet-stream', 'report.PDF', 10)).toBe('pdf');
		expect(previewKind('message/rfc822', 'fwd', 10)).toBe('email');
		expect(previewKind('text/plain', 'a.txt', 10)).toBe('text');
		expect(previewKind('text/plain', 'a.txt', 3 * 1024 * 1024)).toBeNull();
		// iPhone photos are viewed as a JPEG copy (viewer/heic.ts), up to 40 MB.
		expect(previewKind('image/heic', 'IMG_1.HEIC', 10)).toBe('image');
		expect(previewKind('application/octet-stream', 'IMG_2.heif', 10)).toBe('image');
		expect(previewKind('image/heic', 'IMG_3.HEIC', 41 * 1024 * 1024)).toBeNull();
		expect(previewKind('image/svg+xml', 'logo.svg', 10)).toBeNull();
		expect(previewKind('text/html', 'page.html', 10)).toBeNull();
		expect(previewKind('application/zip', 'a.zip', 10)).toBeNull();
	});

	it('never sends an attachment as something that runs', () => {
		expect(inlineType('text', 'text/html')).toBe('text/plain; charset=utf-8');
		expect(inlineType('pdf', 'application/octet-stream')).toBe('application/pdf');
	});
});

describe('the message body', () => {
	it('writes its own pictures in, and keeps the headers and attachments for the page', () => {
		const parsed = parseEml(withPicture);
		const view = viewOf(parsed);
		expect(view).toMatchObject({ subject: 'Site photo', hasHtml: true });
		expect(view.attachments).toEqual([
			expect.objectContaining({ filename: 'pic.png', preview: 'image', bytes: PIXEL.length })
		]);
		const html = bodyDocument(parsed);
		expect(html).toContain(`data:image/png;base64,${PIXEL.toString('base64')}`);
		expect(html).not.toContain('cid:pic1@x');
		expect(html).toContain('<base target="_blank">');
		expect(html).toContain('no-referrer');
	});

	it('shows a text body as text, never as HTML', () => {
		const html = bodyDocument(parseEml(plainOnly));
		expect(html).toContain('<pre>Hello &lt;b&gt;there&lt;/b&gt; &amp; bye');
		expect(html).not.toContain('<b>');
	});

	it('runs nothing, and loads internet pictures only when asked', () => {
		for (const policy of [bodyPolicy(false), bodyPolicy(true)]) {
			expect(policy).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox;/);
			expect(policy).toContain("default-src 'none'");
			expect(policy).not.toContain('script');
			expect(policy).not.toContain('allow-same-origin');
		}
		expect(bodyPolicy(false)).toContain('img-src data:;');
		expect(bodyPolicy(true)).toContain('img-src data: https: http:');
	});
});
