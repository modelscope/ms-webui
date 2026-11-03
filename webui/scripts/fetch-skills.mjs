#!/usr/bin/env node
// Bundle skills into public/skills/ before build/publish:
//   public/skills/swift/       <- the swift repo's skills/ folder (the swift-usage skill)
//   public/skills/modelscope/  <- the skills/ folders of github.com/modelscope/modelscope-skills
//
// Sources: when running inside the swift checkout (web-ui-v5/webui with ../../skills present)
// the local folder is copied directly — instant and reflects uncommitted edits. Otherwise the
// swift repo is cloned (shallow, at SWIFT_SKILLS_REF when given) and its skills/ copied; that
// is the publish path for the standalone webui repo. modelscope-skills is always cloned
// (MODELSCOPE_SKILLS_REF overrides the default branch). A failed clone fails the script:
// a release bundle silently missing its skills is worse than no release.
import { cpSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const webuiRoot = dirname(fileURLToPath(import.meta.url));
const target = join(webuiRoot, '..', 'public', 'skills');
const localSwiftSkills = join(webuiRoot, '..', '..', '..', 'skills');
const SWIFT_REPO_URL = process.env.SWIFT_SKILLS_REPO || 'https://github.com/modelscope/ms-swift';
const MS_SKILLS_URL = process.env.MODELSCOPE_SKILLS_REPO || 'https://github.com/modelscope/modelscope-skills';

/** Shallow-clone `url` (optionally at `ref`) into a fresh temp dir; returns the checkout path. */
function shallowClone(url, label, ref) {
  const dir = mkdtempSync(join(tmpdir(), `webui-skills-${label}-`));
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(url, dir);
  const done = spawnSync('git', args, { stdio: 'inherit' });
  if (done.status !== 0) {
    console.error(`[fetch-skills] git clone failed for ${url}${ref ? `@${ref}` : ''}`);
    process.exit(1);
  }
  return dir;
}

/** Copy `src` -> `dst`, skipping VCS and cache dirs. */
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, {
    recursive: true,
    filter: (p) => !(p.includes(`${sep}.git`) || p.includes(`${sep}__pycache__`)),
  });
}

function fetchSwiftSkills() {
  const dst = join(target, 'swift');
  if (existsSync(join(localSwiftSkills, 'swift-usage', 'SKILL.md'))) {
    console.log('[fetch-skills] swift skills: local checkout (../../skills)');
    copyTree(localSwiftSkills, dst);
    return;
  }
  const ref = process.env.SWIFT_SKILLS_REF;
  console.log(`[fetch-skills] swift skills: cloning ${SWIFT_REPO_URL}${ref ? `@${ref}` : ''}`);
  const checkout = shallowClone(SWIFT_REPO_URL, 'swift', ref);
  if (!existsSync(join(checkout, 'skills'))) {
    console.error('[fetch-skills] cloned swift repo has no skills/ directory');
    process.exit(1);
  }
  copyTree(join(checkout, 'skills'), dst);
}

function fetchModelscopeSkills() {
  const dst = join(target, 'modelscope');
  const ref = process.env.MODELSCOPE_SKILLS_REF;
  console.log(`[fetch-skills] modelscope-skills: cloning ${MS_SKILLS_URL}${ref ? `@${ref}` : ''}`);
  const checkout = shallowClone(MS_SKILLS_URL, 'ms-skills', ref);
  const src = join(checkout, 'skills');
  if (!existsSync(src)) {
    console.error('[fetch-skills] cloned modelscope-skills repo has no skills/ directory');
    process.exit(1);
  }
  copyTree(src, dst);
}

rmSync(target, { recursive: true, force: true });
fetchSwiftSkills();
fetchModelscopeSkills();
console.log(`[fetch-skills] bundled into ${target}`);
