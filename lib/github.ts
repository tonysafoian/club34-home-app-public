import { Octokit } from '@octokit/rest';

/**
 * Standard GitHub Octokit client using GITHUB_TOKEN or GH_TOKEN environment variable.
 */
export async function getUncachableGitHubClient(): Promise<Octokit> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GitHub token not configured. Set GITHUB_TOKEN or GH_TOKEN environment variable.');
  }
  return new Octokit({ auth: token });
}
