/**
 * Stable release versions (`x.y.z`): what a Lookstow release, its tag (`vx.y.z`) and the
 * launcher's manifest carry. Browser-safe, and free of package imports so the release scripts
 * can load it with plain `node`.
 */

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isStableVersion(text: string): boolean {
	return STABLE.test(text);
}

function parts(text: string): [number, number, number] {
	const match = STABLE.exec(text);
	if (match === null) {
		throw new Error(`${text} is not a release version (x.y.z)`);
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, positive when newer, 0 when the same. */
export function compareVersions(a: string, b: string): number {
	const [leftMajor, leftMinor, leftPatch] = parts(a);
	const [rightMajor, rightMinor, rightPatch] = parts(b);
	return Math.sign(leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch);
}
