import { getUncachableGitHubClient } from "../../../lib/github.js";
import { RequestError } from "@octokit/request-error";
import { randomBytes } from "crypto";

const REPO_OWNER = process.env.GITHUB_REPO_OWNER ?? "owner";
const REPO_NAME = process.env.GITHUB_REPO_NAME ?? "janus-home-app-public";
const DEFAULT_BRANCH = process.env.GITHUB_DEFAULT_BRANCH ?? "main";

const MAX_PATH_LENGTH = 500;

type OctokitDirEntry = { type: string; path: string };

export async function executeReadCodebase(paths: string[]): Promise<string> {
  if (!paths || paths.length === 0) return "TOOL_ERROR: At least one path is required.";

  try {
    const octokit = await getUncachableGitHubClient();
    const results: string[] = [];

    for (const rawPath of paths) {
      const filePath = rawPath.trim();
      if (!filePath || filePath.length > MAX_PATH_LENGTH) {
        results.push(`--- (skipped) ---\nInvalid path: empty or exceeds ${MAX_PATH_LENGTH} characters.`);
        continue;
      }

      try {
        const { data } = await octokit.repos.getContent({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: filePath,
          ref: DEFAULT_BRANCH,
        });

        if (Array.isArray(data)) {
          const entries = (data as OctokitDirEntry[])
            .map((entry) => `${entry.type === "dir" ? "[dir]" : "[file]"} ${entry.path}`)
            .join("\n");
          results.push(`--- Directory: ${filePath} ---\n${entries}`);
        } else if ("content" in data && data.encoding === "base64") {
          const content = Buffer.from(data.content, "base64").toString("utf8");
          const lines = content.split("\n");
          const truncated =
            lines.length > 300
              ? lines.slice(0, 300).join("\n") + `\n[...truncated at 300 lines of ${lines.length} total]`
              : content;
          results.push(`--- File: ${filePath} (${data.size} bytes, ${lines.length} lines) ---\n${truncated}`);
        } else {
          results.push(`--- ${filePath} ---\nUnable to read content (not a text file or unrecognized format)`);
        }
      } catch (err) {
        if (err instanceof RequestError && err.status === 404) {
          results.push(`--- ${filePath} ---\nFile not found in repo.`);
        } else if (err instanceof Error) {
          results.push(`--- ${filePath} ---\nError: ${err.message}`);
        } else {
          results.push(`--- ${filePath} ---\nUnknown error reading file.`);
        }
      }
    }

    return results.join("\n\n");
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function executeProposeCodeFix(
  filePath: string,
  newContent: string,
  commitMessage: string,
  prTitle: string,
  prBody: string,
): Promise<string> {
  const trimmedPath = filePath?.trim();
  if (!trimmedPath || trimmedPath.length > MAX_PATH_LENGTH) {
    return `TOOL_ERROR: file_path must be non-empty and at most ${MAX_PATH_LENGTH} characters.`;
  }
  if (!newContent) return "TOOL_ERROR: new_content must be non-empty.";
  if (!commitMessage?.trim()) return "TOOL_ERROR: commit_message must be non-empty.";
  if (!prTitle?.trim()) return "TOOL_ERROR: pr_title must be non-empty.";

  try {
    const octokit = await getUncachableGitHubClient();

    const { data: refData } = await octokit.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${DEFAULT_BRANCH}`,
    });
    const baseSha = refData.object.sha;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const suffix = randomBytes(3).toString("hex");
    const branchName = `janus/fix-${timestamp}-${suffix}`;

    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    let existingFileSha: string | undefined;
    try {
      const { data: existing } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: trimmedPath,
        ref: DEFAULT_BRANCH,
      });
      if (!Array.isArray(existing) && "sha" in existing) {
        existingFileSha = existing.sha;
      }
    } catch (err) {
      if (!(err instanceof RequestError && err.status === 404)) {
        throw err;
      }
    }

    const encodedContent = Buffer.from(newContent, "utf8").toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: trimmedPath,
      message: commitMessage.trim(),
      content: encodedContent,
      branch: branchName,
      ...(existingFileSha ? { sha: existingFileSha } : {}),
    });

    const { data: pr } = await octokit.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: prTitle.trim(),
      body: `${prBody ?? ""}\n\n---\n*Proposed by Janus. Review before merging.*`,
      head: branchName,
      base: DEFAULT_BRANCH,
    });

    return `✅ PR created: ${pr.html_url}\n\nBranch: \`${branchName}\`\nFile changed: \`${trimmedPath}\`\n\nReview and merge when ready — Janus never pushes directly to main.`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}
