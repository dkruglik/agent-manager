import type { BuildInfo, DevPreviewRunning } from '../api';

export interface BuildLabel {
  text: string;
  title: string;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * What Settings shows as this build's version. A dev preview runs a PR build
 * rather than the image the stamp describes, so its own label wins.
 */
export function buildLabel(build: BuildInfo | null | undefined, running?: DevPreviewRunning): BuildLabel {
  if (running && running.kind !== 'main') {
    return { text: `dev preview: ${running.label}`, title: 'A dev-preview build of open PRs, not the image' };
  }
  if (!build) return { text: 'unknown', title: 'This build carries no commit stamp' };
  if (build.source === 'space-commit') {
    return {
      text: `${short(build.sha)} · Space commit`,
      title: `${build.sha}: the Space repo's own commit. This build was not stamped with the agent-manager commit it came from.`,
    };
  }
  return { text: build.ref ? `${short(build.sha)} · ${build.ref}` : short(build.sha), title: build.sha };
}
