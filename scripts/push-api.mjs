/**
 * 用 GitHub Git Data API 推送本地提交（github.com 被墙时 git push 走不通）。
 * 只推送 git 已跟踪的文件（尊重 .gitignore，core/ 与 node_modules 不会上传）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PAT = process.env.GH_PAT;
const OWNER = process.env.GH_OWNER || 'Spark-Matt';
const REPO = process.env.GH_REPO || 'dsh-free-deepseek';
const BRANCH = process.env.GH_BRANCH || 'main';
const ROOT = process.env.GH_ROOT;

const API = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${PAT}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'dsh-free-deepseek-publisher',
};

async function call(method, url, body) {
  const res = await fetch(API + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

console.log(`待推送文件 ${files.length} 个`);

// 1. 建 blob
const tree = [];
for (const rel of files) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const isBinary = buf.includes(0);
  const blob = await call('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
    content: isBinary ? buf.toString('base64') : buf.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf8',
  });
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  process.stdout.write('.');
}
console.log('');

// 2. 父提交
let parentSha = null;
try {
  const ref = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  parentSha = ref.object.sha;
} catch {
  console.log('分支还不存在，创建首个提交');
}

// 3. tree + commit
const treeRes = await call('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree });
const message = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = await call('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: treeRes.sha,
  ...(parentSha ? { parents: [parentSha] } : {}),
});

// 4. 更新 ref
if (parentSha) {
  await call('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
} else {
  await call('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
}

console.log(`✅ 已推送 ${commit.sha.slice(0, 7)} 到 ${OWNER}/${REPO}@${BRANCH}`);
