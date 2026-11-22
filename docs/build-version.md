# Build version in Settings

**Status:** implemented as of 2026-11-22. Settings → General → Space shows the
commit the running build came from.

## Where the commit comes from

The image is built without `.git` (`.dockerignore` excludes it), so the build
cannot ask git. `server/src/build-info.js` reads the commit once at startup.
It tries each source below in order and stops at the first one that works:

1. **`server/build-info.json`**, a stamp `{"sha": "<commit>", "ref": "<branch>"}`
   written by a deploy:
   - the in-app **Update Agent Manager** (`server/src/update-deploy.js`) adds it
     to the one deploy commit and names the upstream commit;
   - `scripts/deploy-dev-space.sh` adds it in the same commit as the dev card and
     names the pushed branch's commit.

   The file is gitignored, so a stamp is only ever in a Space's repo.
2. **`git rev-parse HEAD`** in the app directory, for a checkout run from source.
   Only a repo rooted at the app directory counts. An app unpacked inside
   another checkout, such as a dev-preview release, does not report that
   checkout's commit.
3. **`COMMIT_SHA`**, which HF sets on a Space. This is the commit of the Space
   repo itself, not an agent-manager commit. A Space that was duplicated or
   pushed by hand has nothing better, so the label reads `<sha> · Space commit`.

`/api/info` returns the result as `build: {sha, ref, source}`, or `null` when no
source works. It also returns `null` while the instance is locked, because a
ref can name a private branch.

## What Settings shows

- `1233c80 · main`: the short commit and the branch. Hovering shows the full SHA.
- `1233c80 · Space commit`: no stamp was found, so this is HF's own Space commit.
- `dev preview: #12 … + #14 …`: a dev-preview build of open PRs is running
  ([dev preview](dev-preview.md)), so the image's stamp would be wrong.
- `unknown`: none of the sources gave a commit.

## Known gap

The updater counts a Space as up to date when its files already match
upstream, whatever the stamp says. A Space last deployed before stamping
existed whose files match upstream gets no stamp until upstream changes. Until
then its label shows the Space commit.
