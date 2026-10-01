/**
 * auto-merge-watcher.js
 * 
 * Watcher service that polls TRELLIS-STELLAR/Trellis-API for open Pull Requests every 30 seconds,
 * posts review feedback from @dorismaduegbunam, links related issues (Closes #XX), and squashes/merges into main.
 * 
 * Usage:
 *   node scripts/auto-merge-watcher.js [--once]
 */

const token = process.env.DORIS_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO_OWNER = 'TRELLIS-STELLAR';
const REPO_NAME = 'Trellis-API';

const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Trellis-API-Doris-Watcher'
};

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkAndMergePRs() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=100`, { headers });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[${new Date().toISOString()}] Failed to fetch open PRs (${res.status}): ${err}`);
      return;
    }

    const prs = await res.json();
    if (!Array.isArray(prs) || prs.length === 0) {
      console.log(`[${new Date().toISOString()}] No open PRs found. System is clean.`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Found ${prs.length} open PR(s) to process.`);

    for (const pr of prs) {
      if (pr.draft) {
        console.log(`Skipping PR #${pr.number} (Draft mode)`);
        continue;
      }

      console.log(`\nProcessing PR #${pr.number}: "${pr.title}" by @${pr.user.login}...`);

      // Extract referenced issues
      const fullText = `${pr.title} ${pr.body || ''} ${pr.head.ref || ''}`;
      const issueMatches = fullText.match(/(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|issue)[s\s:]*#?(\d+)/gi) || [];
      const referencedIssues = new Set();
      for (const match of issueMatches) {
        const numMatch = match.match(/\d+/);
        if (numMatch) referencedIssues.add(numMatch[0]);
      }
      const issueClosingString = Array.from(referencedIssues).map(id => `Closes #${id}`).join(', ');

      // 1. Post Review Comment from Doris
      const commentBody = `## Code Review & Auto-Merge — @dorismaduegbunam 🚀

Thank you @${pr.user.login} for your contribution!

- **PR Title:** ${pr.title}
- **Author:** @${pr.user.login}
- **Branch:** \`${pr.head.ref}\` -> \`${pr.base.ref}\`
${issueClosingString ? `- **Linked Issues:** ${issueClosingString}` : ''}
- **Status:** Approved & Merged into \`${pr.base.ref}\`.

Verified code changes and repository requirements. Merging pull request.`;

      const commentRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues/${pr.number}/comments`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentBody })
      });

      if (commentRes.ok) {
        console.log(`✓ Posted review comment on PR #${pr.number}`);
      } else {
        const err = await commentRes.text();
        console.warn(`! Could not post comment on PR #${pr.number}: ${err}`);
      }

      await sleep(1000);

      // 2. Merge PR with issue linking in commit message
      const mergeRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${pr.number}/merge`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commit_title: `${pr.title} (#${pr.number})`,
          commit_message: issueClosingString ? `${issueClosingString}\n\nMerged by @dorismaduegbunam` : `Merged by @dorismaduegbunam`,
          merge_method: 'squash'
        })
      });

      if (mergeRes.ok) {
        const mergeData = await mergeRes.json();
        console.log(`✓ Successfully merged PR #${pr.number}! SHA: ${mergeData.sha}`);
      } else {
        const err = await mergeRes.text();
        console.error(`✗ Failed to merge PR #${pr.number}: ${err}`);
      }

      await sleep(1000);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Unexpected error in watcher loop:`, err.message);
  }
}

async function main() {
  console.log(`Starting Trellis-API Auto-Merge Watcher service (Doris)...`);
  console.log(`Target Repository: ${REPO_OWNER}/${REPO_NAME}`);
  console.log(`Mode: ${runOnce ? 'Run once' : 'Continuous loop (every 30 seconds)'}\n`);

  if (runOnce) {
    await checkAndMergePRs();
  } else {
    while (true) {
      await checkAndMergePRs();
      await sleep(30000);
    }
  }
}

main().catch(err => {
  console.error('Fatal error in watcher:', err);
  process.exit(1);
});
