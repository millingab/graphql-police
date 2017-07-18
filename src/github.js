// @flow

import GitHubApi from 'github';
import { version } from '../package.json';

import type { GhCommit } from './TypeDefinition';

const fs = require('fs');
const jwt = require('jsonwebtoken');
const appId = 3670;
const cert = fs.readFileSync('graphql-police.2017-07-18.private-key.pem');

const gh = new GitHubApi({
  debug: true,
  protocol: 'https',
  host: 'api.github.com',
  headers: {
    'User-Agent':
      `millingab/GraphQL-police (+https://github.com/millingab/graphql-police)`,
  },
  followRedirects: false,
  timeout: 5000,
});

export const authenticateGithubApp = async (id: string) => {
  const jwt_token = jwt.sign({ iss: appId },
    cert, {
      algorithm: 'RS256',
      expiresIn: '5m'
    });

  gh.authenticate({
    type: 'integration',
    token: jwt_token,
  });

  const result = await gh.integrations.createInstallationToken({installation_id: id});
  
  gh.authenticate({
    type: 'token',
    token: result.data.token,
  });
};

export const getLoggedUser = async () => {
  gh.users.get({});
};

export const findThisBotComment = async (
  owner: string,
  repo: string,
  pullRequestNumber: number,
  currentPage: ?number = 1,
) => {
  const result = await gh.issues.getComments({
    owner,
    repo,
    number: pullRequestNumber,
    per_page: 50,
    page: currentPage,
  });

  const comments = result.data;

  let found = comments.find(comment => comment.user.login === 'graphql-police[bot]');

  if (!found && gh.hasNextPage(result)) {
    found = await findThisBotComment(owner, repo, pullRequestNumber, currentPage + 1);
  }

  return found;
};

export const getFileContent = async (owner: string, repo: string, path: string, ref: string) =>
  gh.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });

export const getFilesFromCommit = async (owner: string, repo: string, sha: string) => {
  const { data }: { data: GhCommit } = await gh.repos.getCommit({
    owner,
    repo,
    sha,
  });

  return data.files;
};

export const updateComment = async (owner: string, repo: string, id: string, body: string) =>
  gh.issues.editComment({
    owner,
    repo,
    id,
    body,
  });

export const createComment = async (owner: string, repo: string, pullRequestNumber: string, body: string) =>
  gh.issues.createComment({
    owner,
    repo,
    number: pullRequestNumber,
    body,
  });
